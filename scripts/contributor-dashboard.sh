#!/usr/bin/env bash
set -euo pipefail

# Contributor dashboard supervisor (host Next.js dev server on :3001).
#
# The leader dashboard runs in Docker on :3000; the CONTRIBUTOR dashboard runs
# on the host as `next dev -p 3001` so it can reach the host MCP (:4450). Its
# `.next` dev cache reliably corrupts whenever the stack is rebuilt
# (`make docker-down` / `make docker-up`) because the vendored WASM + build
# artifacts change underneath a running dev server. This supervisor makes the
# fix one command: stop the old :3001 process, WIPE the `.next` cache, and
# start a fresh dev server (detached, logged, port-health-waited).
#
# Usage: contributor-dashboard.sh {up|down|restart|status}

PORT="3001"
HOST="127.0.0.1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEVIBE_META_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="$(cd "${WEVIBE_META_DIR}/.." && pwd)"
DASHBOARD_DIR="${WORKSPACE_ROOT}/wevibe-server/wevibe-dashboard"

LOG_DIR="${WEVIBE_META_DIR}/.logs"
LOG_FILE="${LOG_DIR}/contributor-dashboard.log"
PID_FILE="${LOG_DIR}/contributor-dashboard.pid"
HEALTH_URL="http://${HOST}:${PORT}"

usage() {
  echo "Usage: $0 {up|down|restart|status}" >&2
  exit 1
}

free_port_listener() {
  local pids
  pids="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  if [[ -z "${pids}" ]]; then
    echo "tcp:${PORT} is already free."
    return 0
  fi
  echo "Stopping existing :${PORT} process(es): ${pids}"
  kill ${pids} 2>/dev/null || true
  sleep 1
  local remaining
  remaining="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  if [[ -n "${remaining}" ]]; then
    echo "Force-killing remaining PID(s) on tcp:${PORT}: ${remaining}"
    kill -9 ${remaining} 2>/dev/null || true
    sleep 1
  fi
}

clean_cache() {
  if [[ -d "${DASHBOARD_DIR}/.next" ]]; then
    echo "Clearing corrupted dev cache: ${DASHBOARD_DIR}/.next"
    rm -rf "${DASHBOARD_DIR}/.next"
  else
    echo "No .next cache to clear."
  fi
  # node's transform cache occasionally wedges too; cheap to clear.
  rm -rf "${DASHBOARD_DIR}/node_modules/.cache" 2>/dev/null || true
}

wait_for_listen() {
  local waited=0
  while (( waited < 60 )); do
    if lsof -ti tcp:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
      # Port is bound; give Next a beat then confirm it answers HTTP.
      if curl -s --max-time 3 -o /dev/null "${HEALTH_URL}"; then
        echo "Contributor dashboard is up: ${HEALTH_URL}"
        return 0
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "ERROR: contributor dashboard did not come up on ${HEALTH_URL} within 60s." >&2
  echo "Last 20 log lines (${LOG_FILE}):" >&2
  tail -n 20 "${LOG_FILE}" 2>/dev/null >&2 || true
  return 1
}

cmd_up() {
  mkdir -p "${LOG_DIR}"
  if [[ ! -d "${DASHBOARD_DIR}" ]]; then
    echo "ERROR: dashboard dir not found: ${DASHBOARD_DIR}" >&2
    exit 1
  fi
  free_port_listener
  clean_cache
  echo "Starting contributor dashboard (next dev -p ${PORT} -H ${HOST})..."
  (
    cd "${DASHBOARD_DIR}"
    nohup npx next dev -p "${PORT}" -H "${HOST}" > "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"
  )
  echo "PID $(cat "${PID_FILE}" 2>/dev/null || echo '?') — logs: ${LOG_FILE}"
  wait_for_listen
}

cmd_down() {
  free_port_listener
  rm -f "${PID_FILE}"
  echo "Contributor dashboard stopped."
}

cmd_status() {
  local pids
  pids="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  if [[ -n "${pids}" ]]; then
    echo "tcp:${PORT}: listening (PID(s): ${pids})"
  else
    echo "tcp:${PORT}: not listening"
  fi
  if curl -s --max-time 3 -o /dev/null "${HEALTH_URL}"; then
    echo "${HEALTH_URL}: responding"
  else
    echo "${HEALTH_URL}: unavailable"
  fi
  echo "Log: ${LOG_FILE}"
}

if [[ $# -ne 1 ]]; then
  usage
fi

case "$1" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  restart) cmd_down; cmd_up ;;
  status)  cmd_status ;;
  *)       usage ;;
esac
