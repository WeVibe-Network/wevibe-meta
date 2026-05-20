# WeVibe Network — Infrastructure Gap Audit

**Document:** INFRASTRUCTURE_GAPS.md
**Generated:** 2026-05-13
**Sprint:** Sprint 21 — Plugin-Gated Memory Injection
**Purpose:** Comprehensive inventory of missing/incomplete features needed for local demo and public testnet

---

## Priority Classification

| Priority | Description |
|----------|-------------|
| **P0** | Required for local demo / public testnet launch |
| **P1** | Required before production readiness |
| **P2** | Nice to have, can ship later |

---

## P0 — Required for Public Testnet

### P0.1: UpdateMemberRole Production Endpoint

**Current state:** `TestUpdateMemberRole` exists in testing.go behind `WEVIBE_TEST_MODE=true` — no production equivalent.

**What exists:**
- `PATCH /v1/test/orgs/{orgID}/members/role` — test-only, bypasses remove+re-invite cycle, no signature required

**What's missing:**
- Production `PATCH /v1/orgs/{orgID}/members/{pubkey}/role` with canonical signature verification
- The canonical message must include: `org_id`, `pubkey`, `old_role`, `new_role`, `signed_by`
- Must require WeVibe-Signed auth from leader
- Must NOT trigger rotation (same-member role change should be lightweight)
- Rotation should only trigger on member removal, not role demotion/promotion

**Why it matters:** Cannot promote contributors to moderators without removing and re-inviting, which triggers epoch rotation — excessive for role-only changes.

---

### P0.2: TransferLeadership Endpoint

**Current state:** No endpoint exists. Leadership transfer not possible.

**What's missing:**
- `PATCH /v1/orgs/{orgID}/leader` with canonical message: `org_id`, `old_leader`, `new_leader`, `signed_by`
- Requires signature from old leader
- Must handle deposit reassignment
- Must update org's leader_pubkey in database

**Why it matters:** Cannot demo org leadership changes without manual database intervention.

---

### P0.3: CloseOrg / Org Destruction

**Current state:** No endpoint exists. Orgs are effectively immortal.

**What's missing:**
- `DELETE /v1/orgs/{orgID}` — leader-only, requires canonical signature
- Must release deposited credits
- Must trigger memory cleanup on chain
- Must invalidate all session keys
- Must handle keeper reclamation of storage deposits

**Why it matters:** Cannot demo org lifecycle without ability to close/demo a finished org.

---

### P0.4: MCP Dashboard Mode Testing Infrastructure

**Current state:** Moderation and Memories pages in dashboard require `wevibe-mcp --dashboard` on port 4450. No test harness for MCP tools.

**What's missing:**
- Test runner that starts `wevibe-mcp --dashboard` with test org identity
- MCP tool verification: `wevibe_mod_queue`, `wevibe_mod_approve`, `wevibe_mod_deny`
- Integration tests verifying MCP pathway matches direct API pathway
- Dockerfile/docker-compose for MCP dashboard container

**Why it matters:** The dashboard's primary moderation UI routes through MCP. Without testing this pathway, moderation feature is half-untested.

---

### P0.5: Session Extraction Test Harness

**Current state:** Sessions page reads from local SQLite at `~/.local/share/opencode/opencode.db`. The `/api/extract` endpoint calls local Ollama.

**What's missing:**
- Synthetic session data injection script — populates SQLite with fake OpenCode sessions
- Test that runs `wevibe-submit.ts` using settings from `/api/settings`
- Verification that extracted memories appear in the dashboard's submission UI

**Why it matters:** Sessions page is a primary memory injection pathway. Cannot demo without testing it.

---

### P0.6: Browser Identity ↔ Keytar Identity Bridge

**Current state:** CO-205 item — dashboard uses browser IndexedDB for WeVibe-Signed auth, but keytar stores identity in native process. No bridge.

**What's missing:**
- Keytar read/write utilities for WeVibe identity
- WebSocket or IPC bridge between browser and keytar
- Dashboard middleware that retrieves signing key from keytar when making hub calls

