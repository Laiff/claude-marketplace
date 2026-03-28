# Quality Guards v3

These guards are MANDATORY for all agents and subagents. Each guard exists because
a specific failure pattern was observed in production reviews (35 runs, 700+ comments,
179 reactions, 84 minimized reviews). Guards are numbered G1-G9 for cross-reference.

---

## G1: Noise Filter

**Observed failure**: Bot posted "test" as a comment body. Received confused reaction.

- Do NOT produce findings with description < 20 characters
- Do NOT produce findings matching `/^(test|\s*)$/i`
- Do NOT produce findings with empty evidence field
- Every finding MUST have actionable content that a developer can act on

## G2: Scope Guard

**Observed failure**: Bot flagged pre-existing issues in unchanged code. Minimized as off-topic.

- ONLY flag issues on lines ADDED or MODIFIED in the PR diff (`+` lines)
- Pre-existing violations in unchanged code MUST NOT be flagged
- Exception: the PR's stated purpose is cleanup or refactor of that specific area
- Also consider scope defined in the PR title and description
- When in doubt about line scope, use `diff_line_mapper.py` to verify

## G3: Dedup Guard

**Observed failure**: Same finding posted multiple times across re-reviews. 23% of multi-run reviews had duplicates.

- Before producing a finding, check if a >80% similar finding already exists
  on the same (path, line) in the current findings list
- When re-reviewing after a push, only produce findings for NEW issues or
  issues where the flagged code actually changed since last review
- Check existing PR comments from comment-scanner output to avoid re-posting

## G4: Batch Guard

**Observed failure**: Identical `tags: ['autodocs']` comment on 4+ story files. Number one cause of spam minimization (18 instances across 35 reviews).

- When >3 files have the SAME violation (identical after normalizing file paths):
  - Set `batch_key` on the finding
  - Collect all affected file paths in `batch_files`
  - Produce ONE summary finding listing all affected files
  - Do NOT produce individual findings per file
- Format: `**[Category]** Found in N files: file1.tsx, file2.tsx, ...`

## G5: Evidence Grounding

**Observed failure**: Bot confidently claimed "actions/checkout@v6 doesn't exist" — it was released after training cutoff.

| Claim type | Max confidence without tool proof |
|-----------|----------------------------------|
| Code logic bug | 100 (code is in context) |
| CLAUDE.md violation | 100 (document is in context) |
| External fact (version, release) | **25** |
| Deprecation claim | **25** |
| Package or version claim | **25** |

External facts MUST be verified with a tool before confidence exceeds 25.
If verification contradicts the claim: DROP the finding entirely (set confidence to 0).

## G6: Exception Clauses

**Observed failure**: False positives on legitimate code patterns specific to the target repo.

**Inline styles** — Do NOT flag when:
- Runtime-computed numeric values that Tailwind cannot generate (e.g., `style={{ width: \`${pct}%\` }}`)
- Dynamic positioning values derived from state or props
- SVG `fill` or `stroke` attributes bound to runtime data

**Hardcoded colors** — Do NOT flag when:
- Brand constants defined in `tailwind.config.ts` theme extension
- SVG fill or stroke bound to runtime data
- Storybook prototypes in `stories/prototypes/`

**Enum convention** — `z.enum()` is the current convention (Zod v4):
- New code MUST use `z.enum()`
- Pre-existing `z.nativeEnum()` on unchanged lines: handled by G2 Scope Guard

## G7: Security Severity Calibration

**Observed failure**: Internal-only services flagged as CRIT for missing rate limiting.

Differentiate severity by deployment topology:
- **Public-facing routes**: Missing auth guard = CRIT
- **Cluster-internal only**: Wildcard CORS = NORM (only CRIT if exposed outside cluster)
- **Behind API gateway**: Error body leaking = NORM, not CRIT
- **Rate limiter**: Only BUG for external-facing services

Check `kubernetes/` ingress config or deployment files before escalating severity.
Internal-only services have fundamentally different threat models than public-facing endpoints.

## G8: Comment Budget

**Observed failure**: 21+ comments triggers "approve and move on" developer behavior (GitHub Copilot benchmark: 5.1 avg across 60M reviews).

- Target: 10 or fewer comments per review
- Priority order when trimming: CRIT (always keep) > NORM > NIT (drop first)
- If 0 findings survive filtering: this is a GOOD outcome. Post a clean summary.
- Silence is better than noise — if no high-signal issues exist, post nothing

## G9: False Positive Filter

Do NOT flag any of these (validated across 35 production reviews):
- Pre-existing issues in unchanged code (redundant with G2)
- Code that appears buggy but is correct given surrounding context
- Pedantic nitpicks that a senior engineer would not flag
- Issues that a linter will catch (do not run the linter to verify either)
- General quality concerns unless explicitly required in CLAUDE.md
- Code with lint-ignore or suppress comments
- External fact claims without tool verification (redundant with G5)
- Claims where evidence is only "I checked" or "verified" without tool output or code quote

## G10: Verdict Calibration

**Observed failure**: Over-aggressive REQUEST_CHANGES on internal services or NIT-only reviews
erodes developer trust and causes "approve and move on" behavior.

The review verdict (APPROVE, REQUEST_CHANGES, COMMENT) must be calibrated:

- **Never REQUEST_CHANGES for NIT-only reviews** — NITs are advisory. Even 10 NITs = COMMENT.
- **Never APPROVE with surviving findings** — any finding means COMMENT at minimum.
- **Calibrate by service topology** — internal services downgrade REQUEST_CHANGES to COMMENT
  unless CRIT severity. Use the same topology detection as G7 (Security Calibration).
- **Honor project-level overrides** — if CLAUDE.md defines `review_policy`, respect it:
  - `convention_violations: comment` means CONV findings never trigger REQUEST_CHANGES
  - `auto_approve: true` means approve when 0 findings survive
- **Draft PRs cap at COMMENT** — never REQUEST_CHANGES on drafts (preflight should skip, but guard anyway)

See `protocols/review-verdict.md` for the full decision matrix and calibration guards (VC1-VC5).
