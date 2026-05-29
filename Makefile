# WeVibe Network — Top-level Makefile
#
# Per DECISIONS.md D-13.10 and DOGFOOD.md, the WeVibe stack runs in Docker
# with one host exception:
#   - Ollama: macOS host app (Metal GPU acceleration)
#
# `make dogfood` orchestrates Docker stack + test pipeline.

WORKSPACE_ROOT := $(abspath ..)
WEVIBE_SERVER_DIR := $(WORKSPACE_ROOT)/wevibe-server

# Proto generation image pins. R-DOCKER-PINNED — never use :latest.
# See DECISIONS.md D-14.21 / R-PROTO-REGEN.
PROTO_COSMOS_IMAGE  := ghcr.io/cosmos/proto-builder:0.18.1
PROTO_BUF_IMAGE     := bufbuild/buf:1.34.0

.PHONY: stop-host docker-up docker-up-fast docker-down dogfood-fast-down health dogfood dogfood-fast dogfood-health dogfood-pipeline clean wevibe-mcp-token
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

docker-up-fast:
	@echo "=== Bringing up WeVibe stack via Docker (fast epoch mode) ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose -f docker-compose.yml -f docker-compose.fast.yml up -d --build
	@echo "Fast stack started. Waiting for services to become healthy..."
	@cd "$(WEVIBE_SERVER_DIR)" && ./scripts/wait-for-stack-healthy.sh

docker-down:
	@echo "=== Tearing down WeVibe stack and WIPING volumes ==="
	@cd "$(WEVIBE_SERVER_DIR)" && docker compose down -v
	@docker rm -f wevibe-validator 2>/dev/null || true
	@docker rm -f echo-validator 2>/dev/null || true

# ─── Health check (against running stack) ──────────────────────────────────

health:
	@echo "=== WeVibe Network Health Check ==="
	@printf "Hub (4440, container):       " && curl -sf http://localhost:4440/health > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Dashboard (3000, container): " && curl -sf -o /dev/null http://localhost:3000 && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Qdrant (6333, container):    " && curl -sf http://localhost:6333/healthz > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Chain RPC (26657, container):" && curl -sf http://localhost:26657/status > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "Social Graph (4470, container):" && curl -sf http://localhost:4470/v1/health > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
	@printf "wevibe-mcp (4450, container):  " && TOKEN=$$(docker exec wevibe-mcp cat /root/.wevibe/mcp-session-token 2>/dev/null); [ -n "$$TOKEN" ] && curl -sf -H "Authorization: Bearer $$TOKEN" http://127.0.0.1:4450/v1/health > /dev/null && echo "✓" || echo "✗ UNREACHABLE"
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

# ─── Manual ops ─────────────────────────────────────────────────────────────

clean: docker-down stop-host
	@echo "Stack torn down. Volumes wiped. Host processes stopped."

wevibe-mcp-token:
	@docker exec wevibe-mcp cat /root/.wevibe/mcp-session-token

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
