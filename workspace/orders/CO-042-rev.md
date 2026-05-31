MASTER ORDER — CO-042-rev: Denial Settlement + Decay Calibration (finish the Goldilocks gate)
LLM Capability Tag: HIGH
Date: 2026-05-31
Sprint: Sprint 32 — Memory Decay: Earned Trust + Probabilistic Retrieval
Packages: wevibe-chain (x/memory, x/serve), wevibe-server (wevibe-hub: relay/serves, chain),
          wevibe-meta (scripts/empirical_replay, scripts/sim-calibration.js, workspace/docs)
Base directory: /Users/jerrysmith/Desktop/wevibe-workspace
Languages: Go, JavaScript (Node sim)
STATUS: PRE-MVP with ZERO DAU — all implementations within this order should be made expressly in
consideration of this status. No backwards compatibility. Overhaul the correct thing.

NOTE: This order SUPERSEDES the remaining open work of CO-042 (the original CO-042 master order and its
escalation/continuation/diag reports). The zero-decay root cause has already been DIAGNOSED AND FIXED in a
prior session (see "VERIFIED-CORRECT STATE" below). This order finishes the two remaining problems and runs
the empirical gate. Do NOT re-investigate the zero-signal-guard timing bug — it is fixed and tested.

================================================================================
EXECUTION DIRECTIVE
================================================================================
This order contains 5 tasks across 5 stages. All stages are SEQUENTIAL (each depends on the previous);
there are no parallel groups, because every task operates on the same live replay loop and overlapping
chain/keeper files. Build and test after each task. Run the Phase 4 verification after all tasks. Produce
the consolidated report, then STOP for manager approval before Phase 5/6.

Order  Task                                                         Depends On  Execution Mode
1      Task A — Fix denial no_attestation rejection                 —           SEQUENTIAL
2      Task B — Calibrate decay (good survives, bad decays)         Task A      SEQUENTIAL
3      Task C — Validate/parameterize settlement lag                Task B      SEQUENTIAL
5      Task E — Empirical GATE (steady + multi-regime + seeds)      Task D      SEQUENTIAL

Parallel execution rules: none of these tasks may be parallelized — they share the replay harness and the
same chain keeper files (x/memory, x/serve). Running them concurrently corrupts the gate signal.

R-EFFICIENCY (worker discipline, non-negotiable for this CO): the manager has repeatedly flagged wasted
time on slow/hung test loops. Do NOT leave replays running past their watchdog. ALWAYS pass
`REPLAY_MAX_DURATION_SECONDS` and a bounded `REPLAY_TOTAL_EPOCHS`. Tear the fast stack DOWN
(`make dogfood-fast-down`) the moment a run completes or a task ends. Never idle-wait on a timeout. Fast,
accurate iteration with 100% time efficiency.

================================================================================
STANDING RULES — READ BEFORE ANY IMPLEMENTATION
================================================================================
R-LONGEVITY, R-ONE-PATH, R-OVERHAUL, R-ABORT, R-TEST-OUTPUT, R-REPORT, R-NO-SKIP, R-PARALLEL,
R-PROTO-REGEN, R-DIAGNOSE-WITH-LOGS, R-REMOTE-PREFLIGHT — all apply (full text in CO-TEMPLATE.md).

CO-specific:
**R-COMPILE-GATE:** `go build ./cmd/wevibed` (chain) and `go build ./...` from `wevibe-server/wevibe-hub`
(server) must succeed after each task that touches the respective repo.

**R-CACHEKV-ITER (inherited):** Any NEW store iteration MUST use collect-then-mutate and MUST NOT use a
post-loop `iter.Error()` error-return block (it false-fails under cacheMergeIterator).

**R-EPOCH-HOOK-RESILIENCE (inherited):** No epoch hook returns a non-nil error for a recoverable condition.
Missing/empty data → log warning, return nil. (A non-nil return rolls back ALL cached writes in the epoch
dispatcher batch — this was the CO-039 zero-decay bug.)

**R-PRESERVE-TREES:** The three repos contain a LARGE amount of uncommitted Sprint-32 WIP (CO-041 + CO-042 +
CO-043 + the zero-decay fix). This is all intentional, in-flight work. Do NOT discard, stash, reset, or
`git checkout` any of it. Phase 6 of THIS order ships the entire Sprint-32 decay stack as the final commit
set. The git trees are NOT clean at the start of this CO — that is expected; R-REMOTE-PREFLIGHT's
"clean tree" stop condition is explicitly WAIVED for the start of this CO (but still applies for divergence
detection: if any repo is BEHIND origin/main, STOP).