**Why it matters:** Dashboard cannot perform WeVibe-Signed operations without native key access. The MCP pathway bypasses this but direct API calls require bridging.

---

### P0.7: Submission Wiring in Sessions Page (CO-205 item)

**Current state:** Sessions page extracts memories but doesn't submit them to hub.

**What's missing:**
- Wiring from `/api/extract` output → `wevibe-submit.ts` invocation
- Submission status feedback in sessions page UI
- Handling of submission failures/retry

**Why it matters:** Primary demo use case: user runs session → memories auto-submitted for moderation.

---

## P1 — Required for Production

### P1.1: Memory Deposit Mechanism

**Current state:** No on-chain deposit per memory submission.

**What's missing:**
- Deposit amount per memory (e.g., 1000 wevibe credits)
- Refund on org closure (leader receives deposits from all approved memories)
- Non-refundable on moderation denial (deposit burned or sent to keeper pool)

**Why it matters:** Economic security — prevents spam submissions without skin in the game.

---

### P1.2: Keeper Cleanup on Org Death

**Current state:** No mechanism for keepers to reclaim storage when org goes inactive.

**What's missing:**
- Keeper watches org closure event
- Keeper deletes encrypted chunks from their storage nodes
- Deposits are returned to leader's wallet
- Tombstone markers left in chain state

**Why it matters:** Storage economics — keepers need compensation for storage provisioning.

---

### P1.3: Malicious Memory Deletion

**Current state:** Memory archival is the only state change; true deletion not implemented.

**What's missing:**
- Leader can mark memory as `deleted` (not just `archived`)
- Chain state reflects deletion
- Keepers delete chunks on deletion event
- Query results exclude deleted memories

**Why it matters:** Content moderation beyond archival — some content may require hard deletion for legal compliance.

---

### P1.4: Cross-Epoch Retrieval After Rotation

**Current state:** Rotation changes envelopes, but old epoch memories may not be queryable after rotation.

**What's missing:**
- Integration test: submit memory in epoch N, rotate, query in epoch N+1 — verify old memories still found
- Archive/bucket strategy for old epoch ciphertext storage
- Key unwrapping across epoch boundary (DEK wrapped to old pk_mod, must be re-wrapped to new pk_mod)

**Why it matters:** Core memory permanence guarantee — memories survive epoch rotations.

---

### P1.5: Duplicate Submission Detection

**Current state:** No deduplication on submission_hash.

**What's missing:**
- `UNIQUE(submission_hash)` constraint or application-level dedup check
- Re-submission of same content returns existing status (not a new entry)
- Test: submit same memory twice, verify only one pending entry

**Why it matters:** Prevents double-submission bugs and abuse.

---

### P1.6: Rate Limiting Per Org Per Contributor

**Current state:** No rate limiting.

**What's missing:**
- Per-contributor rate limits: e.g., max 10 submissions per hour
- Per-org global rate limits: e.g., max 1000 queries per hour
- 429 Too Many Requests responses with `Retry-After` header

**Why it matters:** DoS protection for hub and chain.

---

### P1.7: Webhook / Event System for Real-Time Dashboard Updates

**Current state:** Dashboard pages poll or require manual refresh.

**What's missing:**
- Server-Sent Events (SSE) endpoint: `GET /v1/orgs/{orgID}/events`
- Events: `memory_submitted`, `memory_approved`, `memory_denied`, `report_filed`, `report_resolved`
- Dashboard subscribes to SSE and updates UI in real-time
- Webhook alternative for external integrations

**Why it matters:** Dashboard UX — waiting for manual refresh breaks demo flow.

---

## P2 — Nice to Have

### P2.1: Role-Gated Dashboard Sidebar

**Current state:** All users see all pages regardless of role (members, reports, billing, sessions visible to consumers).

**What's missing:**
- UI conditional rendering based on role
- Server-side guards on API responses
- `GET /v1/orgs/{orgID}/permissions` endpoint returning allowed pages per role

