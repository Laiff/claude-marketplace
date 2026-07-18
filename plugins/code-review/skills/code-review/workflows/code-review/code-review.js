// ============================================================================
// Universal Code Review Workflow v1.0.0
// ============================================================================
// Synthesized from analysis of 218 generated workflow scripts.
// Eliminates: duplication, inconsistencies, protocol violations, drift.
//
// Usage (via Workflow tool):
//   Workflow({ name: 'code-review', args: {
//     owner: 'Reluna-Family',
//     repo: 'FG',
//     pr_number: 1873,
//     post_flag: true,
//     context_dir: '/_work/.../FG/FG/.claude-review-context',
//     head_sha: 'abc123...',
//     plugin_dir: '/root/.claude/plugins/cache/laiff-claude-marketplace/code-review/4.8.0'
//   }})
// ============================================================================

export const meta = {
  name: 'code-review',
  description: 'Evidence-driven multi-agent PR code review with dedup and GitHub posting',
  whenToUse: 'When reviewing a pull request for bugs, conventions, and security issues. Invoke from the code-review skill with args containing owner, repo, pr_number, post_flag, context_dir, head_sha, and plugin_dir.',
  phases: [
    { title: 'Preflight', detail: 'Gate check — should this PR be reviewed?' },
    { title: 'Context',   detail: 'Gather conventions, summarize PR, scan existing comments' },
    { title: 'Review',    detail: 'Convention, bug, and security review in parallel', model: 'sonnet' },
    { title: 'Verify',    detail: 'Evidence grounding and cross-validation', model: 'sonnet' },
    { title: 'Dedup',     detail: 'Three-layer dedup, batch guard, budget cap, verdict' },
    { title: 'Compose',   detail: 'Terminal summary + post atomic GitHub review', model: 'sonnet' },
  ],
}

let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch (e) { /** do nothing */}
}

// ── Args validation ─────────────────────────────────────────────────────────

const OWNER       = _args?.owner
const REPO        = _args?.repo
const PR_NUMBER   = _args?.pr_number
const POST_FLAG   = _args?.post_flag ?? false
const CTX         = _args?.context_dir   // e.g. '/_work/.../FG/FG/.claude-review-context'
const HEAD_SHA    = _args?.head_sha
const PLUGIN      = _args?.plugin_dir    // e.g. '/root/.claude/plugins/cache/.../code-review/4.8.0'
const FULL_REPO   = `${OWNER}/${REPO}`

if (!OWNER || !REPO || !PR_NUMBER) {
  log('FATAL: args must include owner, repo, pr_number')
  return { error: 'Missing required args: owner, repo, pr_number' }
}

// Paths to plugin protocol and agent instruction files
const AGENTS    = PLUGIN ? `${PLUGIN.split('/').slice(0, -2).join('/')}/agents` : null
const PROTOCOLS = PLUGIN ? `${PLUGIN}/protocols` : null

// Helper: build agent instruction reference or inline fallback
const agentRef = (name) =>
  AGENTS ? `Read your full instructions from: ${AGENTS}/${name}.md` : ''
const protocolRef = (name) =>
  PROTOCOLS ? `Read protocol: ${PROTOCOLS}/${name}.md` : ''

// Helper: build data source instruction
const diffSource = CTX
  ? `Read the diff from: ${CTX}/diff.txt — do NOT call gh pr diff.`
  : `Run: gh pr diff ${PR_NUMBER} --repo ${FULL_REPO}`
const metaSource = CTX
  ? `Read PR metadata from: ${CTX}/pr_meta.yaml — do NOT call gh pr view.`
  : `Run: gh pr view ${PR_NUMBER} --repo ${FULL_REPO} --json title,body,files,additions,deletions,commits,labels,isDraft,state,headRefOid`
const priorSource = CTX
  ? `Read prior reviews from: ${CTX}/prior_reviews.yaml — do NOT call gh api for reviews.`
  : `Run: gh api repos/${FULL_REPO}/pulls/${PR_NUMBER}/reviews`
const contextEnvelope = CTX
  ? `Context envelope: ${CTX}/context.yaml`
  : ''
const filePatchesSource = CTX
  ? `File patches for inlineability: ${CTX}/file_patches.json`
  : ''

// ── Schemas (defined once, reused across phases) ────────────────────────────

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['proceed', 'reason'],
  properties: {
    proceed:              { type: 'boolean' },
    reason:               { type: 'string' },
    is_fix_verification:  { type: 'boolean' },
    prior_review_sha:     { type: ['string', 'null'] },
  },
}

const PRIOR_VERIFICATION_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    required: ['dedup_key', 'description', 'status', 'reasoning'],
    properties: {
      dedup_key:    { type: 'string' },
      description:  { type: 'string' },
      file:         { type: 'string' },
      line:         { type: 'number' },
      category:     { type: 'string' },
      status:       { type: 'string', enum: ['fixed', 'not_fixed', 'partially_fixed'] },
      reasoning:    { type: 'string' },
    },
  },
}

