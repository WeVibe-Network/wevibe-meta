# WeVibe — Cross-Module Topology

This file is the master cross-module topology pointer for the WeVibe workspace.
The canonical detailed topology lives in
[wevibe-docs/TOPOLOGY.md](../../../wevibe-docs/TOPOLOGY.md). This file summarizes
inter-module flows and indexes the per-module TOPOLOGY.md files.

## Per-module TOPOLOGY.md

| Module | Path |
|---|---|
| Hub | `wevibe-server/wevibe-hub/docs/TOPOLOGY.md` |
| Dashboard | `wevibe-server/wevibe-dashboard/docs/TOPOLOGY.md` |
| Protocol | `wevibe-protocol/docs/TOPOLOGY.md` |
| Chain | `wevibe-chain/x/*/README.md` (per module; no monolithic TOPOLOGY.md yet) |
| Canonical project-wide | `wevibe-docs/TOPOLOGY.md` |

---

## Sprint 29 — CO-011a.4: Hub-as-Relay Migration

GAP-IDENTITY-1 is **CLOSED** by CO-011a.4 (2026-05-24). The hub no longer
broadcasts chain transactions from its own wallet for user-initiated
operations. The dashboard owns construction and signing for every chain
operation; the hub becomes a content-agnostic relay for delegate-signed
transactions.

### Three-category broadcast taxonomy (Decision 2026-05-24-B)

```
                          ┌─────────────────────────────────┐
                          │      wevibe-dashboard           │
                          │  (single source of msg-build    │
                          │   and signing for every flow)   │
                          └────────┬───────────────┬────────┘
                                   │               │
                  Category A       │               │       Category B
            (master-wallet-direct) │               │    (delegate-via-relay)
                                   │               │
                  ┌────────────────▼──┐         ┌──▼─────────────────────┐
                  │  Keplr            │         │  Delegate HD wallet    │
                  │  signAndBroadcast │         │  (IndexedDB)           │
                  └────────┬──────────┘         │  → MsgExec wrapping    │
                           │                    │     inner Msg(s)       │
                           │                    │  → canonical body      │
                           │                    │     WV-RELAY-v1        │
                           │                    │  → POST hub relay      │
                           │                    └──┬─────────────────────┘
                           │                       │
                  ┌────────▼───────────┐        ┌──▼─────────────────────┐
                  │  Chain RPC         │        │  wevibe-hub            │
                  │  (direct)          │        │  POST /v1/relay/       │
                  └────────┬───────────┘        │       broadcast        │
                           │                    │  - parse canonical body│
                           │                    │  - verify delegate sig │
                           │                    │  - check inner granter │
                           │                    │  - check allowlist     │
                           │                    │  - broadcast_tx_sync   │
                           │                    └──┬─────────────────────┘
                           │                       │
                           └───────────┬───────────┘
                                       │
                                       ▼
                              ┌────────────────────┐
                              │   wevibe-chain     │
                              └─────────┬──────────┘
                                        │
                                        │ (tx confirmation)
                                        ▼
                              ┌────────────────────┐
                              │  ChainWatcher      │
                              │  (in wevibe-hub)   │
                              │  - 5 bookkeeping   │
                              │    handlers do all │
                              │    post-confirm    │
                              │    DB + Qdrant     │
                              └────────────────────┘
```

### Inter-module contracts changed by CO-011a.4

- **wevibe-protocol → wevibe-hub + wevibe-dashboard:**
  `test_vectors/relay_envelope_v1.json` is the canonical reference for the
  relay canonical-body format (Decision 2026-05-24-F). Both
  `wevibe-hub/internal/relay/validator.go` (parser) and
  `wevibe-dashboard/lib/canonical-body.ts` (builder) MUST produce
  byte-equal canonical bodies for every vector.

- **wevibe-dashboard → wevibe-hub:** New top-level route
  `POST /v1/relay/broadcast` with `Authorization: Delegate <base64-sig>`
  header (Decision 2026-05-24-E). Replaces five legacy endpoints
  (`/batch-chain-submit`, `/serves/batch-submit`, `/denials/batch-submit`,
  `/reports/{id}/commit`, `PUT /chain-config`).

- **wevibe-dashboard → wevibe-chain (direct):** Category A operations
  (`MsgGrant`, `MsgRevoke`, Category A `MsgSetOrgConfig`, `MsgSubmitDenialBatch`)
  go straight to chain RPC via Keplr. The hub is not on the path. CO-017 adds
  `MsgSubmitDenialBatch` as a new Category A operation (denial batch submission
  from dashboard — D-2026-05-25-A).

- **wevibe-chain → wevibe-hub (ChainWatcher):** Activated by CO-011a.4
  (Decision 2026-05-24-M). All five bookkeeping handlers from CO-011a.3
  are routed in `processTx`. The watcher is now the sole owner of
  post-confirmation DB writes and Qdrant updates for the five Category B
  operations: approve memory, serve batch, denial batch, report memory,
  register org.

- **wevibe-hub schema:** `delegate_keys` table overhauled (Decision
  2026-05-24-H) — PK is `wallet_address` (global, not per-org); `org_id`
  column and FK to `orgs` removed. Migration:
  `db/migrations/000003_delegate_keys_wallet_pk.up.sql`.

- **wevibe-dashboard merkle parity:** `lib/merkle.ts` is byte-for-byte
  equivalent to `wevibe-hub/internal/chain/merkle.go ComputeMerkleRoot`.
  Verified via fixture test at `lib/merkle.test.ts` (run with
  `npx tsx lib/merkle.test.ts`).

### Decisions reference

The complete set of 15 decisions locked on 2026-05-24 — `2026-05-24-A`
through `2026-05-24-O` — is codified in `wevibe-docs/DECISIONS.md`. See
also CO-011a.4 implementation report at
`wevibe-meta/workspace/reports/CO-011a.4-implementation-report.txt`.

---

## Indexed gaps

See `wevibe-docs/MASTER.md` for the live gap log. Cross-module gaps closed
or opened by sprint 29:

- **GAP-IDENTITY-1** (CRITICAL) — CLOSED by CO-011a.4 (hub-as-relay
  migration complete).
- **GAP-CHAIN-1** (CRITICAL) — CLOSED by CO-009 (keyword weight decay).
- **GAP-CHAIN-3** (MAJOR) — CLOSED by CO-005 series (x/upgrade verified).
- **GAP-CHAIN-8** (MAJOR) — CLOSED by CO-003 (proto-gen tooling).
- **GAP-CHAIN-20** (MAJOR) — CLOSED by CO-005d + CO-010 verification.

Remaining open per `wevibe-docs/MASTER.md` Summary: GAP-CHAIN-5 (genesis
parameter finalization), ARCH-G9 (BIP-32 key hierarchy), and four MINOR
items.