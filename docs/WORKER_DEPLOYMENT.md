# Media worker

Install FFmpeg and ffprobe; the implementation supports the FFmpeg 4.4 generation
and detects the appropriate HLS segment option. Run `pnpm worker:build`.

For local testing, export MEDIA_WORKER_SECRET securely into the worker environment,
matching the application's secret, then run `pnpm worker:start`. The worker does
not read the application's .env file. Use FFMPEG_PATH and FFPROBE_PATH for explicit
binary locations. MEDIA_ALLOW_VIDEO_TRANSCODE defaults to 0 to avoid uncontrolled
CPU use. The gateway is authenticated and must remain on loopback.

For Linux deployment use the separate worker service template and dedicated user.
The template provides a 256 MiB private temporary filesystem, memory/process/CPU
limits and whole-cgroup cleanup. Install the reviewed runtime at the template's
paths or adjust them consistently. The worker rejects untrusted/private media
origins and stops idle jobs after 45 seconds without a heartbeat. Job directories
are removed on stop; a four-hour lifetime cap and size watchdog provide bounds.

Temporary media is not a permanent library. Database backups and host logs have
separate retention needs. The optional backup service/timer templates must be
reviewed and enabled explicitly; copying them does not schedule a backup.
