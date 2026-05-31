MASTER ORDER — CO-041: cachekv Iterator Correctness + Tokenomics Overhaul (Emissions Schedule, Contributor Attribution)
LLM Capability Tag: HIGH
Date: 2026-05-30
Sprint: Sprint 32 — Memory Decay: Earned Trust + Probabilistic Retrieval
Packages: wevibe-chain (x/emissions, x/memory, x/serve, x/org, x/reputation, app, scripts, proto)
Base directory: /Users/jerrysmith/Desktop/wevibe-workspace
Languages: Go

EXECUTION DIRECTIVE
This order contains 11 tasks across 9 stages. Tasks are classified SEQUENTIAL or PARALLEL in the table below. You MUST use the task tool to execute all PARALLEL groups concurrently. Sequential tasks must complete fully before the next sequential stage begins.

| Order | Task                                                  | Depends On  | Execution Mode        |
|-------|-------------------------------------------------------|-------------|-----------------------|
| 1     | Task A — cachekv iterator correctness sweep           | —           | SEQUENTIAL            |
| 2     | Task B — Proto changes + proto-gen                    | Task A      | SEQUENTIAL            |
| 3     | Task C — Emissions keeper overhaul (32yr schedule)    | Task B      | PARALLEL with Task D  |
| 3     | Task D — Memory contributor_address persistence       | Task B      | PARALLEL with Task C  |
| 4     | Task E — Memory contributor-by-epoch query            | Tasks C, D  | SEQUENTIAL            |
| 5     | Task F — Serve attribution from stored memory         | Task E      | SEQUENTIAL            |
| 6     | Task G — Init-chain.sh genesis allocations            | Task F      | PARALLEL with Task H  |
| 6     | Task H — Emissions genesis re-plumbing (new pool)     | Task F      | PARALLEL with Task G  |
| 7     | Task I — Build + test gate                            | Tasks G, H  | SEQUENTIAL            |
| 8     | Task J — 40-epoch smoke test                          | Task I      | SEQUENTIAL            |
| 9     | Task K — 300-epoch seed 42 measurement (GATE)         | Task J      | SEQUENTIAL            |

Parallel execution rules:
- Tasks in the same stage with no shared file writes MUST be launched simultaneously using the task tool.
- If two tasks touch the same file, they are SEQUENTIAL regardless of the table — stop and flag in the report.
- Do NOT serialize tasks marked PARALLEL. Each parallel subtask must produce its own verification output, captured in the report.

After all tasks complete: run Phase 4 verification, produce the consolidated implementation report at the specified path, and STOP for manager approval before Phase 5.

STANDING RULES — READ BEFORE ANY IMPLEMENTATION
R-LONGEVITY, R-ONE-PATH, R-OVERHAUL, R-ABORT, R-TEST-OUTPUT, R-REPORT, R-NO-SKIP, R-PARALLEL, R-PROTO-REGEN, R-DIAGNOSE-WITH-LOGS, R-REMOTE-PREFLIGHT — all apply (full text in AGENTS.md and the CO template).

CO-specific standing rules:

**R-COMPILE-GATE:** `go build ./cmd/wevibed` must succeed after each stage before proceeding.

**R-NO-PARAM-CHASE:** If Task K (seed 42) fails the sprint contract, capture the result and STOP. Do not tune decay parameters to chase the number. A failing contract after a correct implementation is a design signal for the manager, not a knob to twist.

**R-EPOCH-HOOK-RESILIENCE:** No epoch hook may return a non-nil error for a recoverable condition. All recoverable failures (missing data, empty iteration, no qualifying contributors) MUST log a warning and return nil. This protects the Cosmos SDK epoch dispatcher's cached-write batch from rollback. (Implemented in CO-040; preserve it.)

**R-CACHEKV-ITER (NEW — the central correctness rule of this CO):**
`cosmossdk.io/store@v1.1.2` `cachekv/internal/mergeiterator.go` defines:
```go
func (iter *cacheMergeIterator) Error() error {
    if !iter.Valid() { return errors.New("invalid cacheMergeIterator") }
    return nil
}
```
On a cache-wrapped KV store (the store used inside BeginBlock / epoch hooks / any
branched tx context), `iter.Error()` returns a NON-NIL error at NORMAL
end-of-iteration. Direct IAVL stores (used by unit tests) return nil at end, which
is why this bug is invisible to the existing test suite.