const FINDING_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'file', 'line', 'category', 'severity', 'confidence',
                    'claim_type', 'description', 'evidence', 'suggestion', 'suggestion_type'],
        properties: {
          id:                   { type: 'string' },
          file:                 { type: 'string' },
          line:                 { type: 'number' },
          end_line:             { type: ['number', 'null'] },
          category:             { type: 'string', enum: ['BUG', 'SEC', 'PERF', 'CONV', 'ARCH', 'TEST'] },
          severity:             { type: 'string', enum: ['CRIT', 'NORM', 'NIT'] },
          confidence:           { type: 'number' },
          claim_type:           { type: 'string', enum: ['code_logic', 'claude_md', 'external_fact', 'deprecation', 'package_version'] },
          description:          { type: 'string' },
          evidence:             { type: 'string' },
          suggestion:           { type: 'string' },
          suggestion_type:      { type: 'string', enum: ['code', 'description', 'none'] },
          claude_md_ref:        { type: ['string', 'null'] },
          claude_md_path:       { type: ['string', 'null'] },
          // Phase 3 fields — initialized empty by Phase 2
          validated:            { type: 'boolean' },
          validation_reasoning: { type: 'string' },
          adjusted_confidence:  { type: ['number', 'null'] },
          // Phase 4 fields — initialized empty by Phase 2
          batch_key:            { type: ['string', 'null'] },
          batch_files:          { type: 'array', items: { type: 'string' } },
          batched:              { type: 'boolean' },
          also_affects:         { type: 'array', items: { type: 'string' } },
          dedup_layer_applied:  { type: ['string', 'null'] },
        },
      },
    },
    // Fix-verification: review agents report fix status of prior findings
    prior_verification: PRIOR_VERIFICATION_ITEMS,
  },
}

const VERIFIED_SCHEMA = {
  type: 'object',
  required: ['findings', 'dropped_count'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'file', 'line', 'category', 'severity', 'confidence',
                    'validated', 'adjusted_confidence'],
        properties: {
          id:                   { type: 'string' },
          file:                 { type: 'string' },
          line:                 { type: 'number' },
          end_line:             { type: ['number', 'null'] },
          category:             { type: 'string' },
          severity:             { type: 'string' },
          confidence:           { type: 'number' },
          claim_type:           { type: 'string' },
          description:          { type: 'string' },
          evidence:             { type: 'string' },
          suggestion:           { type: 'string' },
          suggestion_type:      { type: 'string' },
          claude_md_ref:        { type: ['string', 'null'] },
          claude_md_path:       { type: ['string', 'null'] },
          source_agent:         { type: 'string' },
          validated:            { type: 'boolean' },
          validation_reasoning: { type: 'string' },
          adjusted_confidence:  { type: ['number', 'null'] },
          batch_key:            { type: ['string', 'null'] },
          batch_files:          { type: 'array', items: { type: 'string' } },
          batched:              { type: 'boolean' },
          also_affects:         { type: 'array', items: { type: 'string' } },
          dedup_layer_applied:  { type: ['string', 'null'] },
        },
      },
    },
    dropped_count:   { type: 'number' },
    dropped_reasons: { type: 'object' },
  },
}

const DEDUP_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict', 'stats'],
  properties: {
    findings: { type: 'array', items: { type: 'object' } },
    verdict: {
      type: 'object',
      required: ['action', 'classification', 'reasoning', 'rule_applied'],
      properties: {
        action:                { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
        classification:        { type: 'string', enum: ['security', 'bugs', 'conventions', 'architecture', 'mixed', 'clean', 'fix-verified', 'fix-incomplete'] },
        reasoning:             { type: 'string' },
        rule_applied:          { type: 'string' },
        severity_distribution: { type: 'object' },
        category_distribution: { type: 'object' },
        calibration_applied:   { type: 'array', items: { type: 'string' } },
      },
    },
    stats: {
      type: 'object',
      properties: {
        input_count:                  { type: 'number' },
        after_exact_dedup:            { type: 'number' },
        after_proximity_dedup:        { type: 'number' },
        after_semantic_dedup:         { type: 'number' },
        after_existing_comment_filter:{ type: 'number' },
        batch_groups_created:         { type: 'number' },
        batch_findings_consolidated:  { type: 'number' },
        budget_trimmed_count:         { type: 'number' },
        final_count:                  { type: 'number' },
      },
    },
  },
}

// ── Shared prompt fragments (defined once) ──────────────────────────────────

const QUALITY_GUARDS_BRIEF = `
MANDATORY QUALITY GUARDS:
- G1 NOISE: description >= 20 chars, evidence non-empty, no test/blank bodies.
- G2 SCOPE: ONLY flag "+" lines in the diff. Pre-existing code is OUT OF SCOPE.
- G3 DEDUP: Check existing comment dedup_keys — do not re-post.
- G4 BATCH: >3 files with identical violation → 1 summary finding with batch_key.
- G5 EVIDENCE: External fact claims MAX confidence 25 without tool verification.
- G6 EXCEPTIONS: Do NOT flag runtime-computed inline styles, SVG fill/stroke with runtime data,
  brand constants in tailwind.config.ts, Storybook prototypes, z.nativeEnum() on unchanged lines.
- G7 SEVERITY CALIBRATION: Internal services downgrade CRIT→NORM unless truly critical.
  Public-facing services (family-portal) use full severity.
- G9 FALSE POSITIVES: When in doubt, do NOT flag. Check 20 lines context.
- G11 FIX-VERIFICATION: If is_fix_verification is true, do NOT contradict prior review
  recommendations. Only flag genuinely NEW issues since prior review commit.
- G12 PRIOR VERIFICATION: If is_fix_verification is true, for EACH existing dedup_key,
  report whether the issue was fixed/not_fixed/partially_fixed in prior_verification[].
  This is SEPARATE from findings[] — it reports fix status, not new issues.`