**Why it matters:** Clean UX — consumers shouldn't see moderation or billing pages.

---

### P2.2: In-Dashboard Member Invitation Flow

**Current state:** Member invitation requires CLI (`leader/index.ts`) or direct API call.

**What's missing:**
- "Invite Member" button in Members page
- Modal/dialog with email + role selection
- Email-style invite link generation (or copy-to-clipboard)
- Invite acceptance flow

**Why it matters:** Full demo requires adding a member through the dashboard UI.

---

### P2.3: Dashboard Dark Mode

**Current state:** Light mode only.

**What's missing:**
- Theme toggle in settings
- CSS variable switcher
- System preference detection (`prefers-color-scheme`)

---

### P2.4: Export / Import Org Configuration

**Current state:** Org config (required_approvals, fee_model, etc.) is write-only via API.

**What's missing:**
- `GET /v1/orgs/{orgID}/export` — returns JSON blob of org config, members, keywords
- `POST /v1/orgs/{orgID}/import` — accepts JSON blob to restore config
- Use case: migrate test org config to production org

---

### P2.5: Batch Memory Submission from Sessions Page

**Current state:** Sessions page extracts one-by-one and submits individually.

**What's missing:**
- Bulk submit endpoint: `POST /v1/orgs/{orgID}/submit/batch`
- Accepts array of submission payloads
- Returns array of status responses

**Why it matters:** Efficiency — 50 sessions extracted = 50 individual POST requests.

---

### P2.6: In-Dashboard Memory Search

**Current state:** Memory search requires MCP pathway or direct API call.

**What's missing:**
- Search bar in dashboard's Memories page
- Calls `POST /v1/orgs/{orgID}/query` with vector search
- Results displayed inline in dashboard

**Why it matters:** Admins want to search memories without leaving dashboard.

---

## Tested ✓ Matrix

