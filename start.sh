#!/usr/bin/env bash
# WeVibe Network — Start All Services (idempotent)
# Usage: ./start.sh [--skip-chain] [--skip-dashboard]
set -euo pipefail

WEVIBE_ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$WEVIBE_ROOT/.pids"
LOG_DIR="$WEVIBE_ROOT/.logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[wevibe]${NC} $*"; }
ok()    { echo -e "${GREEN}[  ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
fail()  { echo -e "${RED}[fail]${NC} $*"; }

SKIP_CHAIN=false
SKIP_DASHBOARD=false
for arg in "$@"; do
  case "$arg" in
    --skip-chain)     SKIP_CHAIN=true ;;
    --skip-dashboard) SKIP_DASHBOARD=true ;;
  esac
done

wait_for() {
  local name="$1" url="$2" max_wait="${3:-30}"
  info "Waiting for $name..."
  local elapsed=0
  while ! curl -sf "$url" > /dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$max_wait" ]; then
      fail "$name did not become healthy after ${max_wait}s"
      return 1
    fi
  done
  ok "$name healthy (${elapsed}s)"
}

detect_chain_corruption() {
  if [ -f "$LOG_DIR/chain.log" ] && grep -q "error loading last version\|failed to load store: version does not exist" "$LOG_DIR/chain.log" 2>/dev/null; then
    return 0
  fi
  return 1
}

mitigate_chain_corruption() {
  warn "Chain state corruption detected — resetting and re-initializing..."
  kill_pid "$PID_DIR/chain.pid" 2>/dev/null || true
  pkill -f "wevibed start" 2>/dev/null || true
  sleep 2
  rm -rf "$CHAIN_HOME" 2>/dev/null || true
  info "Chain state reset complete"
}

wait_for_pg() {
  local max_wait="${1:-30}"
  info "Waiting for PostgreSQL..."
  local elapsed=0
  while ! pg_isready -h localhost -p 5433 -q 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$max_wait" ]; then
      fail "PostgreSQL did not become ready after ${max_wait}s"
      return 1
    fi
  done
  ok "PostgreSQL ready (${elapsed}s)"
}

