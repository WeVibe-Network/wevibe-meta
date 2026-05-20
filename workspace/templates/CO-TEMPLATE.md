MASTER ORDER — CO-XXX: [Title]
Date: YYYY-MM-DD
Sprint: Sprint NN — [Sprint Name]
Packages: [affected packages/modules]
Base directory: /Users/jerrysmith/Desktop/WeVibe
Languages: [Go | TypeScript | Rust | mixed]

EXECUTION DIRECTIVE
This order contains N tasks. Tasks are classified as either SEQUENTIAL or PARALLEL in the dependency table below. You MUST use the task tool to execute all PARALLEL groups concurrently. Sequential tasks must complete fully before the next sequential stage begins.

Order	Task	Depends On	Execution Mode
1	[Task A title]	—	SEQUENTIAL
2	[Task B title]	Task A	SEQUENTIAL
2	[Task C title]	Task A	PARALLEL with Task D
2	[Task D title]	Task A	PARALLEL with Task C
3	[Task E title]	Tasks C, D	SEQUENTIAL
Parallel execution rules:

Tasks in the same stage with no shared file writes MUST be launched simultaneously using the task tool.
If two tasks touch the same file, they are SEQUENTIAL regardless of what this table says — stop and flag in report.
Do NOT serialize tasks that are marked PARALLEL. Doing so is a violation of this order.
Each parallel subtask must still produce its own verification output, captured in the report.
After all tasks are complete, you must:

Run the verification commands (Phase 4)
Produce the consolidated implementation report
Save the report to the specified path
STOP. Wait for manager approval before proceeding to Phase 5.
STANDING RULES — READ BEFORE ANY IMPLEMENTATION
These rules are non-negotiable. They apply to every task in this order.

R-LONGEVITY: Every solution must be the right long-term solution. This is a professionally maintained repository. No duct tape, no shims, no backwards-compatible hacks. Overhaul the correct thing. If the fix looks like a shortcut, it is wrong.

R-ONE-PATH: There is one path, one system, one design. It works like this, or it doesn't work. No fallback paths. No graceful degradation. No "if old format, do X instead." No "if unavailable, skip." If a dependency is required, its absence is a hard error. If a format changes, old data is wiped and re-created — not migrated, not dual-handled. Code that handles two formats is a bug. Code that silently continues when a required step fails is a bug. There is no "enhanced mode" vs "baseline mode." There is the mode.

R-OVERHAUL: Do NOT provide backwards-compatible patches. Overhaul always unless backwards compatibility is specifically stated in the task description.

R-ABORT: If you encounter ANYTHING that contradicts this order — a file that doesn't exist where expected, a function signature that doesn't match what's described, a test that behaves differently than specified — STOP IMMEDIATELY. Do not improvise. Do not guess. Produce a questions report documenting exactly what you found, what you expected, and what decisions you need answered before continuing.

R-TEST-OUTPUT: You MUST run all tests and capture verbatim output. Do not summarize test results. Do not skip tests. Do not say "tests pass" without showing the output. Pipe all test output into the implementation report.

R-REPORT: Produce an implementation report as a .txt file at the path specified. Format specified in the REPORT FORMAT section below.

R-NO-SKIP: You may not silently skip any item in this order. Every task must be attempted. If a task cannot be completed, document exactly why in the report — do not omit it.

R-PARALLEL: You MUST use the task tool for all task groups marked PARALLEL in the execution directive. Serializing parallel tasks is a rule violation and must be noted as a deviation in the report. When launching parallel tasks, each subtask prompt must be self-contained — include all file paths, context, and instructions needed, because subtasks do not share context with each other.

R-PROTO-REGEN: For wevibe-chain proto changes, regeneration must use Docker-based generation via make proto-gen. Do not install local protoc plugins. Do not hand-edit *.pb.go files. If make proto-gen target is missing or fails, STOP and produce a questions report.

R-DIAGNOSE-WITH-LOGS: When you encounter a failure you cannot explain by reading the code — flaky test, unexpected response, mysterious state mismatch, "should work but doesn't" — you MUST instrument the relevant code paths with temporary diagnostic logging BEFORE forming a hypothesis or proposing a fix. Do not guess. Do not theorize from inference alone. The investigation procedure is:

Instrument. Add explicit log lines (console.log / log.Printf / eprintln! / etc.) at every decision point in the suspect code path. Log:

Function entry with all relevant inputs
Branch decisions (which path taken and why)
State values at key transitions (before/after mutations)
Function exit with return value or error
For test failures: log inside the production code AND the test setup/teardown
For ordering issues: log a high-resolution timestamp with each line
Use a clear, greppable prefix on every diagnostic log so you can find them all later — e.g. [CO-XXX-DIAG]. Example:


console.log(`[CO-XXX-DIAG] verifySessionToken called: presented.length=${presented?.length}, currentToken=${currentToken ? 'set' : 'null'}`);
Reproduce. Run the failing scenario and capture the diagnostic output verbatim. If the bug is order-dependent or intermittent, run multiple times and capture all outputs.

Analyze. Read the captured logs. The bug is now visible — which branch was actually taken, which value was actually present, which call was actually made. Form your hypothesis from the evidence, not from inference.

Fix. Apply the targeted fix that the evidence supports.

Verify the fix. Re-run the failing scenario with the logs still in place. Confirm the diagnostic output shows the corrected behavior.

Remove the diagnostics. Once the fix is confirmed:

grep -rn "[CO-XXX-DIAG]" . across all touched files
Remove every line that contains the diagnostic prefix
Re-run the test suite to confirm nothing was over-deleted (e.g., a real log line that happened to share the prefix is restored)
grep -rn "[CO-XXX-DIAG]" . again — expected: zero matches
Document. In the implementation report, include a "Diagnostic Logging Episode" subsection for each instance of this rule firing:

What failure prompted the instrumentation
Verbatim diagnostic output that revealed the cause
The hypothesis the evidence supported
The fix applied
Verbatim grep showing zero [CO-XXX-DIAG] matches after removal
Why this rule exists: Guessing at root causes wastes time and produces wrong fixes. A 5-minute instrumentation pass replaces 30 minutes of speculative theorizing. The discipline of "log first, then fix" is the difference between professional debugging and folklore. Diagnostic logs left in production code (or even in committed test code) are noise pollution and a maintenance liability — they MUST be removed before commit.

Exception: Logs that already exist in the codebase before this CO began are NOT diagnostic logs added by this CO. Do not remove pre-existing logs. The prefix [CO-XXX-DIAG] is what distinguishes new diagnostics from existing instrumentation.

[Add CO-specific standing rules here if needed, e.g.:]
[R-COMPILE-GATE: go build ./cmd/wevibed must succeed before moving to the next task.]
[R-NO-ORPHAN: After deletion, grep for deleted module names. Zero hits allowed.]

CONTEXT — WHAT THIS ORDER IS AND WHY
[2-4 paragraphs explaining the problem, the architectural decision, and why this CO exists. Include:]

[What is verified as correct: — list of known-good facts the worker can rely on]

[What could vary: — list of things the worker may need to adapt to]

THE TASKS
Stage 1 — Sequential
Task A — [Title] ([CRITICAL | MEDIUM | LOW])
Execution: SEQUENTIAL
File(s): [exact file paths]

Problem: [What is wrong or missing and why it matters]

What is known:

[Fact the worker can rely on]
[Fact the worker can rely on]
Implementation:

[Step-by-step instructions with exact file paths, code blocks, and expected outcomes]
[Each step should be verifiable before proceeding to the next]
Cross-module impact: [What other files/modules are affected, or "None"]

Build + test:


[exact commands to verify this task succeeded]
# Expected: [what the output should look like]
If stuck: R-DIAGNOSE-WITH-LOGS applies. Instrument, reproduce, analyze, fix, remove. Document the episode in the report.

Stage 2 — Parallel Group (launch all tasks below simultaneously with task tool)
These tasks have no shared file writes and no inter-dependencies. Launch them in a single task tool call. Each subtask prompt must be fully self-contained.

Task B — [Title] ([CRITICAL | MEDIUM | LOW])
Execution: PARALLEL (Stage 2)
File(s): [exact file paths — must not overlap with Task C]

Problem: [What is wrong or missing]

Implementation:

[Instructions]
Build + test:


[verification commands]
# Expected: [expected output]
If stuck: R-DIAGNOSE-WITH-LOGS applies.

Task C — [Title] ([CRITICAL | MEDIUM | LOW])
Execution: PARALLEL (Stage 2)
File(s): [exact file paths — must not overlap with Task B]

Problem: [What is wrong or missing]

Implementation:

[Instructions]
Build + test:


[verification commands]
# Expected: [expected output]
If stuck: R-DIAGNOSE-WITH-LOGS applies.

