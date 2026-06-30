---
name: resolve-review
description: >-
  This skill should be used when the user asks to "monitor a PR", "converge PR",
  "watch CI for PR", "address review comments", "fix CI failures on PR",
  "babysit PR", "keep PR green", "auto-resolve review threads",
  "get this PR to green", "make this PR ready to merge", "shepherd this PR",
  or provides a PR number or gate file expecting autonomous convergence monitoring.
  Self-schedules via CronCreate, runs CI checks, triages review comments
  (reviewer may be wrong), fixes failures, and self-assesses each iteration.
---

# PR Convergence Monitor

Autonomous CI + review convergence loop. Self-schedules via CronCreate,
checks CI, triages review comments (reviewers may be wrong), dispatches
fix agents, auto-resolves threads, and self-assesses each iteration until
the PR converges or escalates.

## Input

Parse `$ARGUMENTS` for exactly ONE of:
- **PR number** — `1805` or `#1805`
- **Gate file path** — `.claude/gates/FG-1047-migration-containers.yaml`

Optional flags after the primary argument:
- `--cron '<expr>'` — custom schedule (default: `7,27,47 * * * *`)
- `--max-iterations <n>` — escalation limit (default: `15`)
- `--no-cron` — single iteration, no scheduling

If arguments are empty or invalid, print usage and stop:
```
Usage: /resolve-review <PR_NUMBER|GATE_FILE> [--cron '<expr>'] [--max-iterations <n>] [--no-cron]
```

## Scripts Reference

All scripts live in `scripts/` relative to this skill directory. Execute directly — no regeneration needed. Each accepts positional args and outputs JSON.

| Script | Args | Purpose |
|--------|------|---------|
| `pr-health.sh` | `<PR>` | PR state/draft/mergeable check. Exit 1 = not actionable |
| `ci-status.sh` | `<PR>` | CI status → `{pending[], failed[], summary, verdict}`. Handles no-CI PRs |
| `blocking-reviews.sh` | `<PR>` | CHANGES_REQUESTED reviews → `[{login, state, id}]`. Honors `$REPO` |
| `unresolved-threads.sh` | `<PR>` | Unresolved threads via GraphQL → `[{thread_id, path, line, author, body}]`. Honors `$REPO` |
| `unreplied-comments.sh` | `<PR>` | Root comments with zero replies (REST) → `{id, path, line, body_preview}` per line. Honors `$REPO` |
| `failed-run-logs.sh` | `<BRANCH> [TAIL]` | Failed CI run logs, last N lines (default 200) |
| `resolve-thread.sh` | `<THREAD_ID>` | Resolve a single review thread via GraphQL mutation |
| `dismiss-resolved-reviews.sh` | `<PR>` | Minimize resolved bot review summaries (RESOLVED/OUTDATED). Honors `$REPO` |
| `branch-freshness.sh` | `<BRANCH> <BASE>` | Commits ahead/behind → `{ahead, behind, recommendation}` |

Scripts that query the GitHub API honor the `REPO` env var (auto-detected if unset):
`REPO=Reluna-Family/FG scripts/blocking-reviews.sh 1805`

## Workflow

### Phase 0 — Resolve + Early Exit

Dispatch a parameter-resolution agent:

1. Parse `$ARGUMENTS` for PR number, gate file, flags
2. If gate file given, read it to extract `metadata.pr_number` and `metadata.head_branch`
3. Run `scripts/pr-health.sh $PR_NUMBER`
   - Exit 1 → PR is CLOSED/MERGED/DRAFT/CONFLICTING → delete cron if exists, STOP
4. Read state file `.claude/convergence-state/$PR_NUMBER.yaml` if it exists (restores iteration count, consecutive failure tracking)
5. Run `scripts/branch-freshness.sh $BRANCH $BASE` — if `behind > 5` → ESCALATE

### Phase 1 — Self-Schedule (first run only)

CronCreate/CronList/CronDelete are orchestrator-level — execute directly, not via agents.

Skip if `--no-cron` was passed.

1. CronList → scan for existing job containing this PR number → skip if found
2. CronCreate with `cron: $CRON_EXPR`, `recurring: true`, prompt: `/resolve-review $PR_NUMBER --no-cron --max-iterations $MAX_ITER`
3. On first interactive run (not cron-triggered), print a brief summary of the monitor plan before proceeding

### Phase 2 — CI Check

Dispatch agent to run `scripts/ci-status.sh $PR_NUMBER`.

| Verdict | Action |
|---------|--------|
| `pending` | Report "waiting for CI" → Phase 7 (self-assess) → STOP |
| `failed` | → Phase 4 (Fix CI) |
| `green` | → Phase 3 (Review comments) |

### Phase 3 — Review Analysis

