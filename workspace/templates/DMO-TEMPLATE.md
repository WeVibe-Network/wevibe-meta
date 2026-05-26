# DOCUMENT MODIFICATION ORDER — DMO-XXX: [Title]

**Date:** YYYY-MM-DD
**Sprint:** Sprint NN — [Sprint Name]
**Documents:** [list of affected documents with repo paths]
**Reason:** [CO reference, gap discovery, audit finding, or Walter directive]

---

## STANDING RULES

**R-DOCS-ONLY:** This order modifies documentation only. No code, no builds, no test suites. If a document change implies a code change, STOP — that requires a CO, not a DMO.

**R-CANONICAL-SOURCE:** In-repo documents (`wevibe-docs/MASTER.md`, `wevibe-docs/DECISIONS.md`, `wevibe-docs/TOPOLOGY.md`) are canonical per D-S28-WALTER-ROOT-DIVERGENCE. Workspace-root copies are Walter's working drafts and are NOT modified by DMOs.

**R-WORKSPACE-ROOT-DOCS — NEVER MODIFY THESE:**
The following files exist in the workspace root (`/Users/jerrysmith/Desktop/wevibe-workspace/`) as Walter's internal reference documents. They are **gitignored** and **never committed**. DMOs are purpose designed to modify these files for internal mapping purpose only. 

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions — manager/worker workflow, order lifecycle, standing rules, project layout. Sole source of truth for agent execution protocol. |
| `ARCHIVED.md` | Walter's working draft of MASTER.md content during archived editing sessions. Contains historical UX flows and gap entries. |
| `ATTESTATIONUPGRADE.md` | Strategic architecture guidance on consensus hardening, validator sustainability, and attestation elevation. |
| `CHAINUPGRADES.md` | Consensus & validator security review notes — state growth, replay degradation, lazy evaluation recommendations. |
| `DECISIONS.md` | (workspace root copy) Walter's working draft; canonical version lives in `wevibe-docs/DECISIONS.md`. |
| `MASTER.md` | (workspace root copy) Walter's working draft; canonical version lives in `wevibe-docs/MASTER.md`. |
| `MIGRATION.md` | Sprint 28 Echo→WeVibe migration plan with locked decisions, repo inventory, and identifier rename inventory. |
| `SESSIONCONTINUANCE.md` | Agent session continuance notes — Sprint 28 watch items, todo lists for MO dispatch cycles. |

The following template files also exist in `wevibe-meta/workspace/templates/` and are **gitignored** — they define order structure but are not themselves committed:

| Template | Purpose |
|----------|---------|
| `CO-TEMPLATE.md` | Change Order template — six-phase lifecycle, execution directives, build/test commands, report format. |
| `MO-TEMPLATE.md` | Migration Order template — cross-cutting transforms, rename atomicity rules, migration audit requirements. |
| `DMO-TEMPLATE.md` | This template — document-only modifications to canonical in-repo docs. |
| `SESSION-TEMPLATE.md` | Session template for agent dispatch. |

Implementation reports are also **gitignored** and never committed. They live in `wevibe-meta/workspace/reports/` and are generated for manager review only:

| Report Pattern | Purpose |
|----------------|---------|
| `WeVibe-CO-###-implementation-report.txt` | CO implementation report — tasks executed, test output, verification results. |
| `MO-###-implementation-report.txt` | MO implementation report — renames performed, verification greps, commit summary. |
| `MO-###-PostCommit-implementation-report.txt` | Post-commit MO report — documentation updates, final push verification. |
| `MO-###-questions-report.txt` | Questions report — R-ABORT deviations requiring manager decisions. |
| `DMO-###-implementation-report.txt` | DMO implementation report — document modifications verified. |

**R-REMOTE-PREFLIGHT:** Before commit, per repo touched:

```bash
cd /Users/jerrysmith/Desktop/wevibe-workspace/<repo>
git fetch origin --quiet
git status --porcelain
echo "HEAD:        $(git rev-parse HEAD)"
echo "origin/main: $(git rev-parse origin/main)"
echo "ahead/behind: $(git rev-list --left-right --count HEAD...origin/main)"
```

If behind > 0 or dirty tree at start, STOP and escalate.


---

## CONTEXT

[1-2 paragraphs: what changed, why the docs need updating, what triggered this DMO]

---

## MODIFICATIONS

### Modification 1 — [Document name]

**File:** `wevibe-docs/[filename]`
**Section:** [section heading or location]
**Action:** [ADD / MODIFY / REMOVE / RECLASSIFY]

**Content to add/modify:**

```
[exact content to insert or replace, including surrounding context lines for placement]
```

**Placement:** [AFTER line/section X / BEFORE line/section Y / REPLACES section Z]

**Verification:** [how to confirm the modification is correct — e.g., count check, grep, section order]

---

### Modification 2 — [Document name]

[same structure as Modification 1]

---

## VERIFICATION

After all modifications:

```bash
# 1. Frozen Echo HEADs (end)
cd /Users/jerrysmith/Desktop/Echo/Echo          && git rev-parse HEAD
cd /Users/jerrysmith/Desktop/Echo/Echo-Internal && git rev-parse HEAD
cd /Users/jerrysmith/Desktop/Echo/echo-chain    && git rev-parse HEAD

# 2. Document structure sanity (per modified doc)
grep -c '### GAP-' wevibe-docs/MASTER.md    # verify gap count
grep -c '### D-' wevibe-docs/DECISIONS.md   # verify decision count

# 3. No orphan references
# [doc-specific grep checks — e.g., verify new GAP ID appears in Summary table]
```

---

## COMMIT & PUSH

**Git identity:**
```bash
git config user.name "Morfasco"
git config user.email "agilefox22@icloud.com"
```

**R-REMOTE-PREFLIGHT** (mandatory before commit).

```bash
cd /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-docs
git add -A
git diff --cached --stat
git commit -m "DMO-XXX: docs([scope]): [short description]

- [bullet per logical change]
- [bullet per logical change]"
git push
```