Stage 3 — Sequential (requires Stage 2 complete)
Task D — [Title] ([CRITICAL | MEDIUM | LOW])
Execution: SEQUENTIAL
[Same structure as Task A — including "If stuck: R-DIAGNOSE-WITH-LOGS applies." footer]

PHASE 4: VERIFICATION
After all tasks are complete, run these commands and capture output:


[verification command 1]
# Expected: [expected output]

[verification command 2]
# Expected: [expected output]

# MANDATORY: confirm all diagnostic logging from R-DIAGNOSE-WITH-LOGS has been removed.
# This must return ZERO matches across every file the CO touched. If anything matches,
# the diagnostic was not cleaned up and the CO is not complete.
grep -rn "\[CO-XXX-DIAG\]" /Users/jerrysmith/Desktop/WeVibe/WeVibe \
                          /Users/jerrysmith/Desktop/WeVibe/wevibe-server \
                          /Users/jerrysmith/Desktop/WeVibe/wevibe-chain \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=target \
  --exclude-dir=dist \
  --exclude-dir=.git \
  2>&1
# Expected: zero matches. If any match: STOP and remove before proceeding.
REPORT FORMAT
Save the implementation report to: /Users/jerrysmith/Desktop/WeVibe/workspace/reports/CO-XXX-implementation-report.txt


# CO-XXX Implementation Report — [Title]
Generated: [timestamp]

## Environment
- OS: [output of uname -a]
- [language runtime version]

## Execution Plan
- Stages executed: [N]
- Parallel groups: [N]
- Tasks serialized that should have been parallel (deviations): [list or NONE]

## Stage 1
### Task A: [Title]
#### Changes
- File: [path]
- Action: [what was done]
#### Verification Output (verbatim)
[paste test/grep/build outputs]

## Stage 2 (Parallel)
### Task B: [Title]
#### Changes
- File: [path]
- Action: [what was done]
#### Verification Output (verbatim)
[paste outputs]

### Task C: [Title]
#### Changes
- File: [path]
- Action: [what was done]
#### Verification Output (verbatim)
[paste outputs]

## Stage 3
### Task D: [Title]
[...]

---

## Diagnostic Logging Episodes

[If R-DIAGNOSE-WITH-LOGS fired during any task, document each episode here.
 If it did not fire, write: "None — no stuck-point encountered." Do NOT omit
 this section.]

### Episode 1 — [brief title, e.g., "flaky http-auth test"]
**Task:** [Task A | B | C | ...]
**Failure that prompted instrumentation:**
[paste the verbatim failure that caused you to instrument]

**Diagnostic instrumentation added:**
[paste the diff or describe the log lines added, with the [CO-XXX-DIAG] prefix]

**Reproduction output (verbatim):**
[paste the full diagnostic log output from running the failing scenario]

**Hypothesis from evidence:**
[1-3 sentences explaining what the logs revealed]

**Fix applied:**
[paste the diff or describe the fix]

**Post-fix reproduction with logs still in place (verbatim):**
[paste output showing corrected behavior with diagnostic logs still active]