**R-NO-PARAM-CHASE-EXCEPTION:** Prior orders forbade decay-parameter tuning (R-NO-PARAM-CHASE). For THIS
order, calibration (Task B) is the explicit, authorized objective. Tuning the decay params to reproduce the
sim gap IS the task. This exception applies ONLY to Task B and ONLY to the params enumerated there.

================================================================================
CONTEXT — WHAT THIS ORDER IS AND WHY
================================================================================
Sprint 32 makes good memories survive and bad memories decay, on-chain, at epoch end ("Earned Trust"
decay), and verifies it with an empirical replay that must reproduce the JS sim's decoupling gap.

History (do not re-litigate):
- CO-041 fixed the cacheMergeIterator false-failure so epoch-end decay runs at all. Its 300-epoch gate
  FAILED (everything decayed to 0/0). Manager carryover: implement a Goldilocks traffic-adaptive idle decay
  and calibrate.
- CO-042 implemented: dual-mode gas strategy (simulate-buffer/simulate-retry), batch atomic submit,
  contributor_wallet plumbing, the Goldilocks per-org/per-epoch metric, traffic-adaptive idle decay, and a
  ZERO-SIGNAL GUARD (suppress idle decay when an org has no traffic this epoch). Its gate FAILED with
  gap=0.00pp — nothing decayed.
- A diagnostic episode (CO-042-diag-findings-report.txt) proved the zero-decay ROOT CAUSE: the hub relays
  serve/denial traffic to the chain ASYNCHRONOUSLY; under fast epochs + simulate-retry commit latency that
  traffic lands on-chain 1–3 epochs LATE. ApplyEpochDecay(N) (fired at AfterEpochEnd(N)) read epoch N's
  traffic before it had landed → GetEpochTrafficStats(N) = 0 → the zero-signal guard fired EVERY epoch →
  idle decay suppressed for EVERY memory forever → gap=0.
- The PRIOR SESSION (acting manager) APPLIED AND VERIFIED THE FIX for that root cause: a "settlement lag"
  on decay. This is DONE. See VERIFIED-CORRECT STATE.

After the fix, a 60-epoch steady replay produced gap=0.00pp → 30.68pp (good-surviving 0.3068,
bad-persisting 0.0000). Two problems remain, which THIS order fixes:
  P1 (Task A): Denials never land on-chain. Every denial batch logs
     `accepted=0 ... no_attestation=N` — the originating serve attestation is not found when the denial is
     processed. So bad memories get NO denial-driven trust loss. (They still decayed to 0 via idle decay in
     the 60-epoch run, but denial dynamics are required for the calibrated steady-state gap and for
     correctness.)
  P2 (Task B): Decay is too aggressive on GOOD memories — good survival 30.68% vs sim ~99%; gap 30.68pp vs
     the gate's ≥75pp. The decay now RUNS (fix works) but the PARAMS are not calibrated. This is the
     original CO-042 Task B/G calibration objective, now unblocked.

GATE CRITERIA (unchanged from CO-042):
  Primary (STEADY traffic): chain.gap ≥ 75pp AND |chain.gap − sim.gap| ≤ 5pp.
  Resilience: BOOTSTRAP shows no 0/0 collapse; HEAVY gap ≥ steady, no degenerate behavior.

Sim spec (STEADY_SCENARIO, the calibration target):
  initMem 100, epochs 300, qPerEpoch 15, qSize 3, servePer 3, badRate 0.12, tpDeny 0.55, fpDeny 0.04,
  contRate 2, maxKw 7, kwSpace 300, retrievalThreshold 0.15. Reference sim gap ≈ 79.17pp
  (good ~0.9919, bad ~0.2002) per CO-041 manager calibration.

