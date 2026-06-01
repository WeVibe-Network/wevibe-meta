#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
META_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REPLAY_BINARY="${REPLAY_BINARY:-/tmp/co-034-replay}"
# A real 300-epoch cell runs ~78 min (~15s/epoch = N blocks x 5s; the 2s epoch
# knob is NOT the bottleneck). BOTH watchdogs must exceed that: the wrapper
# (REPLAY_TIMEOUT_SECONDS) AND the harness's own internal watchdog
# (REPLAY_MAX_DURATION_SECONDS, forwarded to the binary in run_cell). The old
# 1800s (30 min) defaults killed every real cell at the 30-min mark.
REPLAY_TIMEOUT_SECONDS="${REPLAY_TIMEOUT_SECONDS:-6000}"
REPLAY_MAX_DURATION_SECONDS="${REPLAY_MAX_DURATION_SECONDS:-6000}"
SIM_TIMEOUT_SECONDS="${SIM_TIMEOUT_SECONDS:-300}"
REPLAY_TOTAL_EPOCHS=300

DEFAULT_REGIMES="steady bootstrap heavy"
DEFAULT_SEEDS="42 1 7 13"

run_with_timeout() {
  local timeout_seconds="$1"
  local output_file="$2"
  shift 2

  python3 - "$timeout_seconds" "$output_file" "$@" <<'PY'
import selectors
import subprocess
import sys
import time

timeout_seconds = int(sys.argv[1])
output_file = sys.argv[2]
cmd = sys.argv[3:]

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

selector = selectors.DefaultSelector()
selector.register(proc.stdout, selectors.EVENT_READ)

deadline = time.monotonic() + timeout_seconds
chunks = []
timed_out = False

while True:
    if proc.poll() is not None:
        break

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        timed_out = True
        proc.kill()
        break

    events = selector.select(timeout=min(0.5, remaining))
    for key, _ in events:
        line = key.fileobj.readline()
        if not line:
            continue
        chunks.append(line)
        sys.stdout.write(line)
        sys.stdout.flush()

tail = proc.stdout.read() if proc.stdout is not None else ""
if tail:
    chunks.append(tail)
    sys.stdout.write(tail)
    sys.stdout.flush()

if timed_out:
    timeout_line = f"watchdog timeout after {timeout_seconds}s for command: {' '.join(cmd)}\n"
    chunks.append(timeout_line)
    sys.stdout.write(timeout_line)
    sys.stdout.flush()

output = "".join(chunks)
with open(output_file, "w", encoding="utf-8") as f:
    f.write(output)

if timed_out:
    sys.exit(124)

sys.exit(proc.returncode if proc.returncode is not None else 1)
PY
}

regime_params() {
  case "$1" in
    steady)
      printf "15 0"
      ;;
    bootstrap)
      printf "4 0"
      ;;
    heavy)
      printf "45 6"
      ;;
    *)
      return 1
      ;;
  esac
}

record_result() {
  RESULTS+=("$1|$2|$3|$4|$5|$6|$7|$8")
}

lookup_result() {
  local regime="$1"
  local seed="$2"
  local entry rr ss chain sim delta status good bad

  for entry in "${RESULTS[@]}"; do
    IFS='|' read -r rr ss chain sim delta status good bad <<< "$entry"
    if [ "$rr" = "$regime" ] && [ "$ss" = "$seed" ]; then
      printf "%s" "$entry"
      return 0
    fi
  done

  return 1
}

format_float() {
  python3 - "$1" <<'PY'
import sys
print(f"{float(sys.argv[1]):.2f}")
PY
}

