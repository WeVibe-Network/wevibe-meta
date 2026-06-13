# WeVibe Network — Top-level Makefile
#
# Per DECISIONS.md D-13.10 and DOGFOOD.md, the WeVibe stack runs in Docker
# with one host exception:
#   - Ollama: macOS host app (Metal GPU acceleration)
#
# `make dogfood` orchestrates Docker stack + test pipeline.

WORKSPACE_ROOT := $(abspath ..)
WEVIBE_SERVER_DIR := $(WORKSPACE_ROOT)/wevibe-server
WEVIBE_HUB_DIR := $(WEVIBE_SERVER_DIR)/wevibe-hub
WEVIBE_DASHBOARD_DIR := $(WEVIBE_SERVER_DIR)/wevibe-dashboard
WEVIBE_SIM_DIR := $(WORKSPACE_ROOT)/wevibe-sim
SDK_WASM_PKG_DIR := $(WORKSPACE_ROOT)/wevibe-sdk/pkg
SDK_WASM_VENDOR_DIR := $(WEVIBE_DASHBOARD_DIR)/vendor/wevibe-sdk-wasm
EXTRACTION_PROMPTS_SRC_DIR := $(WORKSPACE_ROOT)/wevibe-mcp/prompts/memory-extraction
EXTRACTION_PROMPTS_VENDOR_DIR := $(WEVIBE_SERVER_DIR)/wevibe-hub/internal/api/handlers/prompts/memory-extraction

# Proto generation image pins. R-DOCKER-PINNED — never use :latest.
# See DECISIONS.md D-14.21 / R-PROTO-REGEN.
PROTO_COSMOS_IMAGE  := ghcr.io/cosmos/proto-builder:0.18.1
PROTO_BUF_IMAGE     := bufbuild/buf:1.34.0

.PHONY: stop-host docker-up docker-build-fast docker-up-fast docker-down dogfood-fast-down health dogfood dogfood-fast dogfood-health dogfood-pipeline replay-gate clean wevibe-mcp-token sync-sdk-wasm sync-extraction-prompts mcp-up mcp-down mcp-restart mcp-status parity-check parity-fixtures contributor-up contributor-down contributor-restart contributor-status redeploy
.PHONY: proto-gen proto-gen-chain proto-gen-umbral

# ─── Host process cleanup ───────────────────────────────────────────────────
# Per CO-253: WeVibe services run in Docker, not on host. This target kills
# any lingering host processes from the old workflow.
stop-host:
	@echo "=== Stopping any host-process WeVibe services ==="
	@pkill -f "/wevibe-hub$$" 2>/dev/null || true
	@pkill -f "wevibed start" 2>/dev/null || true
	@pkill -f "next-server (v" 2>/dev/null || true
	@pkill -f "next dev" 2>/dev/null || true
	@pkill -f "/wevibe-workspace/wevibe-mcp/dist/server.js" 2>/dev/null || true
	@pkill -f "wevibe-mcp/dist/server.js" 2>/dev/null || true
	@pkill -f "/Echo/echo-mcp/dist/server.js" 2>/dev/null || true
	@pkill -f "echo-mcp/dist/server.js" 2>/dev/null || true
	@sleep 1
	@echo "Host processes cleaned. (Ollama left alone — see DECISIONS.md D-13.10.)"

# ─── Stack lifecycle ────────────────────────────────────────────────────────

docker-up:
	@echo "=== Bringing up WeVibe stack via Docker ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose up -d --build
	@echo "Stack started. Waiting for services to become healthy..."
	@cd "$(WEVIBE_SERVER_DIR)" && ./scripts/wait-for-stack-healthy.sh

docker-build-fast:
	@echo "=== Building WeVibe fast stack images once ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose -f docker-compose.yml -f docker-compose.fast.yml build

docker-up-fast:
	@echo "=== Bringing up WeVibe stack via Docker (fast epoch mode) ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose -f docker-compose.yml -f docker-compose.fast.yml up -d
	@echo "Fast stack started. Waiting for services to become healthy..."
	@cd "$(WEVIBE_SERVER_DIR)" && ./scripts/wait-for-stack-healthy.sh

docker-down:
	@echo "=== Tearing down WeVibe stack and WIPING volumes ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose down -v
	@docker rm -f wevibe-validator 2>/dev/null || true
	@docker rm -f echo-validator 2>/dev/null || true

# ─── Contributor dashboard (host Next.js dev server on :3001) ───────────────
# The leader dashboard runs in Docker (:3000). The CONTRIBUTOR dashboard runs on
# the host (:3001) so it can reach the host MCP (:4450). Its `.next` dev cache
# reliably corrupts on every stack rebuild — these targets wipe the cache and
# restart it in one command (detached, logged to wevibe-meta/.logs/). Use
# `make redeploy` for the full "I changed code" button (wipe+rebuild+:3001).