--------------------------------------------------------------------------------
VERIFIED-CORRECT STATE (rely on these; do NOT redo or re-investigate)
--------------------------------------------------------------------------------
1. ZERO-DECAY FIX IS IN PLACE AND TESTED (the settlement lag):
   - File: wevibe-chain/x/memory/keeper/epoch_hooks.go
   - `const IdleDecaySettleEpochs = uint64(5)` is defined with a full doc comment.
   - AfterEpochEnd(N): still calls setCurrentEpoch(N) and CheckEpochExpiry(N); but now calls
     ApplyEpochDecay(N - IdleDecaySettleEpochs) when N >= IdleDecaySettleEpochs, else logs
   - Regression test: wevibe-chain/x/memory/keeper/epoch_hooks_test.go ::
     TestAfterEpochEnd_DecaysSettledEpochNotHead (PASS) — proves decay assesses the lagged, settled epoch.
   - `go test ./x/memory/... ./x/serve/... -count=1` PASSES.
2. Chain approval signature path is fixed: wevibe-chain/x/memory/keeper/msg_server.go `canonicalMemoryType`
   returns the unified literal "memory" for both enum values (CO-043 alignment). Memories now commit; the
   replay seeds and serves successfully. Test TestCanonicalMemoryType_UsesUnifiedMemoryLiteral (PASS).
3. Hub boots: wevibe-server/wevibe-hub/internal/db/migrate.go imports `_ "github.com/lib/pq"` (the postgres
   sql driver). Without it the hub crash-loops with `sql: unknown driver "postgres"`.
4. Batch atomic submit is wired: wevibe-server/wevibe-hub/internal/api/handlers/moderation.go
   BatchSubmitToChain calls chainClient.SubmitMemoryBatchAtomic (single tx per batch, not per-row).
5. Gas strategy: GAS_STRATEGY=simulate-retry in docker-compose.yml and docker-compose.fast.yml; dual-mode
   logic in wevibe-server/wevibe-hub/internal/chain/broadcast.go (simulate-buffer / simulate-retry). DO NOT
   revert to fixed gas. Out-of-gas is NOT a current blocker.
6. The Goldilocks metric + traffic-adaptive idle decay + zero-signal guard exist in
   wevibe-chain/x/memory/keeper/lifecycle.go (applyDecay, resolveOrgIdleDecayConfig, ApplyEpochDecay) and
   read per-epoch stats from x/serve via GetEpochTrafficStats / GetMemoryServeCountForEpoch /
   GetMemoryDenialCountForEpoch / GetMatchedKeywordsForEpoch.
   - wevibe-chain/x/memory/keeper/lifecycle.go (epoch_start, traffic_stats, zero_signal_guard,
     memory_decay [first 5/org], epoch_summary)  — NOTE these also added helper funcs:
     graceEpochsRemaining, calculateDenialRateAndTrust, minKeywordWeight. Those helpers are ONLY used by the
     DIAG logs; remove them too when removing the logs (or keep if a non-DIAG caller is added — verify with
     a build).
   - wevibe-chain/x/memory/keeper/epoch_hooks.go (decay_skipped_within_settle_window)
   - wevibe-chain/x/serve/keeper/keeper.go (record_serve, record_denial, get_epoch_traffic)
   - wevibe-chain/x/serve/keeper/msg_server.go (denial_batch summary + the extra reject-reason counters
     rejectedDupNullifier/rejectedNoAttestation/rejectedNoKeywords/rejectedHashMismatch/rejectedNoMemory)

--------------------------------------------------------------------------------
KEY FILE MAP
--------------------------------------------------------------------------------
Chain decay:        wevibe-chain/x/memory/keeper/lifecycle.go (applyDecay, ApplyEpochDecay,
                    resolveOrgIdleDecayConfig), epoch_hooks.go (AfterEpochEnd + IdleDecaySettleEpochs)
Chain decay params: wevibe-chain/x/memory/types/params.go (DefaultParams + Default* consts)
Chain serve/denial: wevibe-chain/x/serve/keeper/keeper.go (ProcessServeBatch, updateEpochStats,
                    incrementMemoryServeCount, IncrementDenialCount, GetServeAttestationByNullifier,
                    attestationKey/nullifierKey), x/serve/keeper/msg_server.go (SubmitServeBatch,
                    SubmitDenialBatch)
Hub serve relay:    wevibe-server/wevibe-hub/internal/api/handlers/serves.go (relayPendingServeBatches,
                    relayPendingDenialBatches, serveRelayWorker, enqueueServeRelay),
                    wevibe-server/wevibe-hub/internal/serves/serves.go (GetPendingServes/GetPendingDenials,
                    RecordServe/RecordDenial), wevibe-server/wevibe-hub/internal/chain/submit.go
                    (SubmitServeBatch/SubmitDenialBatch → MsgSubmitServeBatch/MsgSubmitDenialBatch)
