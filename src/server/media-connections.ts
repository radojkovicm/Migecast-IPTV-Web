// Immediate local teardown supplements the database lease check across processes.
const state = globalThis as unknown as {
	mediaConnections?: Map<string, Set<() => void>>;
};
if (!state.mediaConnections) state.mediaConnections = new Map();
const connections = state.mediaConnections;
export function registerMedia(id: string, abort: () => void) {
	const entries = connections.get(id) ?? new Set();
	entries.add(abort);
	connections.set(id, entries);
	return () => {
		entries.delete(abort);
		if (!entries.size) connections.delete(id);
	};
}
export function abortMedia(id: string) {
	for (const abort of connections.get(id) ?? []) abort();
	connections.delete(id);
}