contributor-up:
	@bash ./scripts/contributor-dashboard.sh up

contributor-down:
	@bash ./scripts/contributor-dashboard.sh down

contributor-restart:
	@bash ./scripts/contributor-dashboard.sh restart

contributor-status:
	@bash ./scripts/contributor-dashboard.sh status

# One-button redeploy: wipe + rebuild the Docker stack AND clear-cache+restart
# the host :3001 contributor dashboard. Replaces the manual
# docker-down → docker-up → rm -rf .next → restart :3001 dance.
# NOTE: still restart opencode yourself to reload the host MCP dist (:4450/:4451).
redeploy: docker-down docker-up contributor-restart
	@echo ""
	@echo "=== ♻️  Redeploy complete — stack rebuilt + :3001 cache cleared & restarted ==="
	@echo "    Reminder: restart opencode to reload the host MCP (:4450/:4451) dist."

# ─── Health check (against running stack) ──────────────────────────────────

health:
	@echo "=== WeVibe Network Health Check ==="
	@printf "Hub (4440, container):       " && curl -sf http://localhost:4440/health > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Dashboard (3000, container): " && curl -sf -o /dev/null http://localhost:3000 && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Qdrant (6333, container):    " && curl -sf http://localhost:6333/healthz > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Chain RPC (26657, container):" && curl -sf http://localhost:26657/status > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Social Graph (4470, container):" && curl -sf http://localhost:4470/v1/health > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "wevibe-mcp (4452, container):  " && TOKEN=$$(docker exec wevibe-mcp cat /root/.wevibe/mcp-session-token 2>/dev/null); [ -n "$$TOKEN" ] && curl -sf -H "Authorization: Bearer $$TOKEN" http://127.0.0.1:4452/v1/health > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Ollama (11434, HOST):        " && curl -sf http://localhost:11434/api/tags > /dev/null && echo "✓" || echo "✗ UNREACHABLE (start Ollama.app)"

# ─── Dogfood (full test cycle) ──────────────────────────────────────────────

dogfood: stop-host docker-down docker-up dogfood-health dogfood-pipeline docker-down
	@echo ""
	@echo "=== 🎉 Dogfood complete — all checks passed ==="

dogfood-fast: stop-host docker-down docker-up-fast dogfood-health
	@echo ""
	@echo "=== ⚡ Fast dogfood health complete (2s epoch) ==="
	@echo "Run 'make dogfood-pipeline' to execute the pipeline test, then 'make dogfood-fast-down' to tear down the fast stack."

dogfood-fast-down:
	@echo "=== Tearing down WeVibe fast stack and WIPING volumes ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose -f docker-compose.yml -f docker-compose.fast.yml down -v
	@docker rm -f wevibe-validator 2>/dev/null || true
	@docker rm -f echo-validator 2>/dev/null || true

dogfood-health:
	@echo ""
	@echo "=== Stage 1: Service Health ==="
	@cd tests && npm ci --no-audit --no-fund
	@cd tests && npx vitest run e2e/service-health.test.ts --reporter=verbose 2>&1

dogfood-pipeline:
	@echo ""
	@echo "=== Stage 2: Pipeline Smoke Test ==="
	@cd tests && WEVIBE_MCP_IDENTITY_JSON="$$(docker exec wevibe-mcp node --input-type=module -e 'import("./dist/key-store.js").then(async (m) => { const identity = await m.loadIdentity(); if (!identity) process.exit(1); process.stdout.write(JSON.stringify({ edPrivkeyB64: Buffer.from(identity.edPrivkey).toString("base64"), edPubkeyB64: Buffer.from(identity.edPubkey).toString("base64"), xPrivkeyB64: Buffer.from(identity.xPrivkey).toString("base64"), xPubkeyB64: Buffer.from(identity.xPubkey).toString("base64") })); }).catch(() => process.exit(1));')" WEVIBE_MCP_SESSION_TOKEN="$$(docker exec wevibe-mcp cat /root/.wevibe/mcp-session-token)" npx vitest run e2e/dogfood-pipeline.test.ts --reporter=verbose 2>&1

replay-gate:
	@echo ""
	@echo "=== Stage 3: Empirical replay gate matrix ==="
	@bash ./scripts/replay-gate.sh

# ─── Manual ops ─────────────────────────────────────────────────────────────