Replay harness:     wevibe-meta/scripts/empirical_replay/main.go (recordServe, recordDenial, simulateEpoch,
                    getChainCurrentEpoch, measureSurvival), lifecycle.go (seed/approve/keyword/batch-submit)
Sim:                wevibe-meta/scripts/sim-calibration.js, scripts/sim-baseline-extract.js,
                    workspace/docs/DECAY_CALIBRATION.md

--------------------------------------------------------------------------------
HOW TO RUN THE REPLAY (use this exact pattern; bound it)
--------------------------------------------------------------------------------
```bash
# fresh stack
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta && make dogfood-fast-down 2>&1 || true
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server && \
  docker compose -f docker-compose.yml -f docker-compose.fast.yml up -d --build
# wait until chain is producing blocks and hub is healthy (compose 'up' blocks until healthy)
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta/scripts/empirical_replay && go build -o /tmp/co-042-replay .
REPLAY_MAX_DURATION_SECONDS=1200 REPLAY_TOTAL_EPOCHS=<N> ORG_ID="co042rev-<purpose>-$(date +%s)" \
  /tmp/co-042-replay 2>&1 | tee /tmp/co-042rev-<purpose>.log
# capture chain DIAG (while tasks A–C still have logs in place)
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server
docker compose -f docker-compose.yml logs wevibe-chain 2>/dev/null | rg "\[CO-042-DIAG\]" | tee /tmp/co-042rev-<purpose>-diag.log
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta && make dogfood-fast-down 2>&1 || true   # ALWAYS tear down
```
NOTE on horizon vs grace: GraceEpochs default = 20 and IdleDecaySettleEpochs = 5, so decay first affects a
seed memory around chain epoch ~25. Short runs (<30 epochs) show little/no decay BY DESIGN — that is not a
bug. Use ≥60 epochs for iteration signal; the GATE itself is 300 epochs.

================================================================================
THE TASKS
================================================================================

--------------------------------------------------------------------------------
Stage 1 — Sequential
Task A — Fix denial no_attestation rejection (CRITICAL)
Execution: SEQUENTIAL
File(s) (expected, confirm before editing):
  wevibe-chain/x/serve/keeper/msg_server.go (SubmitDenialBatch)
  wevibe-chain/x/serve/keeper/keeper.go (GetServeAttestationByNullifier, attestationKey, nullifierKey,
                                         Store... , ProcessServeBatch attestation write)
  wevibe-server/wevibe-hub/internal/api/handlers/serves.go (relay ordering: serves-before-denials)
  wevibe-meta/scripts/empirical_replay/main.go (recordServe/recordDenial — nullifier linkage, READ first)

Problem: Every denial batch is rejected. Verbatim evidence from the post-fix 60-epoch run:
     (dup_nullifier=0 no_attestation=2 no_keywords=0 hash_mismatch=0 no_memory=0)
i.e. SubmitDenialBatch's GetServeAttestationByNullifier(entry.Nullifier) returns found=false. The denial
references the originating serve's nullifier (replay passes serveNullifier into recordDenial), and the chain
resolves the serve attestation by nullifier (nullifierKey → attestationKey). Because EVERY denial fails with
no_attestation (not dup/keywords/hash/memory), the lookup itself is the failure.

What is known:
  - Serves ARE accepted and stored (2084 accepted serves with attestations in the diagnostic run).
  - The denial→serve linkage is by nullifier and is epoch-independent (nullifierKey has no epoch in it).
  - The hub relay (serves.go) drains ALL pending serves (relayPendingServeBatches) BEFORE all pending
    denials (relayPendingDenialBatches) within a single pass, and simulate-retry waits for commit — so in a
    single pass the serve tx commits before the denial tx is broadcast. The failure is therefore NOT
    obviously a single-pass ordering issue; it requires instrumentation to localize.

