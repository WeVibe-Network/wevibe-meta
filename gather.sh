#!/usr/bin/env bash
# gather-co244.sh — Collect context for CO-244: Plugin HTTP API + wevibe-mcp HTTP Server
# Run from: /Users/jerrysmith/Desktop/WeVibe
set -euo pipefail

BASE="/Users/jerrysmith/Desktop/WeVibe"
OUT="$BASE/gather-co244-$(date +%Y%m%d-%H%M%S).txt"

{
  echo "========================================"
  echo "CO-244 Gather — Plugin HTTP API Context"
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "========================================"

  echo ""
  echo "================================================================"
  echo "SECTION 1: wevibe-mcp TOPOLOGY.md"
  echo "================================================================"
  cat "$BASE/WeVibe/wevibe-mcp/docs/TOPOLOGY.md"

  echo ""
  echo "================================================================"
  echo "SECTION 2: Master TOPOLOGY.md (workspace)"
  echo "================================================================"
  cat "$BASE/workspace/docs/TOPOLOGY.md"

  echo ""
  echo "================================================================"
  echo "SECTION 3: Plugin file — wevibe-guard.ts (current subprocess impl)"
  echo "================================================================"
  cat "$BASE/WeVibe/.opencode/plugins/wevibe-guard.ts"

  echo ""
  echo "================================================================"
  echo "SECTION 4: Plugin TUI file — wevibe-guard-tui.tsx"
  echo "================================================================"
  cat "$BASE/WeVibe/.opencode/plugins/wevibe-guard-tui.tsx"

  echo ""
  echo "================================================================"
  echo "SECTION 5: wevibe-mcp server.ts (entry point — current MCP server)"
  echo "================================================================"
  cat "$BASE/WeVibe/wevibe-mcp/src/server.ts"

  echo ""
  echo "================================================================"
  echo "SECTION 6: wevibe-mcp sidecar.ts"
  echo "================================================================"
  cat "$BASE/WeVibe/wevibe-mcp/src/sidecar.ts"

  echo ""
  echo "================================================================"
  echo "SECTION 7: wevibe-mcp retrieve-cli.ts (shared retrieval layer)"
  echo "================================================================"
  cat "$BASE/WeVibe/wevibe-mcp/src/retrieve-cli.ts"

  echo ""
  echo "================================================================"
  echo "SECTION 8: DECISIONS.md — D-12.5 and D-12.6 (extracted)"
  echo "================================================================"
  sed -n '/^### D-12\.5/,/^### D-12\.7/p' "$BASE/DECISIONS.md" | head -n -1

  echo ""
  echo "================================================================"
  echo "SECTION 9: MASTER.md — §5 Consumer (plugin transport table)"
  echo "================================================================"
  sed -n '/^## 5\. Consumer/,/^## [0-9]/p' "$BASE/MASTER.md" | head -n -1

  echo ""
  echo "================================================================"
  echo "SECTION 10: wevibe-mcp package.json (deps + scripts)"
  echo "================================================================"
  cat "$BASE/WeVibe/wevibe-mcp/package.json"

  echo ""
  echo "================================================================"
  echo "SECTION 11: opencode.json (plugin registration)"
  echo "================================================================"
  cat "$BASE/WeVibe/opencode.json"

  echo ""
  echo "================================================================"
  echo "SECTION 12: wevibe-mcp dashboard-server.ts (existing HTTP server if any)"
  echo "================================================================"
  cat "$BASE/WeVibe/wevibe-mcp/src/dashboard-server.ts"

  echo ""
  echo "================================================================"
  echo "SECTION 13: start.sh (service startup — how wevibe-mcp currently launches)"
  echo "================================================================"
  cat "$BASE/start.sh"

  echo ""
  echo "========================================"
  echo "END OF GATHER"
  echo "========================================"

} > "$OUT" 2>&1

echo "$OUT"