**Removal verification:**
```bash
grep -rn "\[CO-XXX-DIAG\]" [scope] 2>&1
[paste output — must show zero matches]

Post-removal test re-run (verbatim):
[paste output confirming nothing was over-deleted; tests still pass]

Episode 2 — [if applicable]
[same structure]

Phase 4: Verification
[paste all verification outputs INCLUDING the final [CO-XXX-DIAG] grep showing zero matches]

Summary
[key metric: what changed]
[key metric: what changed]
Diagnostic logging episodes: [count, or "none"]
All diagnostic logs removed: [YES | NO — must be YES to ship]
Parallel execution: [ENFORCED | DEVIATED — reason]


**⏸ STOP HERE. Submit report and wait for manager approval before proceeding to Phase 5.**

---

## PHASE 5: DOCUMENTATION UPDATE (after manager approval)

After the manager reviews and approves the implementation report, update documentation in every affected module. This is mandatory — do not skip.

### Documentation hierarchy

The repository is a monorepo with nested modules. Documentation lives at two levels:

**Level 1 — Module-level docs (inside each package):**
Each module has its own `docs/` directory with a `TOPOLOGY.md` and potentially other docs. These describe that module's internals — its endpoints, data flows, file structure, dependencies, and operational details. Module-level docs are the primary reference for anyone working inside that package.
WeVibe/ # Public repo root
├── wevibe-guard/docs/TOPOLOGY.md # Guard scanner internals
├── wevibe-mcp/docs/TOPOLOGY.md # MCP client internals
├── wevibe-sdk/docs/TOPOLOGY.md # Crypto SDK internals
├── anchor/wevibe-identity/docs/TOPOLOGY.md # Identity/rotation internals
├── protocol/docs/TOPOLOGY.md # Protocol definitions
└── docs/ # General public-repo docs

wevibe-server/ # Private repo root
├── wevibe-hub/docs/TOPOLOGY.md # Hub API server internals
├── wevibe-dashboard/docs/TOPOLOGY.md # Dashboard UI internals
└── wevibe-infra/docs/TOPOLOGY.md # Infrastructure/deployment

wevibe-chain/ # Chain repo (may have docs/)

workspace/docs/ # Repo-wide documents
├── TOPOLOGY.md # Master cross-module topology
├── SURFACE_AREA_AUDIT.md # Audit documents
└── [other repo-wide docs]



**Level 2 — Repo-wide docs (`workspace/docs/`):**
These describe the system as a whole — cross-module relationships, the master topology, audit documents, and architecture decisions that span multiple packages.

### What to update

**For each module touched by this CO, update its `docs/TOPOLOGY.md`:**
- New or modified endpoints, handlers, routes
- New or modified database tables, columns, indexes
- New or modified files, modules, exports
- Changed data flows, storage patterns, dependencies
- Removed functionality — delete stale references entirely

**If this CO changes cross-module behavior, update `workspace/docs/TOPOLOGY.md`:**
- New inter-module data flows (e.g., hub now calls a new chain message)
- Changed API contracts between modules
- New infrastructure components or storage dependencies
- Changed deployment or operational patterns

**If this CO introduced architectural decisions, add or update docs in the relevant module's `docs/` directory** (ADRs, design docs, etc.).

**Inline code comments** — Ensure non-obvious decisions are documented in code. If the "why" would be lost without a comment, add one. (This does NOT mean leaving diagnostic logs — diagnostic logs are removed per R-DIAGNOSE-WITH-LOGS. Inline comments explain intent; diagnostic logs reveal runtime state during debugging.)

### Documentation rules

- Documentation describes the system as it IS after this CO, not as it was before.
- Do not leave stale references to removed functionality in ANY doc at ANY level.
- Be specific: endpoint paths, file locations, function names, table columns. Vague summaries are useless.
- Module-level TOPOLOGY.md is the canonical reference for anyone working in that package — treat it accordingly.
- Repo-wide TOPOLOGY.md is the canonical reference for anyone understanding the full system — keep it in sync with module-level docs.
- Only update docs for modules this CO actually touched. Do not speculatively update unrelated module docs.

---

## PHASE 6: COMMIT & PUSH

After documentation is updated, commit and push all changes.

**Git identity:**
```bash
git config user.name "Morfasco"
git config user.email "agilefox22@icloud.com"
Pre-commit check (MANDATORY): Re-confirm zero diagnostic logs remain before staging anything.


grep -rn "\[CO-XXX-DIAG\]" /Users/jerrysmith/Desktop/WeVibe/WeVibe \
                          /Users/jerrysmith/Desktop/WeVibe/wevibe-server \
                          /Users/jerrysmith/Desktop/WeVibe/wevibe-chain \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=target \
  --exclude-dir=dist \
  --exclude-dir=.git \
  2>&1
# Expected: zero matches. If any match: do NOT commit. Remove and re-run.
Commit procedure — for each affected repository:

Stage all changes:


git add -A
Review staged changes (capture in report):


git diff --cached --stat
Final diagnostic-log sanity check on what's about to be committed:


git diff --cached | grep -n "\[CO-XXX-DIAG\]"
Expected: zero matches. If any match: git restore --staged <file>, remove the log, re-stage, re-check.

Commit with the message from the GIT section below:


git commit -m "<commit message from GIT section>"
Push to current branch:


git push
If multiple repositories are affected, commit and push each one separately. Each repo gets its own commit with the same CO reference but scoped to what changed in that repo.

If push fails (auth, remote rejection, etc.), capture the error output in the report and stop. Do not force push. Do not retry with different flags.

GIT
Commit message (per repo, adjust scope line to match repo content):


CO-XXX: [short description]

- [bullet point per logical change]
- [bullet point per logical change]