# WeVibe Network — Top-level Makefile
#
# Per DECISIONS.md D-13.10 and DOGFOOD.md, the WeVibe stack runs in Docker
# with one host exception:
#   - Ollama: macOS host app (Metal GPU acceleration)
#
# `make dogfood` orchestrates Docker stack + test pipeline.

WORKSPACE_ROOT := $(abspath ..)
WEVIBE_SERVER_DIR := $(WORKSPACE_ROOT)/wevibe-server

.PHONY: stop-host docker-up docker-down health dogfood dogfood-health dogfood-pipeline clean wevibe-mcp-token

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
