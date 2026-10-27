#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 1 && "$1" == "--once" ]] || {
  printf '%s\n' "Uso: supervise-worker.sh --once" >&2
  exit 64
}
[[ "$(id -u)" -ne 0 ]] || {
  printf '%s\n' "Worker root recusado." >&2
  exit 78
}
: "${JARVIS_WORKER_STATE_DIR:?Defina um diretorio privado e persistente.}"
[[ "$JARVIS_WORKER_STATE_DIR" = /* ]] || {
  printf '%s\n' "Diretorio precisa ser absoluto." >&2
  exit 78
}
[[ ! -L "$JARVIS_WORKER_STATE_DIR" ]] || exit 78
mkdir -p -- "$JARVIS_WORKER_STATE_DIR"
[[ -d "$JARVIS_WORKER_STATE_DIR" ]] || exit 78
[[ "$(stat -c '%u' -- "$JARVIS_WORKER_STATE_DIR")" == "$(id -u)" ]] || exit 78
chmod 0700 -- "$JARVIS_WORKER_STATE_DIR"
command -v flock >/dev/null || exit 78
command -v node >/dev/null || exit 78

[[ ! -L "${JARVIS_WORKER_STATE_DIR}/worker.lock" ]] || exit 78
exec 9>"${JARVIS_WORKER_STATE_DIR}/worker.lock"
flock -n -x 9 || {
  printf '%s\n' "Ja existe worker ativo nesta identidade." >&2
  exit 73
}

id_file="${JARVIS_WORKER_STATE_DIR}/worker-id"
if [[ -L "$id_file" ]]; then exit 78; fi
if [[ ! -e "$id_file" ]]; then
  id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  printf '%s\n' "$id" > "$id_file"
  chmod 0600 -- "$id_file"
fi
[[ -f "$id_file" && "$(stat -c '%u' -- "$id_file")" == "$(id -u)" ]] || exit 78
export JARVIS_WORKER_ID
JARVIS_WORKER_ID="$(cat -- "$id_file")"
[[ "$JARVIS_WORKER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 78
export JARVIS_FLOCK_HELD=1
base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${base}/worker/phase11-cli.cjs" --once