Therefore:
1. NEVER use the post-loop pattern `for iter.Valid() {…}; if err := iter.Error(); err != nil { return err }`. The `Valid()` loop already terminates correctly on exhaustion; a genuine parent-store error surfaces as a panic via `assertValid()` inside `Next()`/`Key()`/`Value()`. Delete these post-loop `iter.Error()` error-return blocks.
2. NEVER write to or delete from a store while iterating that same store under a cachekv context. Use collect-then-mutate: gather keys/values during iteration, `Close()` the iterator, THEN mutate.
3. Any NEW iteration added by this CO (e.g. the contributor-by-epoch query) MUST follow rules 1 and 2 from the start.

---

CONTEXT — WHAT THIS ORDER IS AND WHY

CO-040 (predecessor, assumed merged) seeded the emission pool at genesis, activated
the reputation module, wired `module.HasGenesis` for both, and made the emissions
and memory epoch hooks return nil on recoverable conditions. Those four deliverables
are correct and tested. But CO-040's empirical gate failed, and the resilience
change exposed the true root cause of the Sprint-31 "zero decay" symptom:

Every epoch-end iteration on the live chain fails with `invalid cacheMergeIterator`.
`ApplyEpochDecay`, `CheckEpochExpiry`, `getAllOrgsWithMemories`, and the emissions
hook's `GetAllOrgs` all run inside the BeginBlock cache context, where the keepers'
`iter.Error()`-as-failure pattern misreads normal end-of-iteration as an error. The
decay observed in CO-040's smoke (bad persistence 0.0833) came ENTIRELY from the
event-time serve/denial path; epoch-end idle decay never ran. CO-040's pool seeding
made this visible because the emissions hook previously bailed at "no emission pool
found" before reaching the broken iterations.

This is a pre-existing, systemic defect: the `iter.Error()` false-failure pattern
exists at 24 sites across 10 keeper files in 4 modules. It must be fixed first,
because the tokenomics overhaul below ADDS a new network-wide approved-memory
iteration (contributor emission distribution) that would hit the exact same bug.

This order also rolls in the tokenomics overhaul that was deferred out of CO-040
("CO-040b"): the real 32-year emission schedule, validator/contributor pools with a
global rollover, contributor address persisted through memory state, and serve
attribution derived from the stored memory record. The manager's directive: design
it properly with cascading effects mapped (see "Cascade map" below).

Tokenomics (locked for this CO):
```
Total supply:           1,000,000,000 VIBE   (1,000,000,000,000,000 uvibe)
Foundation genesis:     10%  = 100,000,000 VIBE    (unlocked at genesis)
Validator genesis:      1%   = 10,000,000 VIBE     (to docker validator)
Contributor 32yr pool:  1%/yr × 32yr = 320,000,000 VIBE
Validator 32yr pool:    remainder = 570,000,000 VIBE (emitted over 32 years)
Contributor emission:   10,000,000 VIBE/year cap, split evenly among qualifying contributors
Qualifying:             ≥ contributor_qualify_threshold approved memories network-wide per epoch
Rollover:               global bucket — if nobody qualifies, the budget rolls forward
Denom:                  uvibe (10^6 per VIBE)
```

