# wevibe-meta scripts

Workspace-level helper scripts, typically invoked from the top-level `Makefile`.

- `empirical_replay.sh` + `empirical_replay/` — a Go harness that replays memory
  lifecycle events against the chain to validate decay/ranking behaviour.
- `replay-gate.sh` — runs the empirical-replay matrix (multiple regimes and seeds) and
  collects the results. Invoked by `make replay-gate`.
- `sim-baseline-extract.js`, `sim-baseline-perseed.js`, `sim-calibration.js`,
  `sim-trajectory.js` — decay-model calibration and trajectory analysis utilities.