Implementation (R-DIAGNOSE-WITH-LOGS is MANDATORY here — do not guess):
     - In ProcessServeBatch where the attestation is written: log nullifier (hex), attestationKey, and that
       nullifierKey was set, plus whether the serve was accepted vs rejected (and why).
     - In SubmitDenialBatch: log the denial entry.Nullifier (hex), and inside GetServeAttestationByNullifier
       log the key looked up and whether nullifierKey returned bytes.
     - In the hub relay (serves.go): log, with high-res timestamps, the order and tx_hash of each serve
       batch vs denial batch submitted for the org, and the epoch grouping.
  2. Likely hypotheses to confirm/refute with the logs (do not assume — let evidence decide):
     (a) Nullifier ENCODING mismatch — serve stores nullifierKey(serve.Nullifier as bytes) but the denial
         path looks up a differently-encoded nullifier (hex string vs raw bytes) somewhere across
         hub serve_events (text) → relay → chain proto (bytes). Trace the nullifier from recordServe
         (randHex(32)) → serve_events.nullifier (hex text) → SubmitServeBatch entry.Nullifier (decoded bytes)
         → attestation store, and from recordDenial → serve_events(denial).nullifier → SubmitDenialBatch
         entry.Nullifier (bytes). Confirm both sides key on the SAME byte sequence.
     (b) Cross-pass ordering — the denial for a serve recorded in the same epoch is relayed in a pass that
         runs BEFORE the serve's attestation is committed (e.g., the serve is in a later epoch group / later
         fetch page / a still-in-flight prior pass). If so, the fix is to guarantee a denial is only
         submitted after its originating serve attestation is on-chain (e.g., gate denial relay on the
         serve's status='submitted' AND chain-confirmed, or hold denials whose serve nullifier is not yet
         submitted).
     (c) The serve that a denial references was itself REJECTED on-chain (e.g., MaxServesPerMemoryPerEpoch
         cap) so no attestation exists. Confirm via serve accept/reject logs for that nullifier.
  3. Apply the targeted fix the evidence supports. R-ONE-PATH: one correct path; if it is an encoding
     mismatch, normalize to one representation end-to-end (do not dual-handle). If it is ordering, the relay
     must not submit a denial before its serve attestation exists — make that a hard ordering guarantee, not
     a retry/skip.
  4. R-LONGEVITY: the denial path must be correct in production (continuous traffic), not just in the
     harness. Do not special-case the replay.

Cross-module impact: hub relay (serves.go) and/or chain x/serve. If the fix is hub-only, note the chain is
unchanged. If chain-side, rebuild the chain image for the stack.

