#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

REPLAY_TIMEOUT_SECONDS="${REPLAY_TIMEOUT_SECONDS:-1800}"
SIM_TIMEOUT_SECONDS="${SIM_TIMEOUT_SECONDS:-300}"
export REPLAY_MAX_DURATION_SECONDS="${REPLAY_MAX_DURATION_SECONDS:-$REPLAY_TIMEOUT_SECONDS}"

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

cd "$SCRIPT_DIR/empirical_replay"
go build -o /tmp/co-034-replay .

echo "=== Running empirical replay against live stack ==="
replay_exit_code=0
run_with_timeout "$REPLAY_TIMEOUT_SECONDS" /tmp/co-034-empirical.txt /tmp/co-034-replay || replay_exit_code=$?

echo "=== Sim Steady-State baseline ==="
run_with_timeout "$SIM_TIMEOUT_SECONDS" /tmp/co-034-sim-baseline.txt node "$SCRIPT_DIR/sim-baseline-extract.js"

if [ "$replay_exit_code" -ne 0 ]; then
  exit "$replay_exit_code"
fi

python3 - <<'PY'
import re

with open("/tmp/co-034-sim-baseline.txt", "r", encoding="utf-8") as f:
    baseline = f.read()

with open("/tmp/co-034-empirical.txt", "r", encoding="utf-8") as f:
    empirical = f.read()

baseline_match = re.search(
    r"^STEADY_STATE_ET sim\.goodSurv=([0-9]+(?:\.[0-9]+)?) sim\.badPersist=([0-9]+(?:\.[0-9]+)?) sim\.gap=([0-9]+(?:\.[0-9]+)?)$",
    baseline,
    re.MULTILINE,
)
if not baseline_match:
    raise SystemExit("failed to parse /tmp/co-034-sim-baseline.txt")

emp_good = re.search(r"^Good surviving:\s+([0-9]+(?:\.[0-9]+)?)$", empirical, re.MULTILINE)
emp_bad = re.search(r"^Bad persisting:\s+([0-9]+(?:\.[0-9]+)?)$", empirical, re.MULTILINE)
if not emp_good or not emp_bad:
    raise SystemExit("failed to parse /tmp/co-034-empirical.txt")

baseline_good = float(baseline_match.group(1))
baseline_bad = float(baseline_match.group(2))
baseline_gap = float(baseline_match.group(3))

empirical_good = float(emp_good.group(1)) * 100.0
empirical_bad = float(emp_bad.group(1)) * 100.0
empirical_gap = empirical_good - empirical_bad

print("=== Baseline vs Empirical (percentage points) ===")
print(f"baseline:  goodSurv={baseline_good:.2f} badPersist={baseline_bad:.2f} gap={baseline_gap:.2f}")
print(f"empirical: goodSurv={empirical_good:.2f} badPersist={empirical_bad:.2f} gap={empirical_gap:.2f}")
print(
    f"delta:     goodSurv={empirical_good - baseline_good:+.2f} "
    f"badPersist={empirical_bad - baseline_bad:+.2f} "
    f"gap={empirical_gap - baseline_gap:+.2f}"
)
PY
