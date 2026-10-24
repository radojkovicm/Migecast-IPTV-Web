# Release bundles

`pnpm build` followed by `pnpm release:package` assembles an application/worker
bundle under build/releases. Run `pnpm release:verify <bundle-directory>` before
using it. Build on the same operating system and architecture as the target;
macOS native dependencies are not Linux deployment artifacts.

The bundle has no credentials, database snapshot or private deploy identity.
Provide runtime configuration separately. Review the generic deployment templates
and preserve the previous application release before switching versions.
Schema migrations require a verified backup and operator review.

The public demo is built separately with `pnpm demo:build`; upload only demo/dist
to a static host. Never upload the repository root or a runtime .env file.