const FINDING_INIT_FIELDS = `
Initialize Phase 3/4 fields as defaults:
validated: false, validation_reasoning: "", adjusted_confidence: null,
batch_key: null, batch_files: [], batched: false, also_affects: [], dedup_layer_applied: null`


// ============================================================================
// PHASE 0: PREFLIGHT
// ============================================================================

phase('Preflight')

const preflight = await agent(
  `You are the preflight gate for a code review pipeline.
${agentRef('preflight')}

Determine whether PR #${PR_NUMBER} in ${FULL_REPO} should be reviewed.

${metaSource}
${priorSource}
${contextEnvelope}

Evaluate in order (stop on first failure):
1. PR is closed or merged → proceed: false
2. PR is a draft → proceed: false
3. Prior bot review on an OLDER commit → proceed: true (set is_fix_verification: true)
4. Bot already reviewed THIS commit (same SHA, body >= 20 chars) → proceed: false
5. Trivial automation (dependabot/renovate, only lock files) → proceed: false

If unsure, default to proceed: true.`,
  { label: 'preflight', phase: 'Preflight', model: 'haiku',
    agentType: 'code-review:preflight', schema: PREFLIGHT_SCHEMA }
)

if (!preflight || !preflight.proceed) {
  const reason = preflight?.reason ?? 'Preflight agent returned null'
  log(`STOPPED: ${reason}`)
  return { stopped: true, reason, pr: `${FULL_REPO}#${PR_NUMBER}` }
}

const isFixVerification = preflight.is_fix_verification ?? false
log(`Preflight passed (fix_verification: ${isFixVerification}) — proceeding`)


// ============================================================================
// PHASE 1: CONTEXT GATHERING (3 parallel haiku agents)
// ============================================================================

phase('Context')

