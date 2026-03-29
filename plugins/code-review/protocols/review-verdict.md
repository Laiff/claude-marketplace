# Review Verdict Protocol v1

This protocol governs how the review pipeline determines the final review action
(APPROVE, REQUEST_CHANGES, or COMMENT) and classifies the review by type.

The verdict is computed in Phase 4 (dedup-orchestrator) alongside budget enforcement,
and consumed by Phase 5 (output-composer) to post the correct GitHub review event.

---

## Review Actions

GitHub supports three review events via `gh pr review`:

| Action | GitHub event | Flag | When to use |
|--------|-------------|------|-------------|
| APPROVE | `APPROVE` | `--approve` | PR is clean or has only minor suggestions |
| REQUEST_CHANGES | `REQUEST_CHANGES` | `--request-changes` | PR has issues that MUST be fixed before merge |
| COMMENT | `COMMENT` | `--comment` | PR has advisory feedback — merge at author's discretion |

### Decision Matrix

The verdict is determined by the **surviving findings** after deduplication and budget
enforcement. Evaluate rules top-to-bottom — first match wins.

```
Rule V1: Any CRIT severity finding (any category)
         -> REQUEST_CHANGES

Rule V2: Any SEC finding with severity >= NORM on a public-facing service
         -> REQUEST_CHANGES

Rule V3: 3+ NORM findings where category is BUG
         -> REQUEST_CHANGES

Rule V4: Any NORM BUG finding (1-2 findings)
         -> COMMENT

Rule V5: Any NORM findings (CONV, SEC internal, ARCH)
         -> COMMENT

Rule V6: Only NIT findings remain
         -> COMMENT

Rule V7: 0 findings after all filtering
         -> APPROVE
```

### Verdict Calibration Guards

These guards prevent over-aggressive or under-aggressive verdicts:

**VC1: Never REQUEST_CHANGES for NITs alone**
- NIT findings are advisory by definition. Even 10 NITs = COMMENT, not REQUEST_CHANGES.
- Rationale: NIT-level request_changes erodes trust and causes "approve and move on" behavior.

**VC2: Never APPROVE with unresolved findings**
- If any finding survived all filtering, the verdict MUST be COMMENT or REQUEST_CHANGES.
- Exception: findings that are purely informational (no code change needed).

**VC3: Respect project-level overrides**
- If CLAUDE.md or REVIEW.md defines a `review_policy` section, honor it:
  ```markdown
  ## Review Policy
  - convention_violations: comment  # never block merge for conventions
  - security_findings: request_changes  # always block for security
  - auto_approve: true  # approve if no findings
  ```
- If no policy exists, use the default decision matrix above.

**VC4: Internal service downgrade**
- For cluster-internal services (detected by security-reviewer topology check):
  - Downgrade REQUEST_CHANGES to COMMENT unless finding is CRIT
  - Rationale: internal services have different risk tolerance

**VC5: Draft PR override**
- Never REQUEST_CHANGES on draft PRs (they shouldn't reach here due to preflight,
  but if they do, cap at COMMENT)

---

## Review Classification

Every review is classified by its **primary concern type**. This classification
appears in the terminal summary, PR summary comment, and feedback metrics.

### Classification Taxonomy

| Classification | When assigned | Icon |
|---------------|--------------|------|
| `security` | Majority of findings are SEC, or any CRIT SEC | :shield: |
| `bugs` | Majority of findings are BUG, or any CRIT BUG | :bug: |
| `conventions` | Majority of findings are CONV | :memo: |
| `architecture` | Majority of findings are ARCH | :building_construction: |
| `mixed` | No single category has majority (>50%) | :mag: |
| `clean` | 0 findings — PR passed all checks | :white_check_mark: |

### Classification Algorithm

```
1. Count findings by category: {BUG: N, SEC: N, CONV: N, ARCH: N}
2. Total = sum of all counts

IF total == 0:
  classification = "clean"

ELIF any CRIT SEC finding exists:
  classification = "security"

ELIF any CRIT BUG finding exists:
  classification = "bugs"

ELSE:
  dominant = category with max count
  IF count(dominant) > total * 0.5:
    classification = dominant.lowercase()
  ELSE:
    classification = "mixed"
```

### Classification Output Schema

```yaml
verdict:
  action: REQUEST_CHANGES      # APPROVE | REQUEST_CHANGES | COMMENT
  classification: security      # security | bugs | conventions | architecture | mixed | clean
  reasoning: "1 CRIT security finding (SQL injection in auth route)"
  rule_applied: V1              # Which decision matrix rule triggered
  severity_distribution:
    CRIT: 1
    NORM: 2
    NIT: 0
  category_distribution:
    SEC: 1
    BUG: 1
    CONV: 1
    ARCH: 0
  calibration_applied: []       # List of VC guards that modified the default verdict
```

---

## Integration Points

### Phase 4 (dedup-orchestrator)
- Computes verdict AFTER budget enforcement (uses final surviving findings)
- Includes `verdict` object in output to Phase 5
- Logs verdict reasoning for observability

### Phase 5 (output-composer)
- Uses `verdict.action` to determine `gh pr review` flag
- Includes `verdict.classification` in terminal summary header
- Includes verdict reasoning in PR summary comment
- Posts review with correct event type

### Feedback Loop
- `verdict.action` is tracked by feedback-learner
- If REQUEST_CHANGES reviews are frequently overridden (merged without changes),
  the decision matrix thresholds should be re-evaluated
- If APPROVE reviews are followed by revert PRs, the filtering may be too aggressive

---

## GitHub API Integration

### Posting with verdict

The `gh pr review` command maps directly:

```bash
# APPROVE
gh pr review {number} --repo {owner/repo} --approve --body-file review.md

# REQUEST_CHANGES
gh pr review {number} --repo {owner/repo} --request-changes --body-file review.md

# COMMENT (current behavior, default fallback)
gh pr review {number} --repo {owner/repo} --comment --body-file review.md
```

### API payload with inline comments + verdict

When posting inline comments with a verdict via `gh api`:

```json
{
  "event": "REQUEST_CHANGES",
  "body": "## Code Review — :shield: Security\n\nFound 3 issues...",
  "comments": [
    {
      "path": "src/auth.ts",
      "line": 15,
      "side": "RIGHT",
      "body": "**SQL injection** ..."
    }
  ]
}
```

Comments use the `line` + `side` API (NOT the legacy `position` field):
- `line` — the file line number from the finding (NEVER manually adjusted)
- `side` — always `"RIGHT"` (comment on the new version of the file)
- The `event` field accepts: `APPROVE`, `REQUEST_CHANGES`, `COMMENT`

This is the preferred method as it posts verdict + inline comments atomically.
