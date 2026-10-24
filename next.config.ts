import type { NextConfig } from "next";

const config: NextConfig = {
	output: "standalone",
	devIndicators: false,
	poweredByHeader: false,
	// The systemd release directory is read-only; keep route cache in RAM.
	cacheMaxMemorySize: 8 * 1024 * 1024,
	experimental: { isrFlushToDisk: false },
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "no-referrer" },
					{ key: "X-Frame-Options", value: "DENY" },
					{
						key: "Permissions-Policy",
						value: "camera=(), microphone=(), geolocation=()",
					},
				],
			},
		];
	},
};
export default config;
