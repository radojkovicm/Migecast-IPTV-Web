# Validation

Unit tests: `pnpm test`. Type checks: `pnpm db:generate && pnpm type-check`.
Release tests: `pnpm test:release`. Demo tests: `pnpm demo:build && pnpm demo:test`.

Media tests require FFmpeg/ffprobe: `pnpm test:worker`.
Full integration tests also require PostgreSQL 17 binaries and Chromium:

```sh
pnpm exec playwright install chromium
TEST_PG_BIN="$(pg_config --bindir)" pnpm test:integration
```

The integration harness creates a disposable local database, generated test
credentials and fixture streams. It does not use a production database.
Its results do not guarantee that an arbitrary provider or physical device works.
A public channel can become unavailable after a successful playback check.

Before publishing, scan the exact Git index and complete new repository history
for secrets and private identifiers. Review commit metadata, images, archives,
Actions output and artifacts. A clean current tree does not sanitize old history.
The public repository must not inherit private deployment workflows or credentials.

The public catalog parser tests cover countries, stable IDs, deduplication,
unsupported links and removal of sensitive/local destinations. Browser tests
cover country/search filters, continuous scrolling and external-source behavior.
