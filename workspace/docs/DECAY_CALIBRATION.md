# Decay Calibration (CO-042 Stage 2 Task B)

## Canonical model basis

`wevibe-meta/scripts/sim-calibration.js` is built from the canonical ET simulation model used in `wevibe-meta/scripts/sim-baseline-extract.js`:

- same ET constants (`denialD`, `serveD`, `idleD`, `grace`, trust gates/floors)
- same ranking and retrieval rules
- same memory generation and deterministic PRNG (`mulberry32`)
- same seeds and epoch multiplier

Deterministic seeds used in every scenario run:

`42, 123, 7, 999, 31415`

## Scenarios swept

- steady sweep: `qPerEpoch in {1,2,4,6,10,15,30,45}`
- ramp scenario (time-varying): `70%` of epochs at `qPerEpoch=0`, then `30%` at `qPerEpoch=15`

Reported metrics per scenario/adaptation:

- `goodSurv`
- `badPersist`
- `gap = goodSurv - badPersist`
- `avgT`, where `T_epoch = (serves + denials) / active memories`, averaged across epochs and seeds

## Adaptations evaluated

1. `none`
2. `scaled_untrusted`: untrusted idle multiplier uses `clamp(T/T_ref, floor, 1)`
3. `zero_signal_guard`: idle applies only when org had `>0` events in the epoch
4. `hybrid_guard_plus_scale`: zero-signal guard + untrusted scaling

## Locked Goldilocks function and constants

Locked function:

`hybrid_guard_plus_scale(T)`

with constants:

- `T_ref = 0.22`
- `floor = 1.0`

Behavior:

- if org events for the epoch are zero, idle decay is skipped
- otherwise trusted memories use `idleProtect`
- otherwise untrusted idle uses `idleUntrusted * clamp(T/T_ref, floor, 1)`

With `floor=1.0`, the scaling term resolves to `1.0`; this locks the model to the guard-only effect while preserving a stable function form with explicit calibration constants.

## Calibration checks against acceptance criteria

Baseline anchor (steady `qPerEpoch=15`, `none`):

- `gap = 79.17pp`

Locked function outcomes:

- steady `qPerEpoch=15` gap remains `79.17pp` (`|delta|=0.00pp`, within 1pp)
- ramp good survival improves from `33.51%` to `42.03%` (`+8.52pp`)
- max bad persistence inflation vs `none` across all regimes is `+2.66pp` (within ~3pp)

## Scenario table (none vs locked hybrid)

| Scenario | qPerEpoch | none goodSurv | none badPersist | none gap | locked goodSurv | locked badPersist | locked gap | locked avgT |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| steady-q1 | 1 | 57.72% | 22.67% | 35.05pp | 57.72% | 22.67% | 35.05pp | 0.0164 |
| steady-q2 | 2 | 76.86% | 25.53% | 51.34pp | 76.86% | 25.53% | 51.34pp | 0.0272 |
| steady-q4 | 4 | 90.63% | 24.22% | 66.42pp | 90.63% | 24.22% | 66.42pp | 0.0482 |
| steady-q6 | 6 | 95.91% | 23.14% | 72.77pp | 95.91% | 23.14% | 72.77pp | 0.0698 |
| steady-q10 | 10 | 98.01% | 20.26% | 77.76pp | 98.01% | 20.26% | 77.76pp | 0.1142 |
| steady-q15 | 15 | 99.19% | 20.02% | 79.17pp | 99.19% | 20.02% | 79.17pp | 0.1676 |
| steady-q30 | 30 | 99.71% | 17.52% | 82.20pp | 99.71% | 17.52% | 82.20pp | 0.3326 |
| steady-q45 | 45 | 99.97% | 15.59% | 84.37pp | 99.97% | 15.59% | 84.37pp | 0.4987 |
| ramp-low-then-steady | ramp | 33.51% | 12.68% | 20.83pp | 42.03% | 15.34% | 26.69pp | 0.0648 |

## Rationale

- `none` preserves baseline behavior but underperforms in no-signal epochs within the ramp regime.
- `scaled_untrusted` with locked constants is intentionally neutral (`floor=1.0`) and does not improve ramp outcomes.
- `zero_signal_guard` materially improves ramp good survival while staying below the bad-persistence inflation bound.
- `hybrid_guard_plus_scale` with `T_ref=0.22, floor=1.0` reproduces the same favorable behavior as zero-signal guard and keeps a single canonical function shape for future tuning without changing logic paths.
