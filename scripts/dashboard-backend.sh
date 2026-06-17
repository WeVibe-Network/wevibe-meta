#!/usr/bin/env bash
set -euo pipefail

# Dashboard moderation/decrypt backend supervisor (host on :4451).
#
# This is the host `node dist/dashboard-server.js` process that the dashboards
# call (in-browser) for moderation, decryption, and the leader-Verify
# `wevibe_embed_retrieval_card` tool (it holds the org mod key + PRE identity).
# It is managed by the launchd agent `network.wevibe.dashboard-mcp`
# (~/Library/LaunchAgents/...plist), which KeepAlive-respawns it. Because
# KeepAlive only respawns on EXIT, a long-lived agent keeps running STALE dist
# after a rebuild until the agent is restarted — and a plist env change only
# takes effect on a full reload (bootout+bootstrap). This wrapper makes both
# one command, mirroring contributor-dashboard.sh.
#
# NOTE: at boot dashboard-server.js loads the identity + mod key + org
# membership, which (a) may pop a Touch ID prompt — tap it ONCE when it appears —
# and (b) requires the org to already exist on the hub. If it FATALs with "no
# org membership found", create/recreate the org first (and after a stack wipe,
# re-pair once: `node dist/admin.js pair --code <code> --force true`).
#
# The plist must carry WEVIBE_UMBRAL_SIDECAR_BIN (umbral CLI, for Verify-time
# capsule encrypt + recall decrypt) and WEVIBE_GUARD_BIN. This wrapper verifies
# the umbral binary exists before (re)starting.
#
# Usage: dashboard-backend.sh {up|down|restart|status}

LABEL="network.wevibe.dashboard-mcp"
PORT="${WEVIBE_DASHBOARD_PORT:-4451}"
HOST="127.0.0.1"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEVIBE_META_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="$(cd "${WEVIBE_META_DIR}/.." && pwd)"
MCP_DIR="${WORKSPACE_ROOT}/wevibe-mcp"
ENTRY="${MCP_DIR}/dist/dashboard-server.js"
LOG_FILE="${WEVIBE_META_DIR}/.logs/dashboard-mcp.log"
HEALTH_URL="http://${HOST}:${PORT}/health"

# Umbral PRE CLI binary the plist references (sidecar.ts umbralEncrypt /
# umbralDecryptReencrypted). Default to the workspace release build.
UMBRAL_BIN="${WEVIBE_UMBRAL_SIDECAR_BIN:-${WORKSPACE_ROOT}/wevibe-umbral/target/release/wevibe-umbral}"

usage() {
  echo "Usage: $0 {up|down|restart|status}" >&2
  exit 1
}

preflight() {
  if [[ ! -f "${PLIST}" ]]; then
    echo "ERROR: launchd plist not found: ${PLIST}" >&2
    exit 1
  fi
  if [[ ! -f "${ENTRY}" ]]; then
    echo "ERROR: built backend not found: ${ENTRY}" >&2
    echo "Run 'npm run build' in ${MCP_DIR} first (or use 'make redeploy')." >&2
    exit 1
  fi
  if [[ ! -x "${UMBRAL_BIN}" ]]; then
    echo "ERROR: Umbral sidecar binary not found/executable: ${UMBRAL_BIN}" >&2
    echo "Build it: (cd ${WORKSPACE_ROOT}/wevibe-umbral && cargo build --release)" >&2
    echo "and ensure the plist's WEVIBE_UMBRAL_SIDECAR_BIN points to it." >&2
    exit 1
  fi
}

bootout_quiet() {
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
}

bootstrap_agent() {
  # Full reload: picks up plist env changes AND the freshly built dist.
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
}

wait_for_health() {
  # Boot loads identity + memberships and may pause on a Touch ID prompt.
  local waited=0
  while (( waited < 90 )); do
    if curl -s --max-time 3 -o /dev/null "${HEALTH_URL}"; then
      echo "Dashboard backend is up: ${HEALTH_URL}"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "ERROR: dashboard backend did not answer ${HEALTH_URL} within 90s." >&2
  echo "If a Touch ID prompt is waiting, tap it. Last 20 log lines (${LOG_FILE}):" >&2
  tail -n 20 "${LOG_FILE}" 2>/dev/null >&2 || true
  return 1
}

cmd_up() {
  preflight
  echo "Bootstrapping launchd agent ${LABEL} (:${PORT})..."
  echo "  umbral bin: ${UMBRAL_BIN}"
  echo "  (you may be prompted for Touch ID once to unlock the mod key)"
  bootstrap_agent || {
    echo "bootstrap failed (already loaded?); forcing reload..." >&2
    bootout_quiet
    sleep 1
    bootstrap_agent
  }
  wait_for_health
}

cmd_down() {
  echo "Booting out launchd agent ${LABEL}..."
  bootout_quiet
  sleep 1
  echo "Dashboard backend stopped (agent unloaded; KeepAlive will NOT respawn)."
}

cmd_restart() {
  preflight
  echo "Reloading launchd agent ${LABEL} (fresh dist + plist env)..."
  echo "  umbral bin: ${UMBRAL_BIN}"
  echo "  (you may be prompted for Touch ID once to unlock the mod key)"
  bootout_quiet
  sleep 1
  bootstrap_agent
  wait_for_health
}

cmd_status() {
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "launchd ${LABEL}: loaded"
    launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | grep -E "state =|pid =" | sed 's/^/  /' || true
  else
    echo "launchd ${LABEL}: NOT loaded"
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
  restart) cmd_restart ;;
  status)  cmd_status ;;
  *)       usage ;;
esac