run_cell() {
  local regime="$1"
  local seed="$2"
  local qpe cont_rate
  read -r qpe cont_rate <<< "$(regime_params "$regime")"

  local baseline_log="/tmp/replay-gate-baseline-${regime}-${seed}.txt"
  local trajectory_file="/tmp/sim-trajectory-${regime}.json"
  local replay_log="/tmp/replay-gate-${regime}-${seed}.txt"

  local sim_values sim_good_pp sim_bad_pp sim_gap_pp
  local chain_values chain_good_pp chain_bad_pp chain_gap_pp
  local chain_gap_fmt sim_gap_fmt delta_fmt status
  local chain_good_fmt chain_bad_fmt

  echo ""
  echo "=== Gate cell regime=${regime} seed=${seed} qpe=${qpe} contRate=${cont_rate} ==="

  if ! run_with_timeout "$SIM_TIMEOUT_SECONDS" "$baseline_log" node "$SCRIPT_DIR/sim-baseline-perseed.js" --regime "$regime" --seed "$seed"; then
    echo "ERROR: baseline emitter failed for regime=${regime} seed=${seed}" >&2
    record_result "$regime" "$seed" "ERR" "ERR" "NA" "FAIL" "NA" "NA"
    return 1
  fi

  if ! sim_values="$(python3 - "$baseline_log" "$regime" "$seed" <<'PY'
import re
import sys

path, expected_regime, expected_seed = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

m = re.search(
    r"^BASELINE regime=([a-z]+) seed=([+-]?[0-9]+) sim\.goodSurv=([+-]?[0-9]+(?:\.[0-9]+)?) sim\.badPersist=([+-]?[0-9]+(?:\.[0-9]+)?) sim\.gap=([+-]?[0-9]+(?:\.[0-9]+)?)$",
    text,
    re.MULTILINE,
)
if not m:
    raise SystemExit(f"failed to parse baseline output from {path}")
if m.group(1) != expected_regime or m.group(2) != expected_seed:
    raise SystemExit(
        f"baseline mismatch: got regime={m.group(1)} seed={m.group(2)} expected regime={expected_regime} seed={expected_seed}"
    )

print(f"{m.group(3)} {m.group(4)} {m.group(5)}")
PY
)"; then
    echo "ERROR: failed to parse baseline emitter output for regime=${regime} seed=${seed}" >&2
    record_result "$regime" "$seed" "ERR" "ERR" "NA" "FAIL" "NA" "NA"
    return 1
  fi
  read -r sim_good_pp sim_bad_pp sim_gap_pp <<< "$sim_values"

  if ! node "$SCRIPT_DIR/sim-trajectory.js" --regime "$regime" --epochs "$REPLAY_TOTAL_EPOCHS" > "$trajectory_file"; then
    echo "ERROR: failed to generate sim trajectory for regime=${regime}" >&2
    record_result "$regime" "$seed" "ERR" "ERR" "NA" "FAIL" "NA" "NA"
    return 1
  fi

  make -C "$META_DIR" docker-down >/dev/null 2>&1 || true

  if ! make -C "$META_DIR" docker-up-fast; then
    echo "ERROR: docker-up-fast failed for regime=${regime} seed=${seed}" >&2
    record_result "$regime" "$seed" "ERR" "ERR" "NA" "FAIL" "NA" "NA"
    return 1
  fi

  local replay_exit_code=0
  run_with_timeout "$REPLAY_TIMEOUT_SECONDS" "$replay_log" env \
    REPLAY_SEED="$seed" \
    REPLAY_QPE="$qpe" \
    REPLAY_CONT_RATE="$cont_rate" \
    REPLAY_TOTAL_EPOCHS="$REPLAY_TOTAL_EPOCHS" \
    REPLAY_MAX_DURATION_SECONDS="$REPLAY_MAX_DURATION_SECONDS" \
    REPLAY_SIM_TRAJECTORY="$trajectory_file" \
    "$REPLAY_BINARY" || replay_exit_code=$?

  if ! make -C "$META_DIR" docker-down; then
    echo "ERROR: docker-down failed for regime=${regime} seed=${seed}" >&2
    sim_gap_fmt="$(format_float "$sim_gap_pp")"
    record_result "$regime" "$seed" "ERR" "$sim_gap_fmt" "NA" "FAIL" "NA" "NA"
    return 1
  fi

  if [ "$replay_exit_code" -ne 0 ]; then
    echo "ERROR: replay harness exited ${replay_exit_code} for regime=${regime} seed=${seed}" >&2
    sim_gap_fmt="$(format_float "$sim_gap_pp")"
    record_result "$regime" "$seed" "ERR" "$sim_gap_fmt" "NA" "FAIL" "NA" "NA"
    return 1
  fi

  if ! chain_values="$(python3 - "$replay_log" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

good = re.search(r"^Good surviving:\s+([+-]?[0-9]+(?:\.[0-9]+)?)$", text, re.MULTILINE)
bad = re.search(r"^Bad persisting:\s+([+-]?[0-9]+(?:\.[0-9]+)?)$", text, re.MULTILINE)
gap = re.search(r"^Decoupling gap:\s+([+-]?[0-9]+(?:\.[0-9]+)?)pp$", text, re.MULTILINE)

if not good or not bad or not gap:
    raise SystemExit(f"failed to parse replay output from {path}")

