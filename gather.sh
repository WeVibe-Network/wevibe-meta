#!/usr/bin/env bash
# gather-co244.sh — Collect context for CO-244: Plugin HTTP API + wevibe-mcp HTTP Server
# Run from repository root (paths derived dynamically)
set -euo pipefail

META_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$META_ROOT/.." && pwd)"
OUT="$META_ROOT/gather-co244-$(date +%Y%m%d-%H%M%S).txt"

{
  echo "========================================"
  echo "CO-244 Gather — Plugin HTTP API Context"
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "========================================"

  echo ""
  echo "================================================================"
  echo "SECTION 1: wevibe-mcp TOPOLOGY.md"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-mcp/docs/TOPOLOGY.md" ]; then
    cat "$WORKSPACE_ROOT/wevibe-mcp/docs/TOPOLOGY.md"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-mcp/docs/TOPOLOGY.md"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 2: Master TOPOLOGY.md (workspace)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-meta/workspace/docs/TOPOLOGY.md" ]; then
    cat "$WORKSPACE_ROOT/wevibe-meta/workspace/docs/TOPOLOGY.md"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-meta/workspace/docs/TOPOLOGY.md"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 3: Plugin file — wevibe-guard.ts (current subprocess impl)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-opencode-plugin/plugins/wevibe-guard.ts" ]; then
    cat "$WORKSPACE_ROOT/wevibe-opencode-plugin/plugins/wevibe-guard.ts"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-opencode-plugin/plugins/wevibe-guard.ts"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 4: Plugin TUI file — wevibe-guard-tui.tsx"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-opencode-plugin/plugins/wevibe-guard-tui.tsx" ]; then
    cat "$WORKSPACE_ROOT/wevibe-opencode-plugin/plugins/wevibe-guard-tui.tsx"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-opencode-plugin/plugins/wevibe-guard-tui.tsx"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 5: wevibe-mcp server.ts (entry point — current MCP server)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-mcp/src/server.ts" ]; then
    cat "$WORKSPACE_ROOT/wevibe-mcp/src/server.ts"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-mcp/src/server.ts"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 6: wevibe-mcp sidecar.ts"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-mcp/src/sidecar.ts" ]; then
    cat "$WORKSPACE_ROOT/wevibe-mcp/src/sidecar.ts"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-mcp/src/sidecar.ts"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 7: wevibe-mcp retrieve-cli.ts (shared retrieval layer)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-mcp/src/retrieve-cli.ts" ]; then
    cat "$WORKSPACE_ROOT/wevibe-mcp/src/retrieve-cli.ts"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-mcp/src/retrieve-cli.ts"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 8: DECISIONS.md — D-12.5 and D-12.6 (extracted)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-docs/DECISIONS.md" ]; then
    sed -n '/^### D-12\.5/,/^### D-12\.7/p' "$WORKSPACE_ROOT/wevibe-docs/DECISIONS.md" | head -n -1
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-docs/DECISIONS.md"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 9: MASTER.md — §5 Consumer (plugin transport table)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-docs/MASTER.md" ]; then
    sed -n '/^## 5\. Consumer/,/^## [0-9]/p' "$WORKSPACE_ROOT/wevibe-docs/MASTER.md" | head -n -1
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-docs/MASTER.md"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 10: wevibe-mcp package.json (deps + scripts)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-mcp/package.json" ]; then
    cat "$WORKSPACE_ROOT/wevibe-mcp/package.json"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-mcp/package.json"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 11: tui.json (plugin registration)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-opencode-plugin/tui.json" ]; then
    cat "$WORKSPACE_ROOT/wevibe-opencode-plugin/tui.json"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-opencode-plugin/tui.json"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 12: wevibe-mcp dashboard-server.ts (existing HTTP server if any)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-mcp/src/dashboard-server.ts" ]; then
    cat "$WORKSPACE_ROOT/wevibe-mcp/src/dashboard-server.ts"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-mcp/src/dashboard-server.ts"
  fi

  echo ""
  echo "================================================================"
  echo "SECTION 13: start.sh (service startup — how wevibe-mcp currently launches)"
  echo "================================================================"
  if [ -f "$WORKSPACE_ROOT/wevibe-meta/start.sh" ]; then
    cat "$WORKSPACE_ROOT/wevibe-meta/start.sh"
  else
    echo "[missing] $WORKSPACE_ROOT/wevibe-meta/start.sh"
  fi

  echo ""
  echo "========================================"
  echo "END OF GATHER"
  echo "========================================"

} > "$OUT" 2>&1

echo "$OUT"
