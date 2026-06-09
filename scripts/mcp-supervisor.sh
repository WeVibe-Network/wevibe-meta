#!/usr/bin/env bash
set -euo pipefail

LABEL="network.wevibe.dashboard-mcp"
PORT="4451"
HEALTH_URL="http://localhost:${PORT}/health"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEVIBE_META_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="$(cd "${WEVIBE_META_DIR}/.." && pwd)"

TEMPLATE_PATH="${WEVIBE_META_DIR}/launchd/${LABEL}.plist.template"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${WEVIBE_META_DIR}/.logs"

DOMAIN="gui/$(id -u)"
SERVICE_TARGET="${DOMAIN}/${LABEL}"

usage() {
  echo "Usage: $0 {up|down|restart|status}" >&2
  exit 1
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\/&]/\\&/g'
}

require_node_bin() {
  local node_bin
  node_bin="$(command -v node || true)"
  if [[ -z "${node_bin}" ]]; then
    echo "ERROR: node was not found in PATH. Install Node.js or fix PATH, then retry." >&2
    exit 1
  fi
  printf '%s' "${node_bin}"
}

free_port_listener() {
  local pids
  pids="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  if [[ -z "${pids}" ]]; then
    echo "tcp:${PORT} is already free."
    return 0
  fi

  echo "Freeing tcp:${PORT}; terminating PID(s): ${pids}"
  kill ${pids} 2>/dev/null || true
  sleep 1

  local remaining
  remaining="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  if [[ -n "${remaining}" ]]; then
    echo "Force-killing remaining PID(s) on tcp:${PORT}: ${remaining}"
    kill -9 ${remaining} 2>/dev/null || true
  fi
}

generate_plist() {
  if [[ ! -f "${TEMPLATE_PATH}" ]]; then
    echo "ERROR: launchd template not found: ${TEMPLATE_PATH}" >&2
    exit 1
  fi

  local node_bin
  node_bin="$(require_node_bin)"

  mkdir -p "${LOG_DIR}" "${LAUNCH_AGENTS_DIR}"

  local escaped_node
  local escaped_workspace
  escaped_node="$(escape_sed_replacement "${node_bin}")"
  escaped_workspace="$(escape_sed_replacement "${WORKSPACE_ROOT}")"

  sed \
    -e "s/__NODE_BIN__/${escaped_node}/g" \
    -e "s/__WORKSPACE_ROOT__/${escaped_workspace}/g" \
    "${TEMPLATE_PATH}" > "${PLIST_PATH}"

  chmod 644 "${PLIST_PATH}"

  echo "Generated launchd plist: ${PLIST_PATH}"
  echo "Resolved node binary: ${node_bin}"
  echo "Resolved workspace root: ${WORKSPACE_ROOT}"
}

load_with_launchctl() {
  launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true

  local bootstrap_err
  bootstrap_err="$(mktemp)"

  if launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}" 2>"${bootstrap_err}"; then
    rm -f "${bootstrap_err}"
    return 0
  fi

  local bootstrap_output
  bootstrap_output="$(<"${bootstrap_err}")"
  rm -f "${bootstrap_err}"

  echo "launchctl bootstrap failed, trying legacy unload/load fallback..." >&2
  if [[ -n "${bootstrap_output}" ]]; then
    echo "bootstrap error: ${bootstrap_output}" >&2
  fi

  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  launchctl load "${PLIST_PATH}"
}

wait_for_health() {
  local waited=0
  while (( waited < 30 )); do
    local payload
    payload="$(curl -s --max-time 2 "${HEALTH_URL}" || true)"
    if [[ "${payload}" == *'"status":"ok"'* ]]; then
      echo "Health OK: ${payload}"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "ERROR: ${HEALTH_URL} did not report healthy within 30 seconds." >&2
  local final_payload
  final_payload="$(curl -s --max-time 2 "${HEALTH_URL}" || true)"
  if [[ -n "${final_payload}" ]]; then
    echo "Last health payload: ${final_payload}" >&2
  fi
  return 1
}

cmd_up() {
  free_port_listener
  generate_plist
  load_with_launchctl
  wait_for_health
}

cmd_down() {
  if launchctl bootout "${SERVICE_TARGET}" 2>/dev/null; then
    echo "Stopped ${SERVICE_TARGET} via bootout."
  else
    echo "bootout unavailable/failed; trying launchctl unload ${PLIST_PATH}."
    launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  fi

  local waited=0
  while (( waited < 10 )); do
    local pids
    pids="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
    if [[ -z "${pids}" ]]; then
      echo "Confirmed: tcp:${PORT} is not listening."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  local remaining
  remaining="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  echo "ERROR: tcp:${PORT} still has listener PID(s): ${remaining}" >&2
  return 1
}

cmd_status() {
  echo "Label: ${LABEL}"
  if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    echo "launchctl: loaded"
  else
    echo "launchctl: not loaded"
  fi

  local pids
  pids="$(lsof -ti tcp:${PORT} -sTCP:LISTEN || true)"
  if [[ -n "${pids}" ]]; then
    echo "tcp:${PORT}: listening (PID(s): ${pids})"
  else
    echo "tcp:${PORT}: not listening"
  fi

  local payload
  payload="$(curl -s --max-time 2 "${HEALTH_URL}" || true)"
  if [[ -n "${payload}" ]]; then
    echo "/health: ${payload}"
  else
    echo "/health: unavailable"
  fi
}

if [[ $# -ne 1 ]]; then
  usage
fi

case "$1" in
  up)
    cmd_up
    ;;
  down)
    cmd_down
    ;;
  restart)
    cmd_down
    cmd_up
    ;;
  status)
    cmd_status
    ;;
  *)
    usage
    ;;
esac
