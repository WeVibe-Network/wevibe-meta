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

---

## Sprint 31 — CO-029: Signed Canonical Body Verification Anchor

The Tier 2 verification anchor is the signed-canonical-body pathway. A consumer
holding `(plaintext, salt)` can prove to the chain that the plaintext was the
one the contributor committed, without revealing it during the submit flow.

### Three byte-identical canonical body builders

| Implementation | File | Function |
|---|---|---|
| MCP | `wevibe-mcp/src/canonical.ts` | `submitMemoryMessage(...)` |
| Dashboard | `wevibe-server/wevibe-dashboard/lib/wevibe-signing.ts` | `submitMemoryCanonical(...)` |
| Hub | `wevibe-server/wevibe-hub/internal/verify/canonical.go` | `SubmitMemoryMessage(...)` |
| Chain | `wevibe-chain/x/memory/keeper/msg_server.go` | `buildSubmitMemoryCanonicalBody(...)` |
| Chain (query) | `wevibe-chain/x/reputation/keeper/grpc_query.go` | `buildSubmitMemoryCanonicalBody(...)` |

All emit a 10-line UTF-8 byte sequence: domain tag `wevibe.submit_memory.v1` followed by 9 alphabetically-sorted key/value pairs joined by `\n`. The locking test is `wevibe-server/wevibe-hub/internal/verify/canonical_test.go::TestCanonicalBodyCrossLanguageConformance` across three test vectors.

### Cross-module data flow

```
Contributor (MCP or Dashboard)
  ├── generate salt (32 random bytes)
  ├── plaintext_hash    = sha256(salt || plaintext_utf8)
  ├── ciphertext_hash   = sha256(ciphertext)
  ├── wrapped_dek_hash  = sha256(wrapped_dek_mod)
  ├── submission_hash   = sha256(ciphertext || wrapped_dek_mod)
  ├── canonical body    = 9-field assembly (see above)
  └── contributor_sig   = Ed25519(privkey, canonical_body)

POST /v1/orgs/{orgID}/submit (NO plaintext field)
  → wevibe-hub
       ├── validates plaintext_hash & salt are 64 hex chars
       ├── re-verifies ed25519 sig over reconstructed canonical body
       ├── re-derives ciphertext_hash, wrapped_dek_hash, submission_hash
       └── INSERT pending_submissions (incl. plaintext_hash, salt,
                                       ciphertext_hash, wrapped_dek_hash)

Leader vote → verify-keywords → /moderation/batch-submit
  → wevibe-hub batch handler
       ├── SELECT pending_submissions.{wrapped_dek_mod, plaintext_hash,
       │          salt, ciphertext_hash, contributor_sig, ...}
       ├── populate BatchMemory (incl. D-VR-5 fix:
       │   BatchMemory.WrappedDekEnc = hex.Decode(wrapped_dek_mod))
       └── chain.SubmitMemoryToChain → MsgApproveMemory{..., plaintext_hash,
                                                       salt, ciphertext_hash,
                                                       contributor_sig}

wevibe-chain MsgApproveMemory keeper
  ├── compute wrapped_dek_hash = sha256(wrapped_dek_enc)
  ├── compute submission_hash  = sha256(blob || dek_enc)
  ├── reconstruct canonical body (4 hash inputs + epoch + pubkey + memory_type + org_id)
  ├── ed25519.Verify(contributor_pubkey, canonical_body, contributor_sig)
  ├── assert sha256(blob) == msg.CiphertextHash
  ├── assert sha256(blob||dek_enc) == msg.ContentHash
  └── On success: persist StoredMemoryCommitment with plaintext_hash, salt,
                  ciphertext_hash, wrapped_dek_hash, contributor_sig
      On failure: reject this memory only; partial-batch-success applies.

External verifier (e.g. moderator with decryption capability)
  → /wevibe/reputation/v1/verify_upheld_report/{org_id}/{content_hash}
       returns: plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash,
                contributor_sig, contributor_pubkey, encrypted_blob,
                wrapped_dek_enc, content_hash, org_id, epoch, memory_type,
                canonical_body
  Holding (plaintext, salt), verify 5 invariants client-side:
       1. sha256(salt || plaintext)            == plaintext_hash
       2. sha256(encrypted_blob)                == ciphertext_hash
       3. sha256(wrapped_dek_enc)               == wrapped_dek_hash
       4. sha256(blob || dek_enc)               == content_hash
       5. ed25519.verify(pubkey, body, sig)     holds
```

