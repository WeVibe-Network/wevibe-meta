#!/usr/bin/env bash
# WeVibe Network — Clear All State (fresh start)
# WARNING: This destroys all local data — chain state, DB, Qdrant, logs, PIDs
set -euo pipefail

WEVIBE_ROOT="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[wevibe]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }

echo -e "${RED}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║  WARNING: This will destroy ALL local WeVibe data  ║${NC}"
echo -e "${RED}║  Chain state, PostgreSQL DB, Qdrant, logs, PIDs  ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════════╝${NC}"
echo ""
read -rp "Type 'yes' to confirm: " confirm
if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

info "Stopping all services..."
"$WEVIBE_ROOT/stop.sh" 2>/dev/null || true
echo ""

cd "$WEVIBE_ROOT"

docker compose -f wevibe-server/docker-compose.yml down -v > /dev/null 2>&1 || true
ok "Docker containers and volumes removed"

if [ -d "$WEVIBE_ROOT/.qdrant-data" ]; then
  rm -rf "$WEVIBE_ROOT/.qdrant-data"
  ok "Cleared Qdrant data"
fi

CHAIN_HOME="$HOME/.wevibed"
if [ -d "$CHAIN_HOME" ]; then
  rm -rf "$CHAIN_HOME"
  ok "Cleared chain state (~/.wevibed)"
fi

rm -rf "$WEVIBE_ROOT/.logs" "$WEVIBE_ROOT/.pids"
ok "Cleared logs and PIDs"

DASH_DIR="$WEVIBE_ROOT/wevibe-server/wevibe-dashboard"
if [ -d "$DASH_DIR/.next" ]; then
  rm -rf "$DASH_DIR/.next"
  ok "Cleared dashboard build cache"
fi

HUB_DIR="$WEVIBE_ROOT/wevibe-server/wevibe-hub"
if [ -f "$HUB_DIR/wevibe-hub" ]; then
  rm -f "$HUB_DIR/wevibe-hub"
  ok "Removed hub binary (will rebuild on next start)"
fi

CHAIN_DIR="$WEVIBE_ROOT/wevibe-chain"
if [ -f "$CHAIN_DIR/wevibed" ]; then
  rm -f "$CHAIN_DIR/wevibed"
  ok "Removed chain binary (will rebuild on next start)"
fi

echo ""
echo -e "${GREEN}All state cleared. Run ./start.sh to begin fresh.${NC}"