| Endpoint | Hub Handler | Leader Test | Mod Test | Contrib Test | Consumer Test | E2E Phase | Status |
|---|---|---|---|---|---|---|---|
| `GET /health` | Health | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `GET /v1/test/health` | TestHealth | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `POST /v1/test/reset` | TestReset | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `POST /v1/test/embed` | TestEmbed | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `GET /v1/orgs/{orgID}` | GetOrg | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `POST /v1/orgs` | CreateOrg | ✓ | — | — | — | ✓ | PASS |
| `PATCH /v1/orgs/{orgID}/config` | UpdateOrgConfig | ✓ | — | — | — | ✓ | PASS |
| `GET /v1/orgs/{orgID}/members` | ListMembers | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `POST /v1/orgs/{orgID}/members` | InviteMember | ✓ | — | — | — | ✓ | PASS |
| `DELETE /v1/orgs/{orgID}/members/{pubkey}` | RemoveMember | ✓ | — | — | — | ✓ | PASS |
| `PATCH /v1/test/orgs/{orgID}/members/role` | TestUpdateMemberRole | ✓ | — | — | — | ✓ | PASS |
| `GET /v1/test/orgs/{orgID}/queue` | TestGetQueue | ✓ | ✓ | ✓ | — | ✓ | PASS |
| `POST /v1/orgs/{orgID}/submit` | SubmitMemory | — | — | ✓ | — | ✓ | PASS |
| `GET /v1/orgs/{orgID}/moderation/queue` | GetPendingQueue | ✓ | ✓ | — | — (403) | ✓ | PASS |
| `POST /v1/orgs/{orgID}/moderation/{hash}/approve` | ApproveSubmission | ✓ | ✓ | — | — | ✓ | PASS |
| `POST /v1/orgs/{orgID}/moderation/{hash}/deny` | DenySubmission | ✓ | ✓ | — | — | ✓ | PASS |
| `POST /v1/orgs/{orgID}/moderation/batch-submit` | BatchSubmitToChain | ✓ | — | — | — | ✓ | PASS |
| `GET /v1/orgs/{orgID}/memories` | ListMemories | ✓ | ✓ | — | ✓ | ✓ | PASS |
| `GET /v1/orgs/{orgID}/memories/{cid}` | GetMemory | — | — | — | ✓ | — | PASS |
| `POST /v1/orgs/{orgID}/query` | QueryMemories | — | — | — | ✓ | ✓ | PASS |
| `POST /v1/orgs/{orgID}/serves` | RecordServeEvent | — | — | — | ✓ | ✓ | PASS |
| `POST /v1/orgs/{orgID}/reports` | CreateReport | ✓ | ✓ | ✓ | ✓ | ✓ | PASS |
| `GET /v1/orgs/{orgID}/reports` | ListReports | ✓ | ✓ | — | — (403) | ✓ | PASS |
| `PATCH /v1/orgs/{orgID}/reports/{id}` | UpdateReport | ✓ | ✓ | — | — | ✓ | PASS |
| `GET /v1/orgs/{orgID}/credits` | GetOrgCredits | ✓ | ✓ | ✓ | — | — | PASS |
| `POST /v1/orgs/{orgID}/epoch/rotate` | RotateEpoch | ✓ | — | — | — | ✓ | PASS |
| `GET /v1/members/{pubkey}/orgs` | GetMemberOrgs | — | — | ✓ | — | — | PASS |
| `POST /v1/orgs/{orgID}/reject` | RejectMemory | — | — | — | ✓ | ✓ | PASS |
| `POST /v1/orgs/{orgID}/dashboard/keys` | RegisterDashboardKey | ✓ | — | — | — | ✓ | PASS |
| `PATCH /v1/orgs/{orgID}/leader` | — | — | — | — | — | — | MISSING (P0) |
| `DELETE /v1/orgs/{orgID}` | — | — | — | — | — | — | MISSING (P0) |
| `PATCH /v1/orgs/{orgID}/members/{pubkey}/role` | — | — | — | — | — | — | MISSING (P0) |
| MCP tools (`wevibe_mod_queue`, etc.) | — | — | — | — | — | — | MISSING (P0) |
| Session extraction harness | — | — | — | — | — | — | MISSING (P0) |
| Keytar identity bridge | — | — | — | — | — | — | MISSING (P0) |

---

## Files Created / Modified This Sprint

| File | Action | Purpose |
|---|---|---|
| `wevibe-hub/internal/api/handlers/testing.go` | MODIFY | Added TestUpdateMemberRole, TestGetQueue |
| `wevibe-hub/cmd/wevibe-hub/main.go` | MODIFY | Registered new test routes |
| `tests/lib/hub-client.ts` | MODIFY | Added test endpoints, removeMember, updateReport, updateOrgConfig, rotateEpoch, getOrgDetails |
| `tests/lib/scenario.ts` | NEW | ScenarioRunner framework for interactive tests |
| `tests/lib/state.ts` | MODIFY | Added submissions, reports, TestState export |
| `tests/lib/seeder.ts` | NEW | Full scenario seeder (5 memories, 2 reports, 2 serves) |
| `tests/leader/index.ts` | OVERWRITE | 17 scenarios using ScenarioRunner |
| `tests/moderator/index.ts` | OVERWRITE | 10 scenarios using ScenarioRunner |
| `tests/contributor/index.ts` | OVERWRITE | 8 scenarios using ScenarioRunner |
| `tests/consumer/index.ts` | OVERWRITE | 11 scenarios using ScenarioRunner |
| `tests/e2e/full-lifecycle.test.ts` | OVERWRITE | 12-phase vitest suite |
| `tests/e2e/index.ts` | OVERWRITE | 12-phase automated runner |
| `tests/e2e/stress.test.ts` | NEW | 5 stress scenarios |
| `tests/INFRASTRUCTURE_GAPS.md` | NEW | This document |
| `tests/run-all.sh` | NEW | Orchestration script |
| `tests/lib/seed-dashboard-env.ts` | NEW | Dashboard .env.local seeder |

---

*End of INFRASTRUCTURE_GAPS.md*