### Load-bearing bug fixes shipped with CO-029

- **D-VR-5** (`wevibe-server/wevibe-hub/internal/api/handlers/moderation.go:780`):
  `BatchMemory.WrappedDekEnc` is now populated from
  `pending_submissions.wrapped_dek_mod`. Before CO-029 it was nil on every
  memory, which broke chain-side `wrapped_dek_hash` derivation.

- **D-VR-6** (`wevibe-server/wevibe-hub/internal/orgs/orgs.go`):
  `BufferSubmission` and `FinalizeRotationBuffer` now call
  `verify.RequestSignature` over the 9-field canonical body BEFORE inserting
  into `rotation_buffer` or flushing to `pending_submissions`. Pre-CO-029,
  rotation-buffer rows were stored without sig verification.

- **D-VR-7** (`wevibe-server/wevibe-dashboard/lib/wevibe-submit.ts`):
  The dashboard no longer sends `plaintext` to the hub. The submit payload
  carries `plaintext_hash` + `salt` instead. The `Plaintext` field was also
  removed from `SubmitMemoryRequest` in `wevibe-hub/internal/protocol/types.go`
  per R-ONE-PATH.

### Inter-module contracts changed by CO-029

- **wevibe-protocol** test vectors expanded for canonical-body byte equality
  (covered by `wevibe-server/wevibe-hub/internal/verify/canonical_test.go`).
- **MCP and Dashboard** outbound payloads added four hash fields and removed
  the plaintext field.
- **Hub HTTP intake** added field-presence validation + signature/hash
  verification per the chain above.
- **Hub → Chain** added 4 new fields on `MsgApproveMemory` (tags 9–12).
- **Chain state** added 5 new fields on `StoredMemoryCommitment` (tags 15–19).
- **Reputation query** `VerifyUpheldReport` response gained 12 new fields
  including the reconstructed `canonical_body` bytes.

### Sanitization

For CO-029 the hub never sees plaintext, so it no longer runs Unicode
sanitization at intake. `pending_submissions.sanitization_findings` is null at
intake. Moderator-decrypt-time sanitization is a Sprint 32 deliverable; the
existing Findings response shape is preserved but is returned empty.

### Architecture invariants reinforced by CO-029

- R-ONE-PATH: the `Plaintext` field is removed everywhere; there is no
  dual-handling code path.

---

## Sprint 32 — CO-033b: Serve submission chain live

Cross-module serve flow is now wired end-to-end:

1. `wevibe-opencode-plugin/plugins/wevibe-plugin.ts` reads recall `matched_keywords` and posts them to MCP `/v1/serves`.
2. `wevibe-mcp/src/http-server.ts` enforces non-empty `matched_keywords` and forwards to hub `POST /v1/orgs/{orgID}/serves`.
3. Hub persists serve events with `matched_keywords` in `serve_events`.
4. Hub `GET /v1/orgs/{orgID}/submissions?status=pending_chain` now includes `matched_keywords` by joining `serve_events` (latest serve record by `serve_key=submission_hash`).
5. Dashboard chain submit (`app/(dashboard)/chain-submit/page.tsx`) builds `MsgSubmitServeBatch` from the real `matched_keywords` field only (no extraction-result proxy path).

Operational verification:
- `make dogfood` passed Stage 1 service health (5/5) and Stage 2 dogfood pipeline (4/4), including leader batch chain submit and MCP recall.
- R-NO-NEW-SERVICES: no new Docker services were added. Container topology
  remains at the seven services plus the pre-existing `wevibe-social-graph`.
- R-NO-SP1-RESIDUE: no SP1 / zkVM / Groth16 references in production code.

See `wevibe-meta/workspace/reports/CO-029-implementation-report.txt` for the
full implementation report and the Stage 6 honest + adversarial test outputs.
