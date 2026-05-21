#!/usr/bin/env bash
# WeVibe Network — Stop All Services
set -euo pipefail

WEVIBE_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$WEVIBE_ROOT/.." && pwd)"
PID_DIR="$WEVIBE_ROOT/.pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[wevibe]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

stop_pid() {
  local name="$1" pidfile="$PID_DIR/$2"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      local waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 5 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
        warn "$name force-killed (PID $pid)"
      else
        ok "$name stopped (PID $pid)"
      fi
    else
      ok "$name already stopped"
    fi
    rm -f "$pidfile"
  else
    ok "$name — no PID file"
  fi
}

echo -e "${BLUE}Stopping WeVibe Network services...${NC}"
echo ""

stop_pid "wevibe-dashboard" "dashboard.pid"
stop_pid "wevibe-mcp" "mcp.pid"
stop_pid "wevibe-hub" "hub.pid"
stop_pid "wevibe-chain" "chain.pid"

(cd "$WORKSPACE_ROOT/wevibe-server" && docker compose stop wevibe-hub) 2>/dev/null || true
(cd "$WORKSPACE_ROOT/wevibe-server" && docker compose rm -f wevibe-hub) 2>/dev/null || true
(cd "$WORKSPACE_ROOT/wevibe-server" && docker compose stop) 2>/dev/null || true
ok "Docker containers stopped (volumes preserved)"

for pattern in "wevibe-hub" "wevibed start"; do
  local_pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$local_pids" ]; then
    echo "$local_pids" | xargs kill 2>/dev/null || true
    warn "Killed orphaned process(es) matching '$pattern'"
  fi
done

echo ""
echo -e "${GREEN}All WeVibe services stopped.${NC}"
