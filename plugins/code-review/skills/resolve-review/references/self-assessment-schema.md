# Self-Assessment Schema

## State File

Persisted at `.claude/convergence-state/<PR_NUMBER>.yaml` across cron iterations.
Read at the start of each run, written at the end.

```yaml
# .claude/convergence-state/<PR_NUMBER>.yaml
pr: 1805
branch: "feat-FG-XXX-description"
base_branch: "qa"
first_run: "2026-06-10 14:07"
iteration: 3
cron_job_id: "cron_abc123"

consecutive_ci_failures:
  count: 0
  failure_name: null

consecutive_thread_stalls:
  count: 0
  thread_id: null

classification_totals:
  valid_bugs: 2
  valid_conventions: 1
  valid_improvements: 3
  out_of_scope: 1
  already_handled: 0
  stale: 1
  duplicates: 0
  false_positives: 2
  preference_style: 1

last_assessment:
  # Full self_assessment block from most recent iteration
```

## Self-Assessment Block

Emitted to conversation AND appended to gate file (if exists) after every iteration.

```yaml
self_assessment:
  iteration: 3
  iteration_of_max: "3/15"
  timestamp: "2026-06-10 15:27"
  pr: 1805
  branch: "feat-FG-XXX-description"

  ci:
    status: green           # green | red | pending
    failures: []            # list of check names, or empty
    action_taken: "none needed"  # "fixed X" | "waiting" | "none needed"

  reviews:
    unresolved_threads: 0
    unreplied_comments: 0
    addressed_this_iteration: 4
    classifications:
      valid_bugs: 1
      valid_conventions: 0
      valid_improvements: 2
      out_of_scope: 0
      already_handled: 0
      stale: 0
      duplicates: 0
      false_positives: 1
      preference_style: 0
    action_taken: "addressed 4 threads"

  convergence:
    ci_green: true
    no_pending: true
    no_changes_requested: true
    all_threads_resolved: true
    all_comments_replied: true
    bot_reviews_minimized: true
    converged: true

  scope_integrity:
    files_changed_this_iteration:
      - turbo/apps/auth/Dockerfile
      - turbo/docker/migrate.sh
    all_in_pr_scope: true
    scope_violations: []

  branch_health:
    commits_ahead_of_base: 6
    commits_behind_base: 0
    merge_conflicts: false

  confidence: 0.95          # 0.0-1.0
  next_action: "CONVERGED"  # "wait for CI" | "fix CI" | "address reviews" | "CONVERGED" | "ESCALATE"
  escalation_reason: null
```

## Escalation Rules

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Same CI failure repeats | 3 consecutive iterations | ESCALATE |
| Same thread unresolvable | 3 iterations | ESCALATE |
| Max iterations reached | `iteration >= MAX_ITER` | ESCALATE |
| Merge conflicts detected | any iteration | ESCALATE |
| Branch far behind base | `behind > 5` | ESCALATE (rebase recommended) |

Escalation = delete cron + report what's stuck + suggest human action.

## Convergence Criteria

ALL must be true simultaneously:

- All CI checks: COMPLETED + SUCCESS
- No active CHANGES_REQUESTED reviews
- Zero unresolved review threads
- Zero unreplied root inline comments
- All bot review summaries minimized (Phase 6)

## Gate File Integration

If a gate file path was provided, append each iteration's assessment under:

```yaml
self_audit:
  iterations:
    - iteration: 1
      timestamp: "..."
      # ... full self_assessment block
    - iteration: 2
      timestamp: "..."
      # ...
```

Also update `convergence.state` to `CONVERGED` when convergence is reached.