What is verified as correct (relied upon):
- CO-040 wired `module.HasGenesis` for emissions + reputation; both seed state at genesis. `x/emissions/types/genesis.go` already has `DefaultEmissionPool()` / `DefaultGenesis()` derived from `DefaultParams()`. `scripts/init-chain.sh` seeds `app_state.emissions = {}` and `app_state.reputation = {"active": true}`.
- Emissions keeper has `MintDailyEmission`, `ProcessOrgPayouts`, `GetEmissionPool`/`SetEmissionPool`, conversion helpers in `x/emissions/types/keys.go`.
- `MsgSubmitCommitment` has `contributor_wallet = 6` (`proto/wevibe/memory/v1/tx.proto:25`).
- `StoredPendingCommitment` max field = 7; `StoredMemoryCommitment` max field = 22 (`proto/wevibe/memory/v1/state.proto`). Emissions `Params` max field = 7; `StoredEmissionPool` max field = 5.
- Serve keeper calls `k.reputationKeeper.RecordServe(ctx, []byte(serve.ContributorWallet), orgID, epoch, isSelfServe)` at `x/serve/keeper/keeper.go:276`.
- Memory `SubmitCommitment` persists `msg.ContributorId` (`x/memory/keeper/msg_server.go:39`); `ApproveMemory` builds `StoredMemoryCommitment` (`x/memory/keeper/msg_server.go:137`).
- The 24 `iter.Error()` sites (Task A working set):
  - `x/emissions/keeper/keeper.go`: 342, 674, 699, 725, 855, 876, 897, 916, 935, 954
  - `x/memory/keeper/validity.go`: 78 (CheckEpochExpiry — MUTATES during iteration: Delete + saveMemoryCommitment)
  - `x/memory/keeper/lifecycle.go`: 249 (ApplyEpochDecay — MUTATES during iteration: saveMemoryCommitment)
  - `x/memory/keeper/epoch_hooks.go`: 80 (getAllOrgsWithMemories — read-only)
  - `x/memory/keeper/keeper.go`: 528
  - `x/org/keeper/keeper.go`: 340, 969
  - `x/org/keeper/aggregates.go`: 59
  - `x/reputation/keeper/keeper.go`: 322, 352, 379
  - `x/reputation/keeper/leader_profile.go`: 109, 132
  - `x/reputation/keeper/moderator_profile.go`: 98, 121

What could vary:
- Exact line numbers may drift if CO-040's commit reflowed files — locate by pattern, not line number.
- Proto field numbers — use the next available; verify current max before adding.
- The precise SDK `module.HasGenesis` shape is already implemented by CO-040; reuse it.

