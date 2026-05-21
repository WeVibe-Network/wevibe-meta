#!/bin/bash
# Chunk 3: Gather dashboard files for audit
# Focus: hub-client API calls, moderation page, billing/credits, env config

META_ROOT="$(cd "$(dirname "$0")" && pwd)"
BASE="$(cd "$META_ROOT/.." && pwd)"
OUT="$META_ROOT/wevibe-dashboard-audit-chunk3.txt"

echo "=== WeVibe Dashboard Audit - Chunk 3 ===" > "$OUT"
echo "Generated: $(date)" >> "$OUT"
echo "" >> "$OUT"

# 1. Directory tree
echo "===== TREE: wevibe-dashboard (src only) =====" >> "$OUT"
find "$BASE/wevibe-server/wevibe-dashboard" -type f \
  -not -path "*/.next/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -not -name "*.lock" \
  -not -name "*.ico" \
  -not -name "*.png" \
  -not -name "*.svg" \
  | sort >> "$OUT"
echo "" >> "$OUT"

# 2. Hub client — the API layer
for f in \
  "$BASE/wevibe-server/wevibe-dashboard/lib/hub-client.ts" \
  "$BASE/wevibe-server/wevibe-dashboard/lib/api.ts" \
  "$BASE/wevibe-server/wevibe-dashboard/lib/client.ts" \
  "$BASE/wevibe-server/wevibe-dashboard/src/lib/hub-client.ts"; do
  if [ -f "$f" ]; then
    echo "===== FILE: $f =====" >> "$OUT"
    cat "$f" >> "$OUT"
    echo "" >> "$OUT"
  fi
done

# 3. All page/route files
find "$BASE/wevibe-server/wevibe-dashboard" -path "*/app/*" -name "*.tsx" \
  -not -path "*/.next/*" -not -path "*/node_modules/*" \
  | sort | while read f; do
  echo "===== FILE: $f =====" >> "$OUT"
  cat "$f" >> "$OUT"
  echo "" >> "$OUT"
done

# 4. Config files
for f in \
  "$BASE/wevibe-server/wevibe-dashboard/next.config.mjs" \
  "$BASE/wevibe-server/wevibe-dashboard/next.config.js" \
  "$BASE/wevibe-server/wevibe-dashboard/next.config.ts" \
  "$BASE/wevibe-server/wevibe-dashboard/.env.local.example" \
  "$BASE/wevibe-server/wevibe-dashboard/.env" \
  "$BASE/wevibe-server/wevibe-dashboard/package.json" \
  "$BASE/wevibe-server/wevibe-dashboard/tsconfig.json"; do
  if [ -f "$f" ]; then
    echo "===== FILE: $f =====" >> "$OUT"
    cat "$f" >> "$OUT"
    echo "" >> "$OUT"
  fi
done

# 5. Any remaining lib/ or utils/ files
find "$BASE/wevibe-server/wevibe-dashboard/lib" -name "*.ts" -o -name "*.tsx" 2>/dev/null \
  | sort | while read f; do
  echo "===== FILE: $f =====" >> "$OUT"
  cat "$f" >> "$OUT"
  echo "" >> "$OUT"
done

echo "Done. Output: $OUT"
echo "File size: $(wc -c < "$OUT") bytes, $(wc -l < "$OUT") lines"