# ─── Recall sim<->product parity guard (D-RECALL-ALIGNMENT Stage 1) ──────────
parity-check:
	@echo "=== Recall ranking parity: Go (wevibe-hub) vs JS (wevibe-sim) vs shared fixtures ==="
	@echo "--- Go side (ScoreAndRank against wevibe-protocol/test-vectors) ---"
	@cd "$(WEVIBE_HUB_DIR)" && go test ./internal/retrieval/... -run 'TestRankingParity|TestScoreAndRank' -count=1
	@echo "--- JS side (rank.mjs against the same fixtures) ---"
	@cd "$(WEVIBE_SIM_DIR)" && npm run --silent sim:parity
	@echo "=== parity OK ==="

# Regenerate the shared golden fixtures FROM the validated sim ranker (rank.mjs).
# Run this ONLY when intentionally changing the ranking contract; then re-run parity-check.
parity-fixtures:
	@echo "=== Regenerating recall-ranking parity fixtures from wevibe-sim/recall-sim/pipeline/rank.mjs ==="
	@cd "$(WEVIBE_SIM_DIR)" && node recall-sim/parity/gen-parity-fixtures.mjs
	@echo "=== fixtures written to wevibe-protocol/test-vectors/recall-ranking-parity.json ==="

mcp-up:
	@echo "=== Starting dashboard MCP launchd supervisor ==="
	@bash ./scripts/mcp-supervisor.sh up

mcp-down:
	@echo "=== Stopping dashboard MCP launchd supervisor ==="
	@bash ./scripts/mcp-supervisor.sh down

mcp-restart:
	@echo "=== Restarting dashboard MCP launchd supervisor ==="
	@bash ./scripts/mcp-supervisor.sh restart

mcp-status:
	@echo "=== Dashboard MCP launchd supervisor status ==="
	@bash ./scripts/mcp-supervisor.sh status

clean: docker-down stop-host
	@echo "Stack torn down. Volumes wiped. Host processes stopped."

wevibe-mcp-token:
	@docker exec wevibe-mcp cat /root/.wevibe/mcp-session-token

sync-sdk-wasm:
	@mkdir -p "$(SDK_WASM_VENDOR_DIR)"
	@cp "$(SDK_WASM_PKG_DIR)/wevibe_sdk_wasm.js" "$(SDK_WASM_VENDOR_DIR)/wevibe_sdk_wasm.js"
	@cp "$(SDK_WASM_PKG_DIR)/wevibe_sdk_wasm_bg.wasm" "$(SDK_WASM_VENDOR_DIR)/wevibe_sdk_wasm_bg.wasm"
	@cp "$(SDK_WASM_PKG_DIR)/wevibe_sdk_wasm.d.ts" "$(SDK_WASM_VENDOR_DIR)/wevibe_sdk_wasm.d.ts"
	@cp "$(SDK_WASM_PKG_DIR)/package.json" "$(SDK_WASM_VENDOR_DIR)/package.json"
	@echo "Synced wevibe-sdk WASM bundle into $(SDK_WASM_VENDOR_DIR)"

sync-extraction-prompts:
	@echo "=== Syncing extraction prompt fragments into hub ==="
	@mkdir -p "$(EXTRACTION_PROMPTS_VENDOR_DIR)"
	@cp "$(EXTRACTION_PROMPTS_SRC_DIR)"/*.md "$(EXTRACTION_PROMPTS_VENDOR_DIR)/"
	@echo "Synced extraction prompts into $(EXTRACTION_PROMPTS_VENDOR_DIR)"

# ─── Proto generation (R-PROTO-REGEN / R-DOCKER-PINNED / R-NO-LOCAL-PROTOC) ─

proto-gen: proto-gen-chain proto-gen-umbral
	@echo "=== Proto regeneration complete ==="

proto-gen-chain:
	@echo "=== Regenerating wevibe-chain proto ==="
	$(MAKE) -C $(WORKSPACE_ROOT)/wevibe-chain proto-gen
	@echo "    chain proto regenerated."

proto-gen-umbral:
	@echo "=== Regenerating wevibe-server umbral sidecar proto ==="
	docker run --rm \
		-v "$(WORKSPACE_ROOT):/workspace" \
		-w "/workspace/wevibe-umbral/proto/umbral/v1" \
		$(PROTO_BUF_IMAGE) generate sidecar.proto \
		--template '{"version":"v1","plugins":[{"plugin":"buf.build/protocolbuffers/go:v1.36.11","out":"/workspace/wevibe-server/wevibe-hub/internal/umbral/umbralpb","opt":"paths=source_relative"},{"plugin":"buf.build/grpc/go:v1.6.2","out":"/workspace/wevibe-server/wevibe-hub/internal/umbral/umbralpb","opt":"paths=source_relative"}]}'
	@echo "    umbral pb.go regenerated."
