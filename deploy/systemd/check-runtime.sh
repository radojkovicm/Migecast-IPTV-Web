#!/bin/sh
# Verify that the reviewed manifest covers exactly the three executed binaries.
set -eu
runtime=${1:-/opt/migecast-worker/runtime}
case "$runtime" in /*) ;; *) echo 'Runtime path must be absolute.' >&2; exit 1 ;; esac
manifest="$runtime/runtime.sha256"
awk -v root="$runtime" '
BEGIN { expected[root "/bin/node"] = 1; expected[root "/bin/ffmpeg"] = 1; expected[root "/bin/ffprobe"] = 1 }
{
  if (NF != 2 || length($1) != 64 || $1 ~ /[^[:xdigit:]]/ || !($2 in expected) || seen[$2]++) exit 1
  count++
}
END { if (count != 3) exit 1 }
' "$manifest" || { echo 'Runtime manifest must contain exactly Node, FFmpeg and ffprobe hashes.' >&2; exit 1; }
exec /usr/bin/sha256sum --strict --check "$manifest"