Dispatch agent(s) to run in parallel:
- `scripts/blocking-reviews.sh $PR_NUMBER`
- `scripts/unresolved-threads.sh $PR_NUMBER`
- `scripts/unreplied-comments.sh $PR_NUMBER`

| Result | Action |
|--------|--------|
| Unresolved threads or unreplied comments exist | → Phase 5 (Address) |
| All clear + CI green | → Phase 6 (Dismiss Reviews) → Phase 7 with `converged: true` |

### Phase 4 — Fix CI Failures

Dispatch a dedicated fix agent with:
- Output of `scripts/failed-run-logs.sh $BRANCH`
- Output of `scripts/branch-freshness.sh $BRANCH $BASE`
- Gate file path (if exists) as authoritative reference
- Instruction to read CLAUDE.md before any code changes

Agent instructions:
1. Analyze root cause from failed logs
2. Read relevant source files
3. If gate file exists, update `self_audit` section with findings
4. Fix — keep changes minimal, scoped to the CI failure
5. Commit: `fix(ci): <description>`
6. Push
7. STOP — never re-check convergence in the same iteration that made changes

**Scope guard:** no unrelated refactors, no files outside the PR diff, no `[deploy-it]` in commit, no force push. If fix requires out-of-scope changes → report and STOP.

### Phase 5 — Address Review Comments

For each unresolved thread, dispatch a dedicated agent that follows the classification guide in `references/classification-guide.md`.

The agent receives:
- Thread data (from Phase 3 output)
- Gate file path and scope (if exists)
- Instruction to read CLAUDE.md + turbo/CLAUDE.md before classifying

For each thread the agent must:
1. Read full thread, actual code at path:line, and PR diff for that file
2. Check if referenced code still exists (stale detection)
3. Classify per `references/classification-guide.md` (9 categories, priority order)
4. Execute the action (fix / reply)
5. Run `scripts/resolve-thread.sh <THREAD_ID>` to resolve

After all threads: commit fixes in a single commit `fix(review): address review feedback`, push, STOP.

**Never re-check convergence in the same iteration that made changes.**

### Phase 6 — Dismiss Resolved Reviews

Runs only when convergence is confirmed (all threads resolved, CI green, no blockers).
Collapses bot review summaries so the PR timeline is clean for the human merge decision.

1. Run `scripts/dismiss-resolved-reviews.sh $PR_NUMBER`
2. The script finds all non-minimized bot review summaries (`github-actions[bot]` or any `*[bot]` author) with non-empty body text
3. Minimizes each with the appropriate classifier:
   - `RESOLVED` — for CHANGES_REQUESTED reviews whose threads were all addressed
   - `OUTDATED` — for informational/stale summaries
4. Human reviews are never auto-minimized — listed for awareness only

Classifier reference (GitHub `ReportedContentClassifiers` enum):
- `RESOLVED` — issue addressed in code
- `OUTDATED` — superseded by newer commits
- `DUPLICATE` — same concern raised elsewhere
- `OFF_TOPIC` — not relevant to the PR

This phase is idempotent — re-running on an already-minimized review is a no-op.

### Phase 7 — Self-Assessment + Convergence

Runs after EVERY iteration. Follow the schema in `references/self-assessment-schema.md`.

1. **Persist state** to `.claude/convergence-state/$PR_NUMBER.yaml` — iteration count, timestamps, consecutive failure counters, classification totals
2. **Emit self-assessment** YAML to conversation
3. **If gate file exists**, append iteration summary under `self_audit.iterations[]`

**Convergence check** (all must be true):
- CI green, no pending checks
- No CHANGES_REQUESTED reviews
- Zero unresolved threads
- Zero unreplied comments
- All bot review summaries minimized (Phase 6 complete)

If converged:
- Update gate file `convergence.state` → `CONVERGED`
- CronDelete the monitoring job
- Report final summary with commit chain and classification totals

**Escalation** (delete cron + report):
- Same CI failure for 3 consecutive iterations
- Same thread unresolvable for 3 iterations
- `iteration >= MAX_ITER`
- Merge conflicts or branch far behind base

## Orchestrator Convention

Follows CLAUDE.md rule 11 — orchestrator-only:

- Main session never reads repo files, runs lint/test/build, or commits
- Every task dispatches via `Agent(...)` with repo context, gate file refs, explicit deliverables, and required return format
- Parallel-independent agents dispatch in one message
- Fix agents post only thread replies, never general PR comments
- CronCreate/CronList/CronDelete are orchestrator-level meta-operations — executed directly

## Additional Resources

- **`references/classification-guide.md`** — 9-category review comment classification with verification checklist and reply templates
- **`references/self-assessment-schema.md`** — state file format, self-assessment YAML schema, escalation rules, convergence criteria
- **`scripts/`** — 9 parameterized bash scripts, all executable directly with `bash scripts/<name>.sh <args>`
