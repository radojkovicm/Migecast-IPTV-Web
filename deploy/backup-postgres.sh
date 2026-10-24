#!/usr/bin/env bash
# Manual host backup of the dedicated Migecast database only. Never sources secrets.
set -euo pipefail
umask 077
export LC_ALL=C
APP_DIR=${APP_DIR:-/opt/migecast-db}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/migecast}
KEEP=${KEEP:-14}
[[ "$APP_DIR" == /* && "$BACKUP_DIR" == /* ]] || exit 2
[[ "$KEEP" =~ ^[1-9][0-9]?$ ]] || { echo 'KEEP must be 1..99.' >&2; exit 2; }
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" && -O "$BACKUP_DIR" ]] || {
  echo 'Create a dedicated, operator-owned mode-0700 backup directory first.' >&2; exit 2;
}
[[ "$(stat -c %a "$BACKUP_DIR")" == 700 ]] || { echo 'Backup directory must be mode 0700.' >&2; exit 2; }
[[ ! -L "$BACKUP_DIR/.backup.lock" ]] || { echo 'Refusing symlinked backup lock.' >&2; exit 2; }
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo 'Another Migecast backup is running.' >&2; exit 1; }
compose=(docker compose --project-name migecast --env-file "$APP_DIR/compose.env" -f "$APP_DIR/docker-compose.prod.yml")
[[ "$("${compose[@]}" exec -T db sh -c 'printf "%s:%s" "$POSTGRES_DB" "$POSTGRES_USER"')" == migecast:migecast ]] || {
  echo 'Refusing unexpected database identity.' >&2; exit 1;
}
tmpfile=$(mktemp "$BACKUP_DIR/.migecast-partial.XXXXXX")
trap 'rm -f -- "$tmpfile"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Container-local socket; password is neither an argument nor included in the dump.
"${compose[@]}" exec -T db pg_dump --format=custom --no-owner --no-acl -U migecast -d migecast > "$tmpfile"
[[ -s "$tmpfile" ]] || { echo 'Empty backup.' >&2; exit 1; }
"${compose[@]}" exec -T db pg_restore --list < "$tmpfile" > /dev/null
outfile="$BACKUP_DIR/migecast-$(date -u +%Y%m%dT%H%M%SZ).dump"
[[ ! -e "$outfile" && ! -L "$outfile" ]] || { echo 'Backup filename collision.' >&2; exit 1; }
mv -- "$tmpfile" "$outfile"
# Rotate only regular, non-symlink, current-UID, exact-name, valid custom dumps.
# Foreign or invalid files are untouched. Directory must remain private to this UID.
shopt -s nullglob
candidates=("$BACKUP_DIR"/migecast-*.dump)
(( ${#candidates[@]} <= 1000 )) || { echo 'Backup saved; refusing rotation above 1000 candidates.' >&2; exit 1; }
valid=()
for file in "${candidates[@]}"; do
  [[ "${file##*/}" =~ ^migecast-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || continue
  [[ -f "$file" && ! -L "$file" && -O "$file" ]] || continue
  if "${compose[@]}" exec -T db pg_restore --list < "$file" > /dev/null 2>&1; then valid+=("$file"); fi
done
for ((i=0; i < ${#valid[@]} - KEEP; i++)); do rm -f -- "${valid[$i]}"; done
printf 'Migecast backup verified: %s\n' "$outfile"