Build + test:
```bash
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain && go build ./cmd/wevibed && go test ./x/serve/... -count=1
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server/wevibe-hub && go build ./... && go test ./internal/serves/... ./internal/chain/... -count=1
# Then a bounded live run to confirm denials land:
# Expected: at least some denial_batch lines show accepted>0 and no_attestation drops toward 0.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies. Document the episode in the report (verbatim diag output).

--------------------------------------------------------------------------------
Stage 2 — Sequential (requires Task A)
Task B — Calibrate decay so good memories survive and bad memories decay (CRITICAL, the gate-maker)
Execution: SEQUENTIAL
File(s):
  wevibe-chain/x/memory/types/params.go (DefaultParams + Default* consts)  — primary tuning surface
  wevibe-meta/scripts/sim-calibration.js, scripts/sim-baseline-extract.js  — sim reference (READ/RUN)
  wevibe-meta/workspace/docs/DECAY_CALIBRATION.md                          — record locked constants
  (optionally) wevibe-chain/x/memory/keeper/lifecycle.go applyDecay        — only if the FUNCTION FORM,
                                                                             not just constants, is wrong

Problem: With decay now running, the 60-epoch steady run gave good-surviving 0.3068 (sim ~0.99) and
gap 30.68pp (gate ≥75pp). Good memories decay far too fast. The decay model is the canonical Earned-Trust
model; the chain params likely diverge from the sim's, OR the per-memory effective traffic on-chain is below
the model floor so good served memories aren't protected.

What is known (current chain defaults, wevibe-chain/x/memory/types/params.go):
  ServeDBps=220, DenialDBps=900, IdleDBps=600, ServeFloorBps=4000, DenialFloorBps=3000,
  IdleProtectBps=500, IdleUntrustedBps=10000, IdleTrafficRefBps=2200, IdleTrafficFloorBps=10000,
  TrustMinServes=1, TrustMaxRateBps=3000, GraceEpochs=20, RetrievalThresholdBps=1500.
  applyDecay logic (lifecycle.go): trust=max(0,1-denialRate); trustSq=trust^2; trustEarned = ServeCountTotal
  >= TrustMinServes AND denialRate < TrustMaxRateBps/1e4. Per matched keyword: serve boost
  = serveD*serves*(serveFloor+(1-serveFloor)*trustSq); denial decrement
  = denialD*denials*(denialFloor+(1-denialFloor)*denialRate). For unmatched/idle keywords (and not
  suppressed): idleMult = idleProtect if trustEarned else idleUntrusted*idleScale; weight -= idleD*idleMult.
  idleScale from resolveOrgIdleDecayConfig = clamp((serves+denials)/activeCount / (IdleTrafficRefBps/1e4),
  IdleTrafficFloorBps/1e4, 1.0). Archive when ALL keywords < RetrievalThresholdBps/1e4.

Implementation:
  1. Run the sim to get the authoritative target and the locked function form/constants:
     `cd wevibe-meta && node scripts/sim-calibration.js` and `node scripts/sim-baseline-extract.js`. Read
     workspace/docs/DECAY_CALIBRATION.md. Confirm the sim's STEADY gap (~79pp) and the exact decay constants
     the sim uses.
  2. Compare the sim's constants to the chain DefaultParams. Where the chain diverges from the locked sim
     constants, ALIGN the chain to the sim (this is the authorized exception to R-NO-PARAM-CHASE). The most
     likely culprits for over-aggressive good decay: IdleProtectBps too high (trusted memories should barely
     idle-decay), TrustMinServes/TrustMaxRateBps gating trust too tightly (good served memories not reaching
     trustEarned), ServeDBps/ServeFloorBps too low (serve boost not keeping pace with idle decay), or
     IdleTrafficRefBps making idleScale too large at steady qpe. Do NOT tune blindly — derive each change
     from the sim's value or from a DIAG-observed mismatch (e.g., trust_earned=false on good memories that
     are clearly served — the memory_decay DIAG already logs trust_earned, serve_count, denial_rate,
     idle_scale, min_weight; use it).
  3. R-EVIDENCE: after each param change, run a bounded steady replay (REPLAY_TOTAL_EPOCHS=60, then 120 as
     you converge) and read the memory_decay DIAG to confirm good memories show trust_earned=true,
     idle_scale near the protected regime, and min_weight holding; bad memories show denial_rate up and
     min_weight falling to archive. Iterate to approach the sim gap. Tear down between runs.
  4. If the FUNCTION FORM (not just constants) must change to match the sim, change lifecycle.go applyDecay
     and add/adjust unit tests in x/memory/keeper/decay_test.go. Prefer constant alignment first.
  5. Record the final locked constants in workspace/docs/DECAY_CALIBRATION.md.

Cross-module impact: chain params only (rebuild chain image for live runs). decay_test.go if form changes.

Build + test:
```bash
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain && go build ./cmd/wevibed && go test ./x/memory/... -count=1
# bounded steady replay iterations as above; converge toward sim gap.
# Expected (convergence target, full gate is Task E): good-surviving climbs toward sim (~0.99),
#   bad-persisting stays low, gap climbs toward >=75pp at long horizon.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies (the memory_decay DIAG is already present — use it before changing).

--------------------------------------------------------------------------------
Stage 3 — Sequential (requires Task B)
Task C — Validate / parameterize the settlement lag (MEDIUM)
Execution: SEQUENTIAL
File(s): wevibe-chain/x/memory/keeper/epoch_hooks.go (IdleDecaySettleEpochs)

Problem: IdleDecaySettleEpochs is currently a hardcoded const = 5, chosen to cover the 1–3 epoch settlement
delay observed at steady qpe=15. Under HEAVY traffic (qpe=45) the relay backlog — and thus the settlement
delay — can grow. If the lag is too small, decay(M) will again read partial/zero traffic for epoch M and
under-decay; if needlessly large it just delays decay onset (harmless over 300 epochs).

What is known: at steady qpe=15 the observed settlement was ≤3 epochs; L=5 gave correct, nonzero traffic to
the decay (traffic_stats serves=12–17/epoch, guard fired=false 59/65 epochs).

