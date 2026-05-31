# WeVibe Memory Type Migration — Context Diff

**Migration:** Single memory type with internal `implement`/`dnd` fields (replaces dual-type enum)
**Files touched:** `wevibe-docs/MASTER.md`, `wevibe-docs/DECISIONS.md`
**Reason:** The old dual-type system forced every memory into one of two mutually exclusive buckets. In reality, a single memory often contains both "what to do" (implement) and "what not to do" (dnd). The new design encodes both signals inside a single memory blob, with client-side filtering by field presence.

---

## What Changed

### 1. Protocol Level — MemoryType Enum

**OLD:**
```protobuf
// wevibe-chain/proto/wevibe/memory/v1/state.proto
enum MemoryType {
  MEMORY_TYPE_UNSPECIFIED = 0;
  MEMORY_TYPE_CORRECT_IMPLEMENTATION = 1;  // "what to do"
  MEMORY_TYPE_NEGATIVE_SIGNAL = 2;         // "what NOT to do"
}
```

**NEW:**
```protobuf
enum MemoryType {
  MEMORY_TYPE_UNSPECIFIED = 0;
  MEMORY_TYPE_MEMORY = 1;  // single type; implement/dnd are internal fields
}
```

The chain still has a `MemoryType` field on stored memories. It now has one valid value (`MEMORY_TYPE_MEMORY`). The `implement`/`dnd` distinction lives inside the encrypted blob — the chain never sees it.

---

### 2. Encrypted Blob Content Schema

**OLD:** (inside encrypted blob)
```json
{
  "insight": "string",
  "context": "string",
  "avoid": "string | null",
  "memory_type": "correct_implementation | negative_signal",
  "stack": ["tech1"],
  "preference_confidence": 0.0
}
```

**NEW:**
```json
{
  "implement": "string (required) — what to do and how",
  "dnd": "string (optional, can be null) — what not to do and why",
  "context": "string",
  "stack": ["tech1"],
  "preference_confidence": 0.0
}
```

The `insight` field is gone (replaced by `implement`). `avoid` is replaced by `dnd`. `memory_type` field inside the blob is removed — type is now at the protocol level, not inside the blob.

---

### 3. Risk Appetite Filtering

**OLD:**
```
risk_appetite = "lowest"  →  keep only memories where memory_type == "negative_signal"
risk_appetite = "neutral" →  keep all memories (both types)
```

**NEW:**
```
risk_appetite = "lowest"  →  keep only memories where dnd !== null (DND warnings only)
risk_appetite = "neutral" →  keep all memories regardless of dnd value
```

Filtering is done client-side (wevibe-mcp) at the field level, not the type level. A memory with `dnd: null` and `dnd: "don't do X"` are treated differently under `lowest`; both are returned under `neutral`.

---

### 4. Canonical Body — memory_type Field

**OLD:** (in `wevibe.submit_memory.v1` canonical body)
```
memory_type:<correct_implementation|negative_signal>
```

**NEW:**
```
memory_type:memory
```

Both the current canonical body and the replacement (9-field) canonical body use `memory_type:memory`. This change is in D-VR-3 section of DECISIONS.md.

---

### 5. Extraction Prompt (wevibe-mcp/src/extraction.ts)

**OLD extraction rules:**
- Include `"avoid"` when there is negative knowledge
- Set `memory_type` to exactly one of: `"correct_implementation"` | `"negative_signal"`
- Do NOT use any third category

**NEW extraction rules:**
- Output `implement` (required) and `dnd` (optional, can be null) as separate fields
- Single `memory` type at protocol level
- No binary type classification at extraction time

---

### 6. Moderation Validation (wevibe-server/wevibe-hub/internal/api/handlers/moderation.go)

**OLD:**
```go
// validation: memory_type must be one of: correct_implementation, negative_signal
if !protocol.IsValidMemoryType(memoryType) { ... }
```

**NEW:** (implicit — type is always `memory`, validation on internal `implement`/`dnd` fields is TBD in implementation CO)

---

## What Was Scrubbed

| Location | Old Reference | Status |
|----------|---------------|--------|
| MASTER.md line 409 | `Memory type (correct_implementation or negative_signal)` | Removed |
| MASTER.md line 547 | `if set to lowest, keeps only negative_signal memories` | Replaced with field-level filter |
| MASTER.md line 691 | `lowest = negative_signal only, neutral = both` | Replaced with DND-field description |
| MASTER.md line 707 | `both correct_implementation and negative_signal memories surfaced` | Replaced |
| MASTER.md line 708 | `only negative_signal memories are shown in approval UI` | Replaced |
| DECISIONS.md D-5.1 (section header) | `Two Memory Types Only` | Replaced with `Single Memory Type with Internal Do/DND Distinction` |
| DECISIONS.md D-5.1 (body) | 6-paragraph "Why" explaining the rejection of a third type | Replaced with new decision rationale |
| DECISIONS.md D-VR-3 canonical body (2 places) | `memory_type:<correct_implementation\|negative_signal>` | Replaced with `memory_type:memory` |
| DECISIONS.md line 580 | Historical reference in paragraph explaining old design | Kept (historical context, not live reference) |

