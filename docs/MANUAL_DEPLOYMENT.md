# Self-hosting

The application requires Node.js 22.12+, pnpm 10.28.2, PostgreSQL 17 and a separate
FFmpeg/ffprobe worker. Use a dedicated database and independent generated secrets.

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Copy `.env.example` to `.env` locally and replace all placeholders. Generate
   separate random values for BETTER_AUTH_SECRET and MEDIA_WORKER_SECRET (at least
   32 characters), and 32 random bytes encoded as 64 hex characters for
   PLAYLIST_ENCRYPTION_KEY. Never upload this file.
3. Set DATABASE_URL to your dedicated PostgreSQL database. Run
   `pnpm db:generate` and `pnpm db:deploy`.
4. Supply ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD through a secure local
   environment, then run `pnpm admin:create`. Provisioning refuses an initialized
   database. Remove provisioning variables after use. Sign in and enroll MFA.
5. For local development run `pnpm dev`, then open http://localhost:3100.
   For a release run `pnpm build` and `pnpm start`.
6. Start the separate media worker using the worker guide. Set MEDIA_WORKER_URL
   and the matching MEDIA_WORKER_SECRET in the application environment.
7. Use the generic `deploy/systemd` and nginx examples as reviewed templates for
   your own host. Choose ports and domain, install TLS, set root-owned environment
   files to mode 0600 and keep both services on loopback. Do not expose the worker.
8. In owner settings, add a source and assign it to a user. Multiple lists can be
   saved; each user has one active source. Registration is closed.

Keep PLAYLIST_ENCRYPTION_KEY backed up separately from the database; losing it
makes saved provider credentials unreadable. Verify database backup restoration
before relying on it. No production credentials or deployment service are shipped.

The static Pages/Vercel demo is independent. Serverless functions do not replace
the long-running FFmpeg worker required by the complete application.