Implementation:
  1. During the HEAVY regime run in Task E (or a dedicated bounded heavy run here), read the get_epoch_traffic
     / traffic_stats DIAG for the ASSESSED (lagged) epochs. Confirm they are NONZERO and stable (i.e. the
     lag fully covers heavy-regime settlement). If heavy still shows zero/partial traffic at the assessed
     epoch, INCREASE IdleDecaySettleEpochs until it does, and re-verify steady is unaffected.
  2. Decide representation: keep as a well-documented keeper constant (acceptable — it is a first-class
     system constant, like the gas strategy) OR, if calibration shows it must vary by deployment, promote it
     to a memory Param (requires proto change + `make proto-gen` per R-PROTO-REGEN). Default to keeping the
     constant unless evidence demands a param. Document the final value and rationale in code + report.

Build + test:
```bash
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain && go build ./cmd/wevibed && go test ./x/memory/keeper/ -count=1 -run AfterEpochEnd
# Expected: TestAfterEpochEnd_DecaysSettledEpochNotHead and the existing hook tests PASS with the final L.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies.

--------------------------------------------------------------------------------
Stage 4 — Sequential (requires Task C)
Execution: SEQUENTIAL
File(s) (all current DIAG sites — confirm by grep, do not rely on this list alone):
  wevibe-chain/x/memory/keeper/lifecycle.go  (+ its DIAG-only helpers graceEpochsRemaining,
                                              calculateDenialRateAndTrust, minKeywordWeight)
  wevibe-chain/x/memory/keeper/epoch_hooks.go (decay_skipped_within_settle_window line — keep the skip
                                              behavior, remove only the log line)
  wevibe-chain/x/serve/keeper/keeper.go       (record_serve, record_denial, get_epoch_traffic)
  wevibe-chain/x/serve/keeper/msg_server.go   (denial_batch log; the extra reject-reason counters may stay
                                              ONLY if you keep a non-DIAG use, otherwise remove them so the
                                              build has no unused vars)
  + any DIAG you add during Tasks A/B.

Implementation:
  1. `grep -rn "\[CO-042-DIAG\]"` across wevibe-chain + wevibe-server. Remove every matching line. Remove
     now-unused helper funcs/vars that existed ONLY to feed DIAG logs (the compiler will tell you — fix
     unused-variable/function errors by deletion, not by underscore-assignment).
  2. Preserve all NON-diagnostic behavior: the settlement-lag decay, the denial fix, the calibration. Only
     logging (and its dead helpers) is removed.
  3. Rebuild and re-run the FULL chain test suite to confirm nothing was over-deleted.

Build + test:
```bash
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain && go build ./cmd/wevibed && go test ./... -count=1
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server/wevibe-hub && go build ./... && go test ./... -count=1
grep -rn "\[CO-042-DIAG\]" /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain \
                           /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=target --exclude-dir=dist --exclude-dir=.git 2>&1