---

## Files That Need Implementation Updates (Not Changed Yet)

These files contain references to the old dual-type system and will need updating in a subsequent CO:

| File | What to update |
|------|----------------|
| `wevibe-chain/proto/wevibe/memory/v1/state.proto` | `enum MemoryType` — replace two-variant enum with single `MEMORY_TYPE_MEMORY = 1` variant |
| `wevibe-chain/x/memory/types/state.pb.go` | Regenerated from proto; mirrors the enum change |
| `wevibe-chain/x/memory/types/memory_types.go` | `ValidMemoryType()` — currently checks two variants; will become trivial (always `true` for `memory`) |
| `wevibe-chain/x/memory/keeper/msg_server.go` | `canonicalMemoryType()` switch — currently maps two variants; needs update |
| `wevibe-chain/x/reputation/keeper/grpc_query.go` | `MemoryType` switch cases (2 variants → 1) |
| `wevibe-server/wevibe-hub/internal/protocol/types.go` | `MemoryTypeCorrectImplementation` / `MemoryTypeNegativeSignal` constants — replace with single `MemoryTypeMemory` |
| `wevibe-server/wevibe-hub/internal/api/handlers/moderation.go` | Validation error message and batch result errors referencing dual types |
| `wevibe-server/wevibe-dashboard/lib/wevibe-submit.ts` | `SubmitMemoryParams.memory_type` — currently typed as `'correct_implementation' \| 'negative_signal'` |
| `wevibe-mcp/src/types.ts` | `MemoryType` type — currently `'correct_implementation' \| 'negative_signal'` |
| `wevibe-mcp/src/extraction.ts` | `isMemoryType()` check and extraction prompt — update for single type + implement/dnd fields |
| `wevibe-mcp/src/canonical.ts` | `memory_type` field in canonical body construction |
| `wevibe-mcp/src/moderation.ts` | Type validation and approval payload construction |

---

## Decision Record (DECISIONS.md D-5.1 — New)

```
### D-5.1: Single Memory Type with Internal Do/DND Distinction

**Decision:** Memories carry one type: `memory` (the only type). Within each memory,
two fields quantify the content:
- `implement` (required) — what TO do and how, describes the correct pattern
- `dnd` (optional, can be null) — what NOT to do and why

The `dnd` field being null or non-null is the signal used for consumer-side risk
appetite filtering. Memories with a non-null `dnd` field are DNDs; memories with a
null `dnd` field are pure implementations.

**Why single type with internal DND flag:**
1. Knowledge is not mutually exclusive — implement + dnd coexist in one memory
2. Risk appetite filtering works at the field level, not the type level
3. Extraction produces cleaner output — LLM emits both fields independently
4. Moderation is simpler — one type, not binary classification
5. Chain state is simpler — one `MemoryType` enum variant, no type proliferation

**Risk appetite filtering logic:**
- `lowest` → only memories where `dnd !== null` (DND warnings only)
- `neutral` → all memories regardless of `dnd` value
```

---

## Canonical Body (D-VR-3) — Updated Reference

```
wevibe.submit_memory.v1
ciphertext_hash:<hex>
contributor_pubkey:<hex>
epoch_id:<int>
memory_type:memory          ← was: <correct_implementation|negative_signal>
org_id:<string>
plaintext_hash:<hex>
salt:<hex>
submission_hash:<hex>
wrapped_dek_hash:<hex>
```

---

## Retrieval Flow (Consumer-Side)

```
Consumer query → Hub → Qdrant (vector+keyword search)
                              ↓
                     All memories returned (unfiltered by type)
                              ↓
                    wevibe-mcp decrypts each blob
                              ↓
              risk_appetite filter applied at field level:
                if lowest → keep only where dnd !== null
                if neutral → keep all
                              ↓
              wevibe-guard scan → approval UI → injection
```

No change to Hub or Qdrant behavior. Filter is purely client-side on the decrypted blob fields.

---

## Gap Closed

**Old gap:** Memory type was a binary protocol-level classification that couldn't represent a memory that was both "do this" and "don't do this." Contributors had to choose one. The `avoid` field existed inside the blob but had no protocol-level signal to drive consumer filtering — risk appetite had to map binary types to behavior, which was a semantic mismatch.

**New design:** Single type `memory` at protocol level. Both `implement` and `dnd` are first-class fields inside every memory blob. The `dnd` field's null/non-null state IS the consumer filter signal. A memory with both fields populated is a "full guidance" memory — it surfaces under `neutral` risk appetite; under `lowest`, only the DND aspect is shown.