good_pp = float(good.group(1)) * 100.0
bad_pp = float(bad.group(1)) * 100.0
gap_pp = float(gap.group(1))
print(f"{good_pp} {bad_pp} {gap_pp}")
PY
)"; then
    echo "ERROR: failed to parse replay metrics for regime=${regime} seed=${seed}" >&2
    sim_gap_fmt="$(format_float "$sim_gap_pp")"
    record_result "$regime" "$seed" "ERR" "$sim_gap_fmt" "NA" "FAIL" "NA" "NA"
    return 1
  fi
  read -r chain_good_pp chain_bad_pp chain_gap_pp <<< "$chain_values"

  read -r chain_gap_fmt sim_gap_fmt delta_fmt status <<< "$(python3 - "$chain_gap_pp" "$sim_gap_pp" <<'PY'
import sys

chain = float(sys.argv[1])
sim = float(sys.argv[2])
delta = chain - sim
status = "PASS" if chain >= 75.0 and abs(delta) <= 5.0 else "FAIL"
print(f"{chain:.2f} {sim:.2f} {delta:+.2f} {status}")
PY
)"

chain_good_fmt="$(format_float "$chain_good_pp")"
chain_bad_fmt="$(format_float "$chain_bad_pp")"

echo "CELL regime=${regime} seed=${seed} chain.goodSurv=${chain_good_fmt} chain.badPersist=${chain_bad_fmt} chain.gap=${chain_gap_fmt} sim.gap=${sim_gap_fmt} delta=${delta_fmt} ${status}"

record_result "$regime" "$seed" "$chain_gap_fmt" "$sim_gap_fmt" "$delta_fmt" "$status" "$chain_good_fmt" "$chain_bad_fmt"

if [ "$status" = "PASS" ]; then
    return 0
  fi

  return 1
}

print_summary_matrix() {
  local regime seed entry rr ss chain sim delta status good bad cell

  echo ""
  echo "=== SUMMARY MATRIX (chain_gap/sim_gap/delta/status) ==="
  printf "%-12s" "regime\\seed"
  for seed in "${SEEDS[@]}"; do
    printf " | %-28s" "seed=${seed}"
  done
  printf "\n"

  for regime in "${REGIMES[@]}"; do
    printf "%-12s" "$regime"
    for seed in "${SEEDS[@]}"; do
      if entry="$(lookup_result "$regime" "$seed")"; then
        IFS='|' read -r rr ss chain sim delta status good bad <<< "$entry"
        cell="${chain}/${sim}/${delta}/${status}"
      else
        cell="NA/NA/NA/FAIL"
      fi
      printf " | %-28s" "$cell"
    done
    printf "\n"
  done
}

normalize_list() {
  local raw="$1"
  printf "%s" "${raw//,/ }"
}

regime_values="$(normalize_list "${GATE_REGIMES:-$DEFAULT_REGIMES}")"
seed_values="$(normalize_list "${GATE_SEEDS:-$DEFAULT_SEEDS}")"

read -r -a REGIMES <<< "$regime_values"
read -r -a SEEDS <<< "$seed_values"

if [ "${#REGIMES[@]}" -eq 0 ]; then
  echo "error: no regimes provided (set GATE_REGIMES)" >&2
  exit 1
fi
if [ "${#SEEDS[@]}" -eq 0 ]; then
  echo "error: no seeds provided (set GATE_SEEDS)" >&2
  exit 1
fi

for regime in "${REGIMES[@]}"; do
  if ! regime_params "$regime" >/dev/null; then
    echo "error: invalid regime '$regime' (expected steady/bootstrap/heavy)" >&2
    exit 1
  fi
done

for seed in "${SEEDS[@]}"; do
  if ! [[ "$seed" =~ ^-?[0-9]+$ ]]; then
    echo "error: invalid seed '$seed' (expected integer)" >&2
    exit 1
  fi
done

echo "=== Replay gate configuration ==="
echo "Regimes: ${REGIMES[*]}"
echo "Seeds:   ${SEEDS[*]}"
echo "Epochs:  ${REPLAY_TOTAL_EPOCHS}"
echo "Replay timeout/cell: ${REPLAY_TIMEOUT_SECONDS}s"

echo "=== Building empirical replay harness binary ==="
(
  cd "$SCRIPT_DIR/empirical_replay"
  go build -o "$REPLAY_BINARY" .
)

RESULTS=()
FAIL_COUNT=0
TOTAL_COUNT=0

for regime in "${REGIMES[@]}"; do
  for seed in "${SEEDS[@]}"; do
    TOTAL_COUNT=$((TOTAL_COUNT + 1))
    if run_cell "$regime" "$seed"; then
      :
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  done
done

print_summary_matrix
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "OVERALL VERDICT: FAIL (${FAIL_COUNT}/${TOTAL_COUNT} cells failed)"
  exit 1
fi

echo "OVERALL VERDICT: PASS (${TOTAL_COUNT}/${TOTAL_COUNT} cells passed)"