Cascade map (the manager's "design it properly with cascading effects mapped"):
```
Task A (cachekv fix)
  └─ unblocks: ApplyEpochDecay, CheckEpochExpiry, getAllOrgsWithMemories, GetAllOrgs
  └─ prerequisite for: Task E's new network-wide approved-memory iteration

Task B (proto) — emissions params + StoredEmissionPool + memory state
  ├─ regen → x/emissions/types/{params,state}.pb.go, x/memory/types/state.pb.go
  ├─ cascades to: keys.go conversion helpers, DefaultParams, DefaultEmissionPool,
  │               GetEmissionPool/SetEmissionPool, InitGenesis/ExportGenesis
  └─ cascades to: memory msg_server (submit/approve), memory conversion helpers

Task C (emissions keeper) ── consumes new params/pool fields from B
  └─ needs: contributor-by-epoch query (Task E) via expected_keepers interface

Task D (memory contributor_address) ── consumes new memory proto fields from B
  └─ feeds: Task E (query reads contributor_address), Task F (serve attribution)

Task E (memory contributor-by-epoch query) ── needs A (safe iteration) + D (address)
  └─ wired into emissions keeper (Task C interface) via app.go

Task F (serve attribution) ── needs D (committed memory has contributor_address)
  └─ changes serve keeper RecordServe source; expected_keepers + app.go wiring

Task G (init-chain.sh) ── foundation 10%, validator 1%, emission pool 32yr genesis
Task H (emissions genesis re-plumbing) ── DefaultParams/DefaultEmissionPool/InitGenesis
                                          updated for new pool + params fields
  └─ G and H must agree on the genesis pool shape (coordinate via the JSON schema)
```

---

THE TASKS

Stage 1 — Sequential

Task A — cachekv Iterator Correctness Sweep (CRITICAL)
Execution: SEQUENTIAL
File(s):
- x/emissions/keeper/keeper.go
- x/memory/keeper/validity.go
- x/memory/keeper/lifecycle.go
- x/memory/keeper/epoch_hooks.go
- x/memory/keeper/keeper.go
- x/org/keeper/keeper.go
- x/org/keeper/aggregates.go
- x/reputation/keeper/keeper.go
- x/reputation/keeper/leader_profile.go
- x/reputation/keeper/moderator_profile.go
- NEW: x/memory/keeper/cachekv_iter_test.go (regression test)

Problem: The post-loop `iter.Error()` pattern reports a false failure at normal
end-of-iteration under cache-wrapped stores, breaking every epoch-end iteration on
the live chain. Two memory sites additionally mutate the store while iterating it.

What is known:
- The 24 sites are listed in the CONTEXT block.
- Read-only loops: delete the post-loop `if err := iter.Error(); err != nil { … }` block. The creation error (`iter, err := store.Iterator(...)`) is separate and stays.
- Mutating loops (ApplyEpochDecay in lifecycle.go, CheckEpochExpiry in validity.go): convert to collect-then-mutate.

Implementation:
1. For every read-only `iter.Error()` site, remove the post-loop error-return block. Do NOT remove the `iter, err := store.Iterator(...)` creation check, and do NOT remove `defer iter.Close()`.
2. ApplyEpochDecay (lifecycle.go): in the loop body, collect `(orgID, contentHash, …)` or the full key bytes into a slice; after the loop closes the iterator, load+mutate+`saveMemoryCommitment` per collected item. Preserve exact decay semantics — only the iteration/mutation ordering changes, not the math.
3. CheckEpochExpiry (validity.go): collect the expiring `(key, orgID, memoryCid)` tuples during iteration; after closing, perform `saveMemoryCommitment` (archive) and `store.Delete(key)` per collected tuple.
4. Add x/memory/keeper/cachekv_iter_test.go: a regression test that wraps the test store in a `cachekv.NewStore` (cosmossdk.io/store/cachekv) over the IAVL store so iteration goes through `cacheMergeIterator`, seeds a committed memory, runs `ApplyEpochDecay` (and `AfterEpochEnd`), and asserts (a) no error, (b) the decay persisted. This test MUST fail against the pre-fix code and pass after — verify both.

Cross-module impact: emissions, memory, org, reputation keepers. No proto, no API changes.

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./x/emissions/... ./x/memory/... ./x/org/... ./x/reputation/... -count=1 2>&1
rg -n "iter.Error\(\)" x/*/keeper/*.go
# Expected: only iterator-CREATION checks remain (iter, err := store.Iterator...); zero post-loop Error() error-returns.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies. Instrument, reproduce, analyze, fix, remove. Document the episode.

---

Stage 2 — Sequential

Task B — Proto Changes + Proto-Gen (CRITICAL)
Execution: SEQUENTIAL
File(s):
- proto/wevibe/emissions/v1/params.proto
- proto/wevibe/emissions/v1/state.proto
- proto/wevibe/memory/v1/state.proto

Problem: Emissions params/state don't encode the 32-year schedule, validator/
contributor pools, or rollover. Memory state lacks contributor_address.

What is known: current max field numbers are params=7, StoredEmissionPool=5,
StoredPendingCommitment=7, StoredMemoryCommitment=22. Verify before adding.

Implementation:
1. emissions params.proto — add (next available field numbers): `uint64 total_supply_uvibe`, `uint64 validator_emission_pool_uvibe`, `uint64 contributor_annual_cap_uvibe`, `uint64 schedule_duration_days`, `uint64 contributor_qualify_threshold`. Keep existing fields that ProcessOrgPayouts/work-score still use; do not delete fields still referenced.
2. emissions state.proto — add to StoredEmissionPool: `uint64 validator_pool_remaining_uvibe`, `uint64 contributor_pool_remaining_uvibe`, `uint64 contributor_rollover_uvibe`, `uint64 start_epoch`, `uint64 total_epochs_elapsed`.
3. memory state.proto — `string contributor_address = 23;` on StoredMemoryCommitment; `string contributor_address = 8;` on StoredPendingCommitment.
4. Regenerate (R-PROTO-REGEN): `cd wevibe-chain && make proto-gen`. Do NOT hand-edit *.pb.go. If make proto-gen fails, R-ABORT.
5. Compile gate: `go build ./cmd/wevibed` (expect compile errors only where keys.go conversion helpers reference new fields — those are fixed in Tasks C/D).

Cross-module impact: emissions types (keys.go helpers, params.go, genesis.go), memory types + msg_server. Handled in Tasks C/D/H.

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
make proto-gen
git status --short proto/ x/emissions/types/*.pb.go x/memory/types/state.pb.go
# Expected: only the intended .proto and regenerated .pb.go files changed.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 3 — Parallel Group (launch Task C and Task D simultaneously with the task tool)
These tasks write to disjoint file sets (emissions vs memory). Launch in a single task tool call; each subtask prompt must be fully self-contained.

Task C — Emissions Keeper Overhaul: 32-Year Schedule (CRITICAL)
Execution: PARALLEL (Stage 3)
File(s):
- x/emissions/types/params.go
- x/emissions/types/constants.go
- x/emissions/types/keys.go (EmissionPool struct + Stored<->struct conversion helpers)
- x/emissions/keeper/keeper.go (GetEmissionPool/SetEmissionPool/MintDailyEmission)
- x/emissions/keeper/epoch_hooks.go
- x/emissions/types/expected_keepers.go (declare the contributor-by-epoch interface)

Problem: The keeper implements a flat daily-mint model, not the locked 32-year
schedule with validator/contributor pools, a contributor annual cap, and a global
rollover.

Implementation:
1. DefaultParams(): set TotalSupplyUvibe=1_000_000_000_000_000, ValidatorEmissionPoolUvibe=570_000_000_000_000, ContributorAnnualCapUvibe=10_000_000_000_000, ScheduleDurationDays=11_680 (32*365), ContributorQualifyThreshold=1. Keep existing fields still in use. Add a constants.go entry for EpochsPerYear=365 (and any other locked constants).
2. EmissionPool struct (keys.go) + conversion helpers: add ValidatorPoolRemainingUvibe, ContributorPoolRemainingUvibe, ContributorRolloverUvibe, StartEpoch, TotalEpochsElapsed. Update EmissionPoolToStored / StoredToEmissionPool, GetEmissionPool / SetEmissionPool. Keep EmissionPool.Validate() consistent (operator+validator share still 100 if those fields are retained).
3. Per-epoch emission (overhaul MintDailyEmission or add an epoch-appropriate function called from AfterEpochEnd):
   - remaining_epochs = ScheduleDurationDays - TotalEpochsElapsed (floor at 1).
   - validator emission = ValidatorPoolRemainingUvibe / remaining_epochs; deduct.
   - contributor budget = min(ContributorPoolRemainingUvibe / remaining_epochs, ContributorAnnualCapUvibe / EpochsPerYear); deduct from contributor pool.
   - qualifying = memoryKeeper.GetContributorsWithApprovalsInEpoch(ctx, epoch) filtered to ≥ ContributorQualifyThreshold (the query returns distinct qualifying addresses; see Task E).
   - if len(qualifying)==0: ContributorRolloverUvibe += contributor budget. else: per_contributor = (budget + rollover) / len(qualifying); distribute evenly; ContributorRolloverUvibe = 0 (carry the integer remainder forward into rollover to avoid token loss).
   - StartEpoch set on first emission; TotalEpochsElapsed++. Persist pool.
4. AfterEpochEnd uses the new logic. R-EPOCH-HOOK-RESILIENCE: all recoverable failures log a warning and return nil.
5. expected_keepers.go: add `GetContributorsWithApprovalsInEpoch(ctx context.Context, epoch uint64) ([]string, error)` to MemoryKeeper interface (implemented in Task E; app.go wiring in Task E).
6. Unit tests: cover schedule math (validator + contributor per-epoch), the cap, rollover-when-nobody-qualifies, even split + remainder carry, and pool depletion at end of schedule.

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./x/emissions/... -count=1 -v 2>&1
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

Task D — Memory contributor_address Persistence (CRITICAL)
Execution: PARALLEL (Stage 3)
File(s):
- x/memory/keeper/msg_server.go
- x/memory/types/ (conversion helpers between Stored* and domain structs, if any)

Problem: `contributor_wallet` from MsgSubmitCommitment is not persisted through
pending → committed memory state, so serve attribution and contributor emissions
have no address to credit.

Implementation:
1. SubmitCommitment handler: persist `msg.ContributorWallet` into StoredPendingCommitment.ContributorAddress (new field 8). (Continue persisting ContributorId as today.)
2. ApproveMemory handler: copy pending.ContributorAddress into StoredMemoryCommitment.ContributorAddress (new field 23) when constructing storedApproved.
3. Update any Stored<->domain conversion helpers to carry ContributorAddress.
4. Unit tests: submit→pending carries the address; approve→committed carries it; round-trip through GetApprovedMemory exposes ContributorAddress.

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./x/memory/... -count=1 -v 2>&1
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 4 — Sequential (requires Stage 3 complete)

Task E — Memory Contributor-by-Epoch Query (CRITICAL)
Execution: SEQUENTIAL
File(s):
- x/memory/keeper/ (new method, likely in lifecycle.go or a new query helper file)
- app/app.go (verify emissions keeper receives the memory keeper that implements the new method)

Problem: Emissions (Task C) needs the set of distinct contributor addresses with
≥ threshold approved memories network-wide in a given epoch. This is a NEW network-
wide iteration over approved memories and MUST follow R-CACHEKV-ITER.

Implementation:
1. Add `GetContributorsWithApprovalsInEpoch(ctx context.Context, epoch uint64) ([]string, error)` to the memory keeper. Iterate the `approved/` prefix using the Task-A-corrected pattern (NO post-loop iter.Error(); read-only so no collect-then-mutate needed). For each committed memory with ApprovedAtEpoch == epoch (and not archived/denied), count by ContributorAddress; return the sorted distinct addresses meeting the threshold. The threshold filtering may live here or in emissions — keep it in emissions (Task C) and return per-address counts via a map, OR return distinct addresses and let emissions apply the threshold. Choose one and document it; do not split the logic ambiguously.
2. Confirm the method satisfies the emissions `MemoryKeeper` interface (Task C). Verify app.go passes `app.MemoryKeeper` to `emissionskeeper.NewKeeper` (it already does) so the interface resolves at compile time.
3. Unit tests (cachekv-wrapped per R-CACHEKV-ITER): contributors with approvals in the epoch are returned; contributors below threshold excluded; empty epoch returns empty (no error).

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./x/memory/... ./x/emissions/... -count=1 -v 2>&1
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 5 — Sequential (requires Stage 4 complete)

Task F — Serve Attribution from Stored Memory (MEDIUM)
Execution: SEQUENTIAL
File(s):
- x/serve/keeper/keeper.go
- x/serve/types/expected_keepers.go (if a memory lookup interface is needed)
- app/app.go (wire memory keeper into serve keeper if not already available)

Problem: Serve attribution trusts the serve payload's wallet
(`serve.ContributorWallet`) rather than the authoritative committed memory record.

Implementation:
1. In the serve path that calls `reputationKeeper.RecordServe` (keeper.go:276), look up the served memory's ContributorAddress from the memory keeper (by org + content hash) and use THAT in RecordServe instead of `serve.ContributorWallet`.
2. If the serve keeper lacks a memory-lookup interface, add a minimal `MemoryKeeper` interface to x/serve/types/expected_keepers.go (e.g. `GetApprovedMemory`/`GetContributorAddress(ctx, orgID, contentHash) (string, error)`) and wire `app.MemoryKeeper` into the serve keeper in app.go.
3. Preserve self-serve detection and all other RecordServe arguments.
4. Unit tests: serve of a memory credits the memory's ContributorAddress, not the payload wallet; missing memory → recoverable (log + skip per existing serve error policy, do not crash the serve path).

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./x/serve/... ./x/memory/... -count=1 -v 2>&1
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 6 — Parallel Group (launch Task G and Task H simultaneously with the task tool)
G writes scripts/init-chain.sh; H writes x/emissions/types. Disjoint files. Coordinate ONLY via the agreed genesis JSON schema documented below.

Task G — Init-Chain.sh Genesis Allocations (CRITICAL)
Execution: PARALLEL (Stage 6)
File(s):
- scripts/init-chain.sh

Problem: init-chain.sh allocates dev-arbitrary balances and seeds an empty
emissions object. It must encode the locked genesis allocations and the full 32-year
pool.

Implementation:
1. Foundation account: add a genesis account holding 100_000_000_000_000 uvibe (10%). Use a deterministic dev mnemonic (LOCAL DEV ONLY), key name "foundation", same pattern as hub-submitter.
2. Validator: set the validator genesis balance to 10_000_000_000_000 uvibe (1%); adjust gentx self-delegation proportionally (must remain ≥ DefaultPowerReduction).
3. Replace the `app_state.emissions = {}` seed with the full pool JSON agreed with Task H (emission_pool.validator_pool_remaining_uvibe = 570_000_000_000_000, contributor_pool_remaining_uvibe = 320_000_000_000_000, contributor_rollover_uvibe = 0, start_epoch = 0, plus the existing operator/validator share fields if retained). Keep `app_state.reputation = {"active": true}`.
4. Keep the funded hub-submitter account for chain fees.

Build + test:
```
# init-chain.sh is exercised by the Docker fast stack in Task J. Here, lint only:
bash -n /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain/scripts/init-chain.sh
# Expected: no syntax errors.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

Task H — Emissions Genesis Re-Plumbing for New Pool (CRITICAL)
Execution: PARALLEL (Stage 6)
File(s):
- x/emissions/types/genesis.go (DefaultEmissionPool / DefaultGenesis / Validate)
- x/emissions/keeper/keeper.go (InitGenesis / ExportGenesis pool round-trip)
- x/emissions/module/module.go (InitGenesis seeds new fields)

Problem: CO-040's DefaultEmissionPool only set the flat daily-mint fields. With the
new pool fields it must seed the 32-year pools so the chain starts with the locked
schedule.

Implementation:
1. DefaultEmissionPool(): populate ValidatorPoolRemainingUvibe=570_000_000_000_000, ContributorPoolRemainingUvibe=320_000_000_000_000, ContributorRolloverUvibe=0, StartEpoch=0, TotalEpochsElapsed=0 (derive from DefaultParams where possible; DefaultParams remains the single source of truth for the schedule constants).
2. Ensure InitGenesis (module + keeper) persists the full pool, and ExportGenesis round-trips it. The agreed JSON schema MUST match Task G's seed exactly (field names = proto JSON names).
3. Update CO-040's genesis unit tests for the new fields; add assertions that the seeded pool carries the 32-year amounts.

Build + test:
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./x/emissions/... -count=1 -v 2>&1
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 7 — Sequential

Task I — Build + Test Gate (CRITICAL)
Execution: SEQUENTIAL
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./... -count=1 2>&1

# cachekv pattern fully removed (only creation checks remain)
rg -n "iter.Error\(\)" x/*/keeper/*.go
# Expected: zero post-loop Error() error-returns.

# contributor_address present
rg -n "ContributorAddress|contributor_address" x/memory/types/state.pb.go
# Expected: present on both Stored* messages.

# new pool/params fields present
rg -n "ValidatorPoolRemaining|ContributorPoolRemaining|ContributorRollover|ContributorAnnualCap|ScheduleDurationDays" x/emissions/types/*.pb.go
# Expected: present.

# diagnostics removed
rg -n "\[CO-041-DIAG\]" . -g '!.git'
# Expected: zero.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 8 — Sequential

Task J — 40-Epoch Smoke Test (CRITICAL)
Execution: SEQUENTIAL
```
cd /Users/jerrysmith/Desktop/wevibe-workspace
make dogfood-fast-down
make docker-up-fast

# epoch hooks must run cleanly now — no cacheMergeIterator, no missing pool
docker compose -f wevibe-server/docker-compose.yml logs wevibe-chain 2>/dev/null \
  | rg -i "cacheMergeIterator|no emission pool|apply epoch decay failed|failed to get orgs"
# Expected: zero matches.

cd wevibe-meta/scripts/empirical_replay && go build -o /tmp/co-041-replay .
REPLAY_TOTAL_EPOCHS=40 ORG_ID="co041-smoke-$(date +%s)" /tmp/co-041-replay 2>&1 | tee /tmp/co-041-smoke.log
```
Gate: bad persistence < 0.8824 (CO-037 broken-semantics baseline at 40 epochs) AND
good survival materially higher than CO-040's 0.2841 (epoch decay now protects served
good memories). If the chain logs still show cacheMergeIterator, Task A is incomplete —
R-ABORT.
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

Stage 9 — Sequential

Task K — 300-Epoch Seed 42 Measurement (CRITICAL, GATE)
Execution: SEQUENTIAL
```
cd /Users/jerrysmith/Desktop/wevibe-workspace
make dogfood-fast-down
make docker-up-fast
ORG_ID="co041-s42-$(date +%s)" /tmp/co-041-replay 2>&1 | tee /tmp/co-041-seed42.log
cd wevibe-meta && node scripts/sim-baseline-extract.js 2>&1 | tee /tmp/co-041-sim-baseline.log
```
Contract: chain.gap ≥ 75pp AND |Δ gap| ≤ 5pp.
Gate: if FAIL, per R-NO-PARAM-CHASE capture the result and STOP. Do not run multi-seed.
If PASS: run seeds 1, 7, 13 with the same pattern and record a seed summary table.
If stuck: R-DIAGNOSE-WITH-LOGS applies.

---

PHASE 4: VERIFICATION
```
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./... -count=1 2>&1

rg -n "iter.Error\(\)" x/*/keeper/*.go
# Expected: zero post-loop Error() error-returns (only iterator-creation checks remain).

rg -rn "ApplyIdleDecay" . --glob '*.go' -g '!.git'
# Expected: zero.

ls -la /tmp/co-041-seed42.log /tmp/co-041-sim-baseline.log

# MANDATORY: all diagnostic logging removed.
grep -rn "\[CO-041-DIAG\]" /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain \
                           /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server \
                           /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-social-graph \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=target \
  --exclude-dir=dist --exclude-dir=.git 2>&1
# Expected: zero matches.
```

REPORT FORMAT
Save to: /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta/workspace/reports/CO-041-implementation-report.txt
Follow the CO-template report structure: Environment, Execution Plan, per-stage
Changes + verbatim Verification Output, Diagnostic Logging Episodes (or "None"),
table, and Summary. Capture ALL test output verbatim (R-TEST-OUTPUT).

**⏸ STOP HERE. Submit report and wait for manager approval before Phase 5.**

---

PHASE 5: DOCUMENTATION UPDATE (after manager approval)
- wevibe-meta/workspace/docs/TOPOLOGY.md — emissions 32-year schedule, contributor attribution flow, the cachekv iteration correctness fix.
- wevibe-chain/x/emissions/docs/ (if present) — tokenomics summary + schedule math.
- wevibe-chain/x/memory/docs/ (if present) — contributor_address field + contributor-by-epoch query.
- wevibe-docs/DECISIONS.md — lock the tokenomics constants and the R-CACHEKV-ITER pattern as decision blocks (D-S32-*).

PHASE 6: COMMIT & PUSH
Git identity: Morfasco / agilefox22@icloud.com. R-REMOTE-PREFLIGHT applies. Pre-commit

PHASE 7: FORWARD GATHER
No forward gather unless the manager specifies one when approving.

GIT
```
CO-041: cachekv iterator correctness + tokenomics overhaul

- Fix iter.Error()-as-failure pattern across emissions/memory/org/reputation
  keepers (cacheMergeIterator returns non-nil at normal end-of-iteration under
  cache-wrapped stores); collect-then-mutate in ApplyEpochDecay + CheckEpochExpiry
- Add cachekv-wrapped regression test proving epoch decay persists on the live store
- Proto: emissions params (total_supply, validator/contributor pools, annual cap,
  schedule duration, qualify threshold), StoredEmissionPool pool-remaining/rollover/
  start_epoch fields, memory contributor_address (pending + committed)
- Emissions keeper: 32-year schedule, validator+contributor per-epoch emission,
  contributor annual cap, global rollover
- Memory: persist contributor_address submit→approve; contributor-by-epoch query
- Serve attribution derives contributor from stored memory record
- Init-chain.sh: 10% foundation, 1% validator, full 32-year emission pool genesis
- Emissions genesis re-plumbed to seed the new pool fields
```