kill_pid() {
  local pidfile="$1"
  [ ! -f "$pidfile" ] && return 0
  local pid
  pid=$(cat "$pidfile")
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 5 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

info "Starting WeVibe Network services..."
echo ""

if ! docker info &>/dev/null; then
  fail "Docker is not running — start Docker Desktop first"
  exit 1
fi

cd "$WEVIBE_ROOT"

docker compose -f wevibe-server/docker-compose.yml rm -f hub 2>/dev/null || true
docker compose -f wevibe-server/docker-compose.yml up -d --wait postgres qdrant 2>&1 | grep -v -E "(Conflict|already in use|stopping)" | grep -v "^$" || true
ok "Docker services started (postgres, qdrant)"

wait_for_pg 30
wait_for "Qdrant" "http://localhost:6333/healthz" 30

if [ "$SKIP_CHAIN" = false ]; then
  info "Starting wevibe-chain..."
  CHAIN_DIR="$WEVIBE_ROOT/wevibe-chain"
  CHAIN_HOME="$HOME/.wevibed"

  kill_pid "$PID_DIR/chain.pid"
  pkill -f "wevibed start.*$CHAIN_HOME" 2>/dev/null || true

  if [ ! -f "$CHAIN_HOME/config/genesis.json" ]; then
    info "Initializing chain (first run)..."
    if [ -f "$CHAIN_DIR/scripts/init-chain.sh" ]; then
      if [ ! -f "$CHAIN_DIR/wevibed" ]; then
        info "Building wevibed first..."
        (cd "$CHAIN_DIR" && go build -o wevibed ./cmd/wevibed) >> "$LOG_DIR/chain-build.log" 2>&1
      fi
      WEVIBED_BINARY="$CHAIN_DIR/wevibed" WEVIBED_HOME="$CHAIN_HOME" bash "$CHAIN_DIR/scripts/init-chain.sh" >> "$LOG_DIR/chain-init.log" 2>&1
      ok "Chain initialized"
    else
      warn "No init-chain.sh found"
    fi
  fi

  if [ ! -f "$CHAIN_DIR/wevibed" ]; then
    info "Building wevibed..."
    (cd "$CHAIN_DIR" && go build -o wevibed ./cmd/wevibed) >> "$LOG_DIR/chain-build.log" 2>&1
    ok "wevibed built"
  fi

  "$CHAIN_DIR/wevibed" start \
    --home "$CHAIN_HOME" \
    >> "$LOG_DIR/chain.log" 2>&1 &
  echo $! > "$PID_DIR/chain.pid"
  info "wevibe-chain starting (PID $(cat "$PID_DIR/chain.pid"))"

  if ! wait_for "wevibe-chain RPC" "http://localhost:26657/status" 30; then
    if detect_chain_corruption; then
      mitigate_chain_corruption

      if [ -f "$CHAIN_DIR/wevibed" ]; then
        info "Re-initializing chain after corruption reset..."
        WEVIBED_BINARY="$CHAIN_DIR/wevibed" WEVIBED_HOME="$CHAIN_HOME" bash "$CHAIN_DIR/scripts/init-chain.sh" >> "$LOG_DIR/chain-init.log" 2>&1
        ok "Chain re-initialized"
      fi

      "$CHAIN_DIR/wevibed" start \
        --home "$CHAIN_HOME" \
        >> "$LOG_DIR/chain.log" 2>&1 &
      echo $! > "$PID_DIR/chain.pid"
      info "wevibe-chain restarting (PID $(cat "$PID_DIR/chain.pid"))"

      if ! wait_for "wevibe-chain RPC" "http://localhost:26657/status" 45; then
        fail "Chain failed to start after corruption mitigation"
      fi
    fi
  fi
else
  warn "Skipping wevibe-chain (--skip-chain)"
fi

info "Starting wevibe-hub..."
HUB_DIR="$WEVIBE_ROOT/wevibe-server/wevibe-hub"

kill_pid "$PID_DIR/hub.pid"
pkill -f "wevibe-hub" 2>/dev/null || true

if [ -f "$HUB_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$HUB_DIR/.env"
  set +a
fi

if [ ! -f "$HUB_DIR/wevibe-hub" ]; then
  info "Building wevibe-hub..."
  (cd "$HUB_DIR" && go build -o wevibe-hub ./cmd/wevibe-hub) >> "$LOG_DIR/hub-build.log" 2>&1
  ok "wevibe-hub built"
fi

if command -v psql &>/dev/null; then
  PGPASSWORD=wevibe_dev psql -h localhost -p 5433 -U wevibe -d wevibe_hub -c "SELECT 1 FROM orgs LIMIT 0" > /dev/null 2>&1 || {
    info "Applying database schema..."
    PGPASSWORD=wevibe_dev psql -h localhost -p 5433 -U wevibe -d wevibe_hub -f "$HUB_DIR/internal/db/schema.sql" >> "$LOG_DIR/schema.log" 2>&1
    ok "Schema applied"
  }
fi

CHAIN_SUBMITTER_MNEMONIC="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
export WEVIBE_CHAIN_ENABLED=true
export WEVIBE_CHAIN_GRPC_URL="localhost:9090"
export WEVIBE_CHAIN_ID="wevibe-local-1"
export WEVIBE_CHAIN_SUBMITTER_MNEMONIC="$CHAIN_SUBMITTER_MNEMONIC"
export WEVIBE_TEST_MODE=true

(cd "$HUB_DIR" && ./wevibe-hub) >> "$LOG_DIR/hub.log" 2>&1 &
echo $! > "$PID_DIR/hub.pid"
info "wevibe-hub starting (PID $(cat "$PID_DIR/hub.pid"))"

wait_for "wevibe-hub" "http://localhost:4440/health" 15

# ── wevibe-mcp ──────────────────────────────────────────────
info "Starting wevibe-mcp..."
MCP_DIR="$WEVIBE_ROOT/WeVibe/wevibe-mcp"

kill_pid "$PID_DIR/mcp.pid"

if [ ! -d "$MCP_DIR/node_modules" ]; then
  info "Installing wevibe-mcp dependencies..."
  (cd "$MCP_DIR" && npm install) >> "$LOG_DIR/mcp-install.log" 2>&1
  ok "wevibe-mcp dependencies installed"
fi

if [ ! -d "$MCP_DIR/dist" ] || [ "$(find "$MCP_DIR/src" -name '*.ts' -newer "$MCP_DIR/dist/server.js" 2>/dev/null | head -1)" ]; then
  info "Building wevibe-mcp..."
  (cd "$MCP_DIR" && npm run build) >> "$LOG_DIR/mcp-build.log" 2>&1
  ok "wevibe-mcp built"
fi

WEVIBE_HUB_URL="http://localhost:4440" \
  node "$MCP_DIR/dist/server.js" >> "$LOG_DIR/mcp.log" 2>&1 &
echo $! > "$PID_DIR/mcp.pid"
info "wevibe-mcp starting (PID $(cat "$PID_DIR/mcp.pid"))"

wait_for "wevibe-mcp HTTP" "http://127.0.0.1:4450/v1/health" 15

if [ "$SKIP_DASHBOARD" = false ]; then
  info "Starting wevibe-dashboard..."
  DASH_DIR="$WEVIBE_ROOT/wevibe-server/wevibe-dashboard"

  kill_pid "$PID_DIR/dashboard.pid"
  pkill -f "next dev.*wevibe-dashboard" 2>/dev/null || true
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true

  if [ ! -d "$DASH_DIR/node_modules" ]; then
    info "Installing dashboard dependencies..."
    (cd "$DASH_DIR" && npm install) >> "$LOG_DIR/dash-install.log" 2>&1
    ok "Dependencies installed"
  fi

  (cd "$DASH_DIR" && npm run dev) >> "$LOG_DIR/dashboard.log" 2>&1 &
  echo $! > "$PID_DIR/dashboard.pid"
  info "wevibe-dashboard starting (PID $(cat "$PID_DIR/dashboard.pid"))"

  wait_for "wevibe-dashboard" "http://localhost:3000" 20
else
  warn "Skipping wevibe-dashboard (--skip-dashboard)"
fi

info "Checking Ollama..."
if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  ok "Ollama running"
else
  warn "Ollama not running"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  WeVibe Network — All services started${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Dashboard:   http://localhost:3000"
echo "  Hub API:     http://localhost:4440"
echo "  Hub Health:  http://localhost:4440/health"
echo "  wevibe-mcp:    http://127.0.0.1:4450"
echo "  Qdrant:      http://localhost:6333"
echo "  Chain RPC:   http://localhost:26657"
echo "  PostgreSQL:  localhost:5433"
echo ""
echo "  Logs:        $LOG_DIR/"
echo "  PIDs:        $PID_DIR/"
echo ""