const [rawContext, rawSummary, rawComments] = await parallel([
  // ── 1A: Context Collector ──
  () => agent(
    `You are the context-collector agent for a code review pipeline.
${agentRef('context-collector')}

Gather ALL relevant CLAUDE.md content for PR #${PR_NUMBER} in ${FULL_REPO}.

${CTX ? `Read ${CTX}/relevant_claude_mds.txt for the list of relevant CLAUDE.md paths, then read each file completely.` : `Run: gh pr view ${PR_NUMBER} --repo ${FULL_REPO} --json files to find changed areas, then read CLAUDE.md files in those directories.`}

For each CLAUDE.md found, extract:
- Numbered conventions
- Numbered constraints

Return a JSON object with a "claude_mds" array, each with: path, scope, conventions, constraints.`,
    { label: 'context-collector', phase: 'Context', model: 'haiku',
      agentType: 'code-review:context-collector',
      schema: {
        type: 'object',
        required: ['claude_mds'],
        properties: {
          claude_mds: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path:        { type: 'string' },
                scope:       { type: 'string' },
                applies_to:  { type: 'string' },
                conventions: { type: 'array', items: { type: 'object',
                  properties: { number: { type: 'number' }, text: { type: 'string' } } } },
                constraints: { type: 'array', items: { type: 'object',
                  properties: { number: { type: 'number' }, text: { type: 'string' } } } },
              },
            },
          },
        },
      },
    }
  ),

  // ── 1B: PR Summarizer ──
  () => agent(
    `You are the pr-summarizer agent for a code review pipeline.
${agentRef('pr-summarizer')}

Produce a structured summary of PR #${PR_NUMBER} in ${FULL_REPO}.

${metaSource}
${diffSource}
${priorSource}

Fix-verification mode: ${isFixVerification}

Return a JSON object with a "pr_summary" object containing: title, intent, type, scope,
additions, deletions, files_changed, file_groups, key_changes, risk_areas, head_sha,
is_fix_verification, prior_review_commit, prior_findings, prior_accepted.`,
    { label: 'pr-summarizer', phase: 'Context', model: 'haiku',
      agentType: 'code-review:pr-summarizer',
      schema: {
        type: 'object',
        required: ['pr_summary'],
        properties: {
          pr_summary: {
            type: 'object',
            properties: {
              title:                { type: 'string' },
              intent:               { type: 'string' },
              type:                 { type: 'string' },
              scope:                { type: 'string' },
              additions:            { type: 'number' },
              deletions:            { type: 'number' },
              files_changed:        { type: 'number' },
              file_groups:          { type: 'object' },
              key_changes:          { type: 'array', items: { type: 'string' } },
              risk_areas:           { type: 'array', items: { type: 'string' } },
              head_sha:             { type: 'string' },
              is_fix_verification:  { type: 'boolean' },
              prior_review_commit:  { type: ['string', 'null'] },
              prior_findings:       { type: 'array', items: { type: 'string' } },
              prior_accepted:       { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }
  ),

  // ── 1C: Comment Scanner ──
  () => agent(
    `You are the comment-scanner agent for a code review pipeline.
${agentRef('comment-scanner')}

Build a deduplication index from existing review comments on PR #${PR_NUMBER} in ${FULL_REPO}.

${priorSource}

Extract:
- Inline comment keys (path + line + topic)
- PR-level comment keys
- Full body of the most recent bot review (up to 2000 chars) for Guard G11
- Prior review signals (accepted, rejected, pending counts)

Return a JSON object with "existing_comments".`,
    { label: 'comment-scanner', phase: 'Context', model: 'haiku',
      agentType: 'code-review:comment-scanner',
      schema: {
        type: 'object',
        required: ['existing_comments'],
        properties: {
          existing_comments: {
            type: 'object',
            properties: {
              inline:                  { type: 'array' },
              pr_level:                { type: 'array' },
              dedup_keys:              { type: 'array', items: { type: 'string' } },
              has_prior_review:        { type: 'boolean' },
              prior_review_signals:    { type: 'object' },
              prior_bot_review_body:   { type: 'string' },
              prior_bot_review_commit: { type: ['string', 'null'] },
            },
          },
        },
      },
    }
  ),
])

// ── Fail-safe defaults (per agent-communication.md §Error Handling) ─────────

const claudeMds = rawContext?.claude_mds ?? []
const prSummary = rawSummary?.pr_summary ?? {
  title: '', intent: 'Unknown — summarizer failed', type: 'unknown', scope: '',
  additions: 0, deletions: 0, files_changed: 0, file_groups: {},
  key_changes: [], risk_areas: [], head_sha: HEAD_SHA ?? '',
  is_fix_verification: isFixVerification, prior_review_commit: null,
  prior_findings: [], prior_accepted: [],
}
const existingComments = rawComments?.existing_comments ?? {
  inline: [], pr_level: [], dedup_keys: [], has_prior_review: false,
  prior_review_signals: { accepted: 0, rejected: 0, pending: 0 },
  prior_bot_review_body: '', prior_bot_review_commit: null,
}

const headSha = HEAD_SHA ?? prSummary.head_sha ?? ''

log(`[Phase 1] ${claudeMds.length} CLAUDE.md files | ${prSummary.files_changed} files in PR | ${existingComments.dedup_keys.length} existing comment keys`)

// ── Build Phase 1 context summary for Phase 2 agents ────────────────────────

const phase1Summary = `
PR: ${FULL_REPO}#${PR_NUMBER}
Title: ${prSummary.title}
Intent: ${prSummary.intent}
Type: ${prSummary.type}
Scope: ${prSummary.scope}
Files changed: ${prSummary.files_changed}
Is fix-verification: ${prSummary.is_fix_verification}
Risk areas: ${JSON.stringify(prSummary.risk_areas)}
Key changes: ${JSON.stringify(prSummary.key_changes)}
Existing comment dedup_keys: ${JSON.stringify(existingComments.dedup_keys)}
Has prior review: ${existingComments.has_prior_review}`


// ============================================================================
// PHASE 2: REVIEW (3 parallel sonnet agents)
// ============================================================================

phase('Review')

const reviewPromptBase = `
DATA SOURCES (read these, do NOT call gh commands unless files are missing):
${diffSource}
${contextEnvelope}

PHASE 1 CONTEXT:
${phase1Summary}

${protocolRef('finding-schema')}
${protocolRef('quality-guards')}

${QUALITY_GUARDS_BRIEF}

${FINDING_INIT_FIELDS}

Return a JSON object with:
- "findings" array (new issues only — empty array is valid)
- "prior_verification" array (fix status of each existing dedup_key — empty if not fix-verification)

PRIOR VERIFICATION (G12): If is_fix_verification is true AND dedup_keys exist above,
for EACH dedup_key determine whether the prior issue was fixed, not_fixed, or partially_fixed
in the current commit. Examine the diff and current code. Return one entry per dedup_key:
{ dedup_key, description (1-line summary), file, line, category, status, reasoning }.
If is_fix_verification is false or no dedup_keys, return prior_verification: [].`

const [rawConv, rawBug, rawSec] = await parallel([
  // ── 2A: Convention Checker ──
  () => agent(
    `You are the convention-checker agent for a code review pipeline.
${agentRef('convention-checker')}

Audit every ADDED or MODIFIED line (+ lines only) in PR #${PR_NUMBER} (${FULL_REPO}) for CLAUDE.md convention violations.

${reviewPromptBase}
\`\`\`json
${JSON.stringify(rawContext?.claude_mds, null, "  ")}
\`\`\`

CLAIM TYPE: All convention findings must have claim_type: "claude_md".
CONFIDENCE: 90-100 for clear CLAUDE.md violations (the text is in context).
SEVERITY: NIT for style/naming, NORM for structural conventions.

For each finding, include:
- claude_md_ref: exact convention number and text quoted from CLAUDE.md
- claude_md_path: path to the CLAUDE.md containing the rule`,
    { label: 'convention-checker', phase: 'Review', model: 'sonnet',
      agentType: 'code-review:convention-checker', schema: FINDING_SCHEMA }
  ),

  // ── 2B: Bug Detector ──
  () => agent(
    `You are the bug-detector agent for a code review pipeline.
${agentRef('bug-detector')}

Scan changed code in PR #${PR_NUMBER} (${FULL_REPO}) for bugs: logic errors, type errors, null dereferences, resource leaks, race conditions, unhandled errors.

${reviewPromptBase}

YOUR BAR IS HIGH: Only flag issues where you are CERTAIN the code is wrong.

DO NOT FLAG: style concerns, potential issues dependent on inputs, linter-catchable issues,
pre-existing bugs, missing test coverage, performance concerns.

SELF-VERIFICATION: Before emitting each finding, ask:
1. Is this actually a bug, or just unusual code?
2. Does surrounding context (20 lines) explain this pattern?
3. Would TypeScript/ESLint catch this?
4. Is this only on "+" lines?
5. Could the author have intended this?
If any answer creates doubt, do NOT emit.

CLAIM TYPE: "code_logic" for most bugs.`,
    { label: 'bug-detector', phase: 'Review', model: 'sonnet',
      agentType: 'code-review:bug-detector', schema: FINDING_SCHEMA }
  ),

  // ── 2C: Security Reviewer ──
  () => agent(
    `You are the security-reviewer agent for a code review pipeline.
${agentRef('security-reviewer')}

Scan changed code in PR #${PR_NUMBER} (${FULL_REPO}) for security vulnerabilities and architectural issues.

${reviewPromptBase}

SEVERITY CALIBRATION (Guard G7 — check deployment topology before setting severity):
- Public-facing services (e.g. family-portal, Next.js apps): full severity
- Cluster-internal services (e.g. Hono APIs behind ingress): downgrade CRIT→NORM, NORM→NIT unless truly critical
- Check kubernetes/ or docker-compose.yml for topology clues

SECURITY CHECKS: hardcoded secrets (CRIT always), SQL injection, XSS, missing auth,
CORS misconfiguration, command injection, error body leaking, sensitive data exposure.

ARCHITECTURE CHECKS: missing error handling at I/O boundaries (NORM), hardcoded config (NIT).`,
    { label: 'security-reviewer', phase: 'Review', model: 'sonnet',
      agentType: 'code-review:security-reviewer', schema: FINDING_SCHEMA }
  ),
])

// ── Structured merge with source_agent tagging ──────────────────────────────

const allFindings = [
  ...(rawConv?.findings ?? []).map(f => ({ ...f, source_agent: 'convention-checker' })),
  ...(rawBug?.findings  ?? []).map(f => ({ ...f, source_agent: 'bug-detector' })),
  ...(rawSec?.findings  ?? []).map(f => ({ ...f, source_agent: 'security-reviewer' })),
]

const convCount = (rawConv?.findings ?? []).length
const bugCount  = (rawBug?.findings  ?? []).length
const secCount  = (rawSec?.findings  ?? []).length

// ── Merge prior_verification from all review agents (dedup by dedup_key) ────

const rawPriorVerification = [
  ...(rawConv?.prior_verification ?? []),
  ...(rawBug?.prior_verification  ?? []),
  ...(rawSec?.prior_verification  ?? []),
]
const priorVerificationMap = new Map()
for (const v of rawPriorVerification) {
  const existing = priorVerificationMap.get(v.dedup_key)
  if (!existing || (v.reasoning ?? '').length > (existing.reasoning ?? '').length) {
    priorVerificationMap.set(v.dedup_key, v)
  }
}
const priorVerification = [...priorVerificationMap.values()]
const priorVerificationSummary = priorVerification.length > 0
  ? {
      total:            priorVerification.length,
      fixed:            priorVerification.filter(v => v.status === 'fixed').length,
      not_fixed:        priorVerification.filter(v => v.status === 'not_fixed').length,
      partially_fixed:  priorVerification.filter(v => v.status === 'partially_fixed').length,
      items:            priorVerification,
    }
  : null

log(`[Phase 2] ${allFindings.length} findings (conv: ${convCount}, bug: ${bugCount}, sec: ${secCount})`)
if (priorVerificationSummary) {
  log(`[Phase 2] Prior verification: ${priorVerificationSummary.fixed}/${priorVerificationSummary.total} fixed, ${priorVerificationSummary.not_fixed} not fixed, ${priorVerificationSummary.partially_fixed} partially fixed`)
}


// ============================================================================
// SHORT-CIRCUIT: 0 findings → skip Phase 3+4, go straight to Compose
// (per agent-communication.md §Empty Finding Set)
// ============================================================================

if (allFindings.length === 0) {
  // ── Fix-verification: check if prior findings remain unfixed (VC6) ────────
  const hasUnfixedPrior = isFixVerification && priorVerificationSummary
    && (priorVerificationSummary.not_fixed > 0 || priorVerificationSummary.partially_fixed > 0)
  const allPriorFixed = isFixVerification && priorVerificationSummary
    && priorVerificationSummary.not_fixed === 0 && priorVerificationSummary.partially_fixed === 0

  const shortCircuitVerdict  = hasUnfixedPrior ? 'COMMENT' : 'APPROVE'
  const shortCircuitClass    = hasUnfixedPrior ? 'fix-incomplete'
                             : allPriorFixed   ? 'fix-verified'
                             :                   'clean'
  const shortCircuitIcon     = hasUnfixedPrior ? ':mag:' : ':white_check_mark:'
  const shortCircuitLabel    = hasUnfixedPrior ? 'Fix Incomplete' : allPriorFixed ? 'Fix Verified' : 'Clean'
  const shortCircuitRule     = hasUnfixedPrior ? 'V7+VC6' : 'V7'
  const shortCircuitFlag     = hasUnfixedPrior ? '--comment' : '--approve'

  if (hasUnfixedPrior) {
    log(`0 new findings but ${priorVerificationSummary.not_fixed} prior findings NOT fixed — COMMENT verdict (VC6 override)`)
  } else if (allPriorFixed) {
    log(`0 new findings, all ${priorVerificationSummary.total} prior findings verified fixed — APPROVE (fix-verified)`)
  } else {
    log('0 findings — clean PR, skipping Phase 3+4')
  }

  // ── Build verification table markdown for the composer ────────────────────
  const verificationTableMd = priorVerificationSummary
    ? `\n### Prior Findings Verification\n\n` +
      `| # | Status | File | Prior Issue | Verification |\n` +
      `|---|--------|------|-------------|---------------|\n` +
      priorVerificationSummary.items.map((v, i) => {
        const icon = v.status === 'fixed' ? ':white_check_mark: Fixed'
                   : v.status === 'partially_fixed' ? ':warning: Partial'
                   : ':x: Not Fixed'
        return `| ${i + 1} | ${icon} | \`${v.file}:${v.line}\` | ${v.description} | ${v.reasoning} |`
      }).join('\n') +
      `\n`
    : ''

  const verificationStats = priorVerificationSummary
    ? `Prior verification: ${priorVerificationSummary.fixed}/${priorVerificationSummary.total} fixed`
    : ''

  const shortCircuitReasoning = hasUnfixedPrior
    ? `0 new issues, but ${priorVerificationSummary.not_fixed} prior findings remain unfixed`
    : allPriorFixed
    ? `All ${priorVerificationSummary.total} prior findings verified as fixed, no new issues`
    : `No issues found. Reviewed ${prSummary.files_changed} files for bugs, CLAUDE.md compliance, and security.`

  phase('Compose')
  const cleanOutput = await agent(
    `You are the output-composer agent. PR #${PR_NUMBER} in ${FULL_REPO} has ZERO new findings.
${agentRef('output-composer')}

Fix-verification mode: ${isFixVerification}
Verdict: ${shortCircuitVerdict} (rule ${shortCircuitRule})
Classification: ${shortCircuitClass}
Reasoning: ${shortCircuitReasoning}

${priorVerificationSummary ? `PRIOR VERIFICATION RESULTS:
\`\`\`json
${JSON.stringify(priorVerificationSummary, null, 2)}
\`\`\`
` : ''}
1. Print a terminal summary:
## Code Review — ${shortCircuitIcon} ${shortCircuitLabel} — ${shortCircuitVerdict === 'APPROVE' ? 'Approved' : 'Comment'}

${shortCircuitReasoning}
${verificationTableMd}
Verdict: ${shortCircuitVerdict} — "${shortCircuitReasoning}"
Pipeline: Phase 2 produced 0 new findings → Phases 3-4 skipped${verificationStats ? ` | ${verificationStats}` : ''} → Verdict: ${shortCircuitVerdict} (${shortCircuitRule})

2. ${POST_FLAG ? `Post a single GitHub review using ${shortCircuitFlag}:
gh pr review ${PR_NUMBER} --repo ${FULL_REPO} ${shortCircuitFlag} --body "<the review body markdown>"

The review body MUST include:
- The classification header: ## Code Review — ${shortCircuitIcon} ${shortCircuitLabel} — ${shortCircuitVerdict === 'APPROVE' ? 'Approved' : 'Comment'}
- The reasoning line
${priorVerificationSummary ? '- The Prior Findings Verification table (render from the JSON above)\n' : ''}- The pipeline stats line` : 'Do NOT post to GitHub (--post flag is false).'}

Return a summary of what was done.`,
    { label: 'output-composer-clean', phase: 'Compose', model: 'sonnet',
      agentType: 'code-review:output-composer' }
  )

  return {
    pr:               `${FULL_REPO}#${PR_NUMBER}`,
    verdict:          shortCircuitVerdict,
    classification:   shortCircuitClass,
    reasoning:        shortCircuitReasoning,
    rule_applied:     shortCircuitRule,
    findings_count:   0,
    prior_verification: priorVerificationSummary,
    stats: { phase2: 0, phase3: 0, phase4: 0 },
    output: cleanOutput,
  }
}


// ============================================================================
// PHASE 3: EVIDENCE VERIFICATION (sonnet)
// ============================================================================

phase('Verify')

const verifierResult = await agent(
  `You are the evidence-verifier agent for a code review pipeline.
${agentRef('evidence-verifier')}
${protocolRef('quality-guards')}

Validate ALL ${allFindings.length} findings from Phase 2.
You are the quality gate that prevents false positives from reaching humans.

DATA SOURCES:
${diffSource}
${contextEnvelope}

INPUT FINDINGS:
\`\`\`json
${JSON.stringify(allFindings, null, 2)}
\`\`\`

VERIFICATION PROTOCOL for each finding:

1. VERIFY CLAIM TYPE is correct.
2. BY CLAIM TYPE:
   - code_logic: Read actual code at file:line. Check 20 lines before/after.
     Confirm the issue is real. Set validated: true ONLY if confirmed.
   - claude_md: Verify rule EXISTS in CLAUDE.md. Verify exact text matches evidence.
     Verify file is in scope. Verify code actually violates it. ALL four must pass.
   - external_fact/deprecation/package_version: Cap confidence at 25 unless you run
     a verification command (curl to npm/PyPI, gh api for releases).
     If tool contradicts claim: adjusted_confidence: 0, validated: false.

3. GUARD G11 (fix-verification: ${isFixVerification}):
   If true: check if finding contradicts prior review recommendation.
   If prior review recommended X and author did X → validated: false.

4. CROSS-VALIDATE between agents:
   - Same (file, line) from different agents → keep more specific, drop duplicate.
   - bug-detector + security-reviewer same issue → merge into higher severity.

5. CONFIDENCE FILTER:
   - Drop findings with adjusted_confidence < 80.
   - EXCEPTION: CRIT severity kept if adjusted_confidence >= 60.

NEVER modify Phase 2 fields (description, evidence, suggestion).
ONLY add: validated, validation_reasoning, adjusted_confidence.
Reasoning must be SPECIFIC: "Confirmed: line X shows Y, rule Z states W".

Return a JSON object with ALL findings (including dropped with validated: false),
plus dropped_count and dropped_reasons.`,
  { label: 'evidence-verifier', phase: 'Verify', model: 'sonnet',
    agentType: 'code-review:evidence-verifier', schema: VERIFIED_SCHEMA }
)

// ── Extract validated findings with fail-safe ────────────────────────────────

const verifiedAll = verifierResult?.findings ?? allFindings.map(f => ({
  ...f, validated: true, validation_reasoning: 'Verifier timed out — passed unvalidated',
  adjusted_confidence: f.confidence,
}))
const validatedOnly = verifiedAll.filter(
  f => f.validated === true && ((f.adjusted_confidence ?? 0) >= 80
    || (f.severity === 'CRIT' && (f.adjusted_confidence ?? 0) >= 60))
)

log(`[Phase 3] ${validatedOnly.length} validated (dropped: ${verifiedAll.length - validatedOnly.length})`)


// ============================================================================
// PHASE 4: DEDUP + BUDGET + VERDICT (haiku)
// ============================================================================

phase('Dedup')

const dedupResult = await agent(
  `You are the dedup-orchestrator agent for a code review pipeline.
${agentRef('dedup-orchestrator')}
${protocolRef('review-verdict')}

Reduce the ${validatedOnly.length} validated findings to the minimum high-signal set.
Target: 10 or fewer comments. Your mandate: fewer, better comments.

INPUT (validated findings):
\`\`\`json
${JSON.stringify(validatedOnly, null, 2)}
\`\`\`

EXISTING COMMENT DEDUP KEYS: ${JSON.stringify(existingComments.dedup_keys)}
PR SCOPE: ${prSummary.scope} | FILES: ${prSummary.files_changed}

STEP 1 — Three-Layer Deduplication:
  L1 Exact: key = hash(file + line + category + desc[:50]). Keep highest adjusted_confidence.
  L2 Proximity: same file, lines within 5, same category. Keep highest severity.
  L3 Semantic: same category, >80% body similarity. Merge, populate also_affects.
  Cross-check: drop findings matching existing dedup_keys (same path, line +/-3, >80% similar).

STEP 2 — Batch Guard (G4):
  Group by category + normalized description. If >3 files:
  set batch_key, batch_files on survivor, mark others batched: true.

STEP 3 — Comment Budget (G8):
  If total > 10: keep all CRIT, fill with top NORM by confidence, drop NITs.

STEP 4 — Verdict (using SURVIVING findings after budget):
  V1: Any CRIT → REQUEST_CHANGES
  V2: Any SEC >= NORM on public-facing → REQUEST_CHANGES
  V3: 3+ NORM BUG → REQUEST_CHANGES
  V4: 1-2 NORM BUG → COMMENT
  V5: Any NORM (CONV/SEC internal/ARCH) → COMMENT
  V6: Only NITs → COMMENT
  V7: 0 findings → APPROVE

  Calibration guards:
  VC1: Never REQUEST_CHANGES for NITs alone.
  VC2: Never APPROVE with surviving findings.
  VC4: Internal services → COMMENT unless CRIT.
  VC5: Draft PRs → COMMENT max.

STEP 5 — Classification:
  0 findings → clean | CRIT SEC → security | CRIT BUG → bugs
  >50% one category → that category | else → mixed

Return JSON with: findings (final set), verdict, stats.`,
  { label: 'dedup-orchestrator', phase: 'Dedup', model: 'haiku',
    agentType: 'code-review:dedup-orchestrator', schema: DEDUP_SCHEMA }
)

// ── Fail-safe defaults ──────────────────────────────────────────────────────

const finalFindings = dedupResult?.findings ?? validatedOnly
const verdict = dedupResult?.verdict ?? {
  action: validatedOnly.length > 0 ? 'COMMENT' : 'APPROVE',
  classification: validatedOnly.length > 0 ? 'mixed' : 'clean',
  reasoning: 'Dedup agent failed — using fallback verdict',
  rule_applied: validatedOnly.length > 0 ? 'V5' : 'V7',
  severity_distribution: { CRIT: 0, NORM: 0, NIT: 0 },
  category_distribution: { SEC: 0, BUG: 0, CONV: 0, ARCH: 0 },
  calibration_applied: [],
}
const stats = dedupResult?.stats ?? {
  input_count: validatedOnly.length, final_count: finalFindings.length,
}

log(`[Phase 4] ${finalFindings.length} final | Verdict: ${verdict.action} (${verdict.classification})`)


// ============================================================================
// PHASE 5: OUTPUT + POST (sonnet)
// ============================================================================

phase('Compose')

const postInstructions = POST_FLAG
  ? `POST_FLAG is TRUE — you MUST post the review to GitHub.

Post ONE atomic GitHub review. Use verdict.action to determine the event type:
- APPROVE → event "APPROVE"
- REQUEST_CHANGES → event "REQUEST_CHANGES"
- COMMENT → event "COMMENT"

The post_flag controls WHETHER to post. The verdict.action controls the event type.
These are INDEPENDENT.

Classify each finding as:
- Inlineable: finding's line is inside a diff hunk${filePatchesSource ? ` (check ${filePatchesSource})` : ''}
- Non-inlineable: line NOT in diff → goes in review body under "Additional Findings"

Post via gh api (preferred atomic method):
\`\`\`bash
gh api repos/${FULL_REPO}/pulls/${PR_NUMBER}/reviews --method POST --input ${CTX}/review_payload.json
\`\`\`

Payload format:
{
  "commit_id": "${headSha}",
  "event": "<verdict.action>",
  "body": "<review body markdown>",
  "comments": [{"path": "file.ts", "line": N, "side": "RIGHT", "body": "..."}]
}

Comments use "line" + "side": "RIGHT" (NOT legacy "position" field).

${CTX ? `Fallback chain:
1. gh api (preferred)
2. python3 ${CTX}/post_review.py ${CTX}/review_payload.json ${FULL_REPO} ${PR_NUMBER}
3. gh pr review ${PR_NUMBER} --repo ${FULL_REPO} --<flag> --body-file ${CTX}/review_payload.json` : `Fallback: gh pr review ${PR_NUMBER} --repo ${FULL_REPO} --<flag> --body "..."`}

CRITICAL LINE INTEGRITY:
- NEVER relocate a comment to a different line.
- If suggestion doesn't exactly replace the finding's line, remove suggestion block and use prose.
- If finding's line is NOT in diff, move to review body.

Post EXACTLY ONE review. No separate summary comments.`
  : 'POST_FLAG is FALSE — do NOT post to GitHub. Terminal summary only.'

const outputResult = await agent(
  `You are the output-composer agent for a code review pipeline.
${agentRef('output-composer')}

Produce the final review output for PR #${PR_NUMBER} in ${FULL_REPO}.

FINAL FINDINGS (${finalFindings.length}):
\`\`\`json
${JSON.stringify(finalFindings, null, 2)}
\`\`\`

VERDICT:
\`\`\`json
${JSON.stringify(verdict, null, 2)}
\`\`\`

STATS:
\`\`\`json
${JSON.stringify(stats, null, 2)}
\`\`\`

PR CONTEXT:
- Title: ${prSummary.title}
- Head SHA: ${headSha}
- Files reviewed: ${prSummary.files_changed}
- Scope: ${prSummary.scope}

STEP 1 — Terminal Summary (ALWAYS):
\`\`\`
## Code Review — <icon> <classification> — <verdict_label>

Found N issues: X bugs, Y convention violations, Z security issues.
Verdict: <ACTION> — "<reasoning>"

| # | Type | Sev | File | Description | Conf |
|---|------|-----|------|-------------|------|
...

Pipeline: Phase 2 → ${allFindings.length} | Phase 3 → ${validatedOnly.length} | Phase 4 → ${finalFindings.length}
\`\`\`

Icons: security=:shield:, bugs=:bug:, conventions=:memo:, architecture=:building_construction:, mixed=:mag:, clean=:white_check_mark:
Verdict labels: APPROVE→"Approved", REQUEST_CHANGES→"Request Changes", COMMENT→"Comment"

STEP 2 — GitHub Review:
${postInstructions}

FORMAT INLINE COMMENTS:
**<description>**

[CLAUDE.md link if CONV] Convention N: *"rule text"*

\\\`\\\`\\\`suggestion
<fixed code — only if suggestion_type=code AND fix <6 lines AND exactly replaces the line>
\\\`\\\`\\\`

PRE-POST VALIDATION (G1):
- body length >= 20 chars
- body does not match /^(test|\\s*)$/i
- no existing comment with >80% similarity on same (path, line)
Drop any failing finding.

Return: terminal summary text, review URL (if posted), any errors.`,
  { label: 'output-composer', phase: 'Compose', model: 'sonnet',
    agentType: 'code-review:output-composer' }
)


// ============================================================================
// RETURN (standardized shape)
// ============================================================================

return {
  pr:               `${FULL_REPO}#${PR_NUMBER}`,
  verdict:          verdict.action,
  classification:   verdict.classification,
  reasoning:        verdict.reasoning,
  rule_applied:     verdict.rule_applied,
  findings_count:   finalFindings.length,
  prior_verification: priorVerificationSummary,
  stats: {
    phase2_generated:  allFindings.length,
    phase2_by_agent:   { conv: convCount, bug: bugCount, sec: secCount },
    phase3_validated:  validatedOnly.length,
    phase3_dropped:    verifiedAll.length - validatedOnly.length,
    phase4_final:      finalFindings.length,
    ...stats,
  },
  calibration:      verdict.calibration_applied,
  output:           outputResult,
}