# Expected: zero matches.
```
If stuck: R-DIAGNOSE-WITH-LOGS applies (but you are REMOVING logs here, so "stuck" means a build/test break
from over-deletion — fix by restoring only the non-DIAG line).

--------------------------------------------------------------------------------
Stage 5 — Sequential (requires Task D)
Task E — Empirical GATE (CRITICAL, GATE)
Execution: SEQUENTIAL
NOTE: run the gate with DIAG logs ALREADY REMOVED (post Task D) so the shipped binary is what is gated.

Procedure (fresh fast stack per regime; ALWAYS bound + tear down):
  STEADY (PRIMARY):    REPLAY_QPE=15 (default) REPLAY_TOTAL_EPOCHS=300, seed 42. Capture good/bad/gap.
                       Also run `node scripts/sim-baseline-extract.js` for the sim gap.
  BOOTSTRAP (resil.):  REPLAY_QPE=4  REPLAY_TOTAL_EPOCHS=300.  Expect: no 0/0 collapse.
  HEAVY (resil.):      REPLAY_QPE=45 REPLAY_CONT_RATE=6 REPLAY_TOTAL_EPOCHS=300. Expect: gap >= steady,
                       no degenerate behavior; confirm settlement lag (Task C) holds.
  If PRIMARY PASSES:   re-run STEADY at seeds 1, 7, 13 (fresh stack each), report all.

GATE EVALUATION:
  Primary: chain.gap >= 75pp AND |chain.gap - sim.gap| <= 5pp (STEADY).
  Resilience: BOOTSTRAP no 0/0; HEAVY gap >= steady.
  If primary PASSES: report seed table. If primary FAILS: capture verbatim and STOP (do NOT param-chase
  beyond Task B's authorized calibration — if Task B's calibrated params still fail the gate, that is a
  manager escalation, not an infinite tuning loop).

Report the regime table:
  | Regime    | good-surv | bad-persist | gap   | vs sim | PASS/FAIL |
  |-----------|-----------|-------------|-------|--------|-----------|
  | STEADY    | ...       | ...         | ...pp | ±...pp | ...       |
  | BOOTSTRAP | ...       | ...         | ...pp | N/A    | ...       |
  | HEAVY     | ...       | ...         | ...pp | N/A    | ...       |

================================================================================
PHASE 4: VERIFICATION
================================================================================
```bash
# === Chain ===
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain
go build ./cmd/wevibed
go test ./... -count=1
rg -n "iter.Error\(\)" x/*/keeper/*.go         # Expected: only comments (R-CACHEKV-ITER)
rg -n "IdleDecaySettleEpochs" x/memory/keeper/epoch_hooks.go   # Expected: present (the fix)

# === Server ===
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server/wevibe-hub
go build ./...
go test ./... -count=1

# === Replay builds ===
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta/scripts/empirical_replay && go build -o /tmp/co-042-replay .

# === Gate artifacts present ===
ls -la /tmp/co-042rev-steady*.log /tmp/co-042rev-sim*.log 2>&1

# === MANDATORY: zero diagnostic logs remain ===
grep -rn "\[CO-042-DIAG\]" /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-chain \
                           /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-server \
                           /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-social-graph \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=target --exclude-dir=dist --exclude-dir=.git 2>&1
# Expected: zero matches. If any match: STOP and remove before proceeding.
```

================================================================================
REPORT FORMAT
================================================================================
Save to: /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta/workspace/reports/CO-042-rev-implementation-report.txt
Use the structure in CO-TEMPLATE.md (Environment; Execution Plan; per-Stage Changes + verbatim Verification
Output; Diagnostic Logging Episodes [Task A WILL have at least one]; Phase 4 outputs incl. the final zero
table and the final locked decay constants.

**⏸ STOP HERE. Submit report and wait for manager approval before Phase 5/6.**

================================================================================
PHASE 5: DOCUMENTATION UPDATE (after approval)
================================================================================
- wevibe-chain x/memory docs/TOPOLOGY.md (create if absent): settlement-lag decay (IdleDecaySettleEpochs),
  Goldilocks metric, zero-signal guard, trust gate, final calibrated params.
- wevibe-chain x/serve docs/TOPOLOGY.md: per-epoch serve/denial stats, denial→serve attestation linkage and
  the Task A fix.
- wevibe-server/wevibe-hub/docs/TOPOLOGY.md: serve/denial relay ordering guarantee (Task A), batch atomic
  submit, gas strategy.
- wevibe-meta workspace/docs/TOPOLOGY.md + DECAY_CALIBRATION.md: locked constants, replay parameterization,
  regime invocations, settlement-lag rationale.

================================================================================
PHASE 6: COMMIT & PUSH
================================================================================
Git identity: user.name "Morfasco", user.email "agilefox22@icloud.com".
R-REMOTE-PREFLIGHT per repo (the trees are intentionally dirty with Sprint-32 WIP — that is expected; the
preflight check here is for BEHIND/divergence, not cleanliness). This commit ships the FULL Sprint-32 decay
stack (CO-041 + CO-042 + CO-043 + this rev) per repo. Commit chain, server, and meta separately.

Suggested commit messages (adjust scope to actual diff):
  wevibe-chain:
    CO-042-rev: settlement-lagged earned-trust decay + denial attestation fix + calibration
    - AfterEpochEnd assesses epoch N-IdleDecaySettleEpochs so async-relayed serve/denial traffic has settled
      before scoring (fixes zero-signal-guard zero-decay)
    - Fix denial no_attestation rejection (<root cause from Task A>)
    - Calibrate decay params to reproduce sim steady-state gap; <list changed params>
  wevibe-server:
    CO-042-rev: serve/denial relay ordering + hub boot/gas/batch fixes
    - <denial relay fix if hub-side>; lib/pq driver import; batch atomic submit; simulate-retry gas
  wevibe-meta:
    CO-042-rev: decay calibration constants + replay parameterization + DECAY_CALIBRATION.md

================================================================================
PHASE 7: FORWARD GATHER
================================================================================
No forward gather requested. Next CO is determined by the gate result.
================================================================================
