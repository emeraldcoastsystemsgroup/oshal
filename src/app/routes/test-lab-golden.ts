/**
 * AI Test Lab — nightly golden-scenario loop (ADR-063 §nightly).
 *
 * Submits "golden" complicated requests as REAL tickets, lets them flow through the SAME swarm
 * queue, polls each to a terminal state, reads the produced result, and GRADES it against a fixed
 * EXPECTED output (heuristic required-keywords/artifacts/terminal-status + an optional LLM judge).
 * Failures are re-run (the swarm is non-deterministic — keep the best attempt); a scenario still
 * failing after its retries gets a drafted SUGGESTED FIX written into the report.
 *
 * Runs HEADLESS: this router is mounted under serviceSecretOr() so the host-side nightly runner
 * (scripts/test-lab-nightly.mjs) can drive it with X-Service-Secret (no browser). Per the
 * propose-you-approve model, this engine NEVER edits framework prompts/code — it only measures,
 * re-runs, and proposes; the host runner commits the report + baselines, and any prompt change
 * waits for the operator's approval.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — golden scenarios + the
 *            | submit/poll/grade/retry/propose loop + persistence + the headless run endpoint.
 * ---------------------------------------------------------------------------
 * @module test-lab-golden
 */

import { Router, type Request, type Response } from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import type { Pool } from 'pg';
import { recordEvalRun, type EvalRun, CostTrackingService } from '@/features/operational-intelligence';

const logger = createChildLogger({ module: 'test-lab-golden' });

const TERMINAL = new Set(['complete', 'cancelled', 'escalated', 'customer_action']);
const OWNER_SUB = process.env.TEST_LAB_OWNER_SUB || null;
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.TEST_LAB_MAX_ATTEMPTS || '2', 10));

/** A golden scenario: a real request + the EXPECTED output it must produce. Exported for unit tests. */
export interface Golden {
  id: string;
  name: string;
  complexity: 'low' | 'medium' | 'high';
  ticket: { title: string; description: string };
  expect: {
    mustComplete: boolean;          // ticket must reach 'complete' (not escalated/cancelled)
    requiredKeywords: string[];     // all must appear (case-insensitive) in the produced result
    requiredArtifacts: number;      // at least N files in the workspace deliverables dir
    rubric: string;                 // what a correct result looks like (for the LLM judge)
  };
  passScore: number;                // 0-100 threshold to count as pass
}

/** The golden set — "complicated requests from the framework" with fixed expectations. */
const GOLDEN: Golden[] = [
  {
    id: 'g-phone-validator',
    name: 'Python phone validator + tests',
    complexity: 'low',
    ticket: {
      title: '[Test Lab] Python US phone-number validator with unit tests',
      description: 'Write a single Python file with a function validate_us_phone(s) that returns True for valid US phone numbers (10 digits, optional +1, common separators) and False otherwise. Include at least 3 unit tests using assert. Put it in deliverables.',
    },
    expect: { mustComplete: true, requiredKeywords: ['def validate_us_phone', 'assert'], requiredArtifacts: 1, rubric: 'A Python file defining validate_us_phone(s) with correct logic and >=3 assert-based unit tests covering valid and invalid numbers.' },
    passScore: 70,
  },
  {
    id: 'g-markdown-html',
    name: 'Markdown → HTML converter',
    complexity: 'medium',
    ticket: {
      title: '[Test Lab] Minimal Markdown-to-HTML converter',
      description: 'Write a small script (Python or Node) that converts a Markdown string to HTML for headings (#, ##), bold (**x**), and unordered lists (- item). Include a short example and at least 2 tests. Put the file(s) in deliverables.',
    },
    expect: { mustComplete: true, requiredKeywords: ['<h1', '<li', 'convert'], requiredArtifacts: 1, rubric: 'A working converter handling headings, bold, and lists, producing valid HTML tags, with a runnable example and at least 2 tests.' },
    passScore: 65,
  },
  {
    id: 'g-csv-stats',
    name: 'Python CSV column summary',
    complexity: 'low',
    ticket: {
      title: '[Test Lab] Python CSV numeric-column summary',
      description: 'Write a single Python file with a function summarize_column(rows, column) that takes a list of dict rows and a column name and returns a dict with count, min, max, and mean of that numeric column (ignore non-numeric/missing values). Include at least 3 unit tests using assert. Put it in deliverables.',
    },
    expect: { mustComplete: true, requiredKeywords: ['def summarize_column', 'mean', 'assert'], requiredArtifacts: 1, rubric: 'A Python file defining summarize_column(rows, column) returning count/min/max/mean, skipping non-numeric values, with >=3 assert-based tests including an empty/all-missing case.' },
    passScore: 70,
  },
  {
    id: 'g-debounce-js',
    name: 'JS debounce utility + tests',
    complexity: 'medium',
    ticket: {
      title: '[Test Lab] JavaScript debounce() utility with tests',
      description: 'Write a JavaScript file exporting a debounce(fn, waitMs) higher-order function that delays calling fn until waitMs has elapsed since the last call, passing through the latest arguments. Include at least 2 tests (you may use fake timers or a small manual harness) that prove only the last call fires. Put the file(s) in deliverables.',
    },
    expect: { mustComplete: true, requiredKeywords: ['function debounce', 'setTimeout', 'expect'], requiredArtifacts: 1, rubric: 'A correct debounce(fn, waitMs) that resets its timer on each call and invokes fn once with the latest args after the quiet period, with at least 2 tests demonstrating the collapse-to-last-call behavior.' },
    passScore: 65,
  },
  {
    id: 'g-roman-numerals',
    name: 'Python int→Roman numeral converter',
    complexity: 'low',
    ticket: {
      title: '[Test Lab] Python integer-to-Roman-numeral converter',
      description: 'Write a single Python file with a function to_roman(n) that converts an integer 1..3999 to its Roman numeral string (e.g. 4 -> "IV", 1994 -> "MCMXCIV") and raises ValueError out of range. Include at least 4 unit tests using assert covering subtractive cases and the bounds. Put it in deliverables.',
    },
    expect: { mustComplete: true, requiredKeywords: ['def to_roman', 'ValueError', 'assert'], requiredArtifacts: 1, rubric: 'A correct to_roman(n) handling subtractive notation (IV, IX, XL, XC, CD, CM) and raising ValueError outside 1..3999, with >=4 assert-based tests.' },
    passScore: 70,
  },
  {
    id: 'g-json-merge',
    name: 'Python deep-merge of two dicts',
    complexity: 'medium',
    ticket: {
      title: '[Test Lab] Python recursive deep-merge of two dicts',
      description: 'Write a single Python file with a function deep_merge(a, b) that recursively merges dict b into dict a (b wins on conflicts; nested dicts merge rather than overwrite; lists are replaced, not concatenated) and returns a new dict without mutating the inputs. Include at least 3 unit tests using assert, one proving the inputs are not mutated. Put it in deliverables.',
    },
    expect: { mustComplete: true, requiredKeywords: ['def deep_merge', 'isinstance', 'assert'], requiredArtifacts: 1, rubric: 'A correct non-mutating deep_merge(a, b): nested dicts merge recursively, scalars/lists from b override a, originals unchanged, with >=3 assert-based tests including a no-mutation check.' },
    passScore: 65,
  },
];

// ── Schema ───────────────────────────────────────────────────────────────────
export async function ensureGoldenSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'test lab golden routes',
    statements: [`
    CREATE TABLE IF NOT EXISTS test_lab_golden_runs (
      run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL,
      scenario_id VARCHAR(64) NOT NULL,
      scenario_name TEXT,
      attempts INT NOT NULL DEFAULT 1,
      best_score INT NOT NULL DEFAULT 0,
      state VARCHAR(16) NOT NULL DEFAULT 'fail',
      ticket_id UUID,
      ticket_status VARCHAR(32),
      detail TEXT,
      suggested_fix TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_golden_batch ON test_lab_golden_runs (batch_id, created_at);
  `],
    requirements: [
      {
        table: 'test_lab_golden_runs',
        columns: [
          'run_id',
          'batch_id',
          'scenario_id',
          'scenario_name',
          'attempts',
          'best_score',
          'state',
          'ticket_id',
          'ticket_status',
          'detail',
          'suggested_fix',
          'created_at',
        ],
      },
    ],
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the produced result text: the workspace deliverables + the final status-history note. */
/** Recursively collect deliverable files under a dir (handles tests/, docs/, agent-id subdirs). */
async function walkDeliverables(dir: string, acc: { text: string; count: number }): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await walkDeliverables(full, acc); continue; }
    if (!e.isFile()) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.size > 0) { acc.count++; acc.text += `\n\n=== ${e.name} ===\n` + (await fs.readFile(full, 'utf8')).slice(0, 8000); }
    } catch { /* skip */ }
  }
}

async function readResult(ctx: AppContext, ticketId: string): Promise<{ text: string; artifactCount: number }> {
  const acc = { text: '', count: 0 };
  // The deliverable may land in the root ticket's folder OR a child ticket's folder, and may be
  // nested under tests/, docs/, or an agent-id subdir — walk the whole tree recursively, not just
  // the root's top level (which under-counted real deliverables and failed correct builds).
  const folders = [ticketId];
  try {
    const kids = await ctx.pool.query(`SELECT ticket_id FROM tickets WHERE parent_ticket_id = $1`, [ticketId]);
    for (const r of kids.rows) if (r.ticket_id) folders.push(String(r.ticket_id));
  } catch { /* best effort — root folder still walked */ }
  for (const f of folders) {
    await walkDeliverables(path.resolve(process.cwd(), 'workspace-shared', f, 'deliverables'), acc);
  }
  try {
    const hist = await ctx.ticketService.getStatusHistory(ticketId, 50);
    const notes = (hist || []).map((h: any) => h.note || h.reason || '').filter(Boolean).join(' | ');
    if (notes) acc.text += `\n\n=== status notes ===\n${notes.slice(0, 2000)}`;
  } catch { /* best effort */ }
  return { text: acc.text.trim(), artifactCount: acc.count };
}

/**
 * Detect whether produced code actually contains test constructs.
 *
 * ROOT-CAUSE FIX (report 2026-06-21): the prior heuristic only credited "has tests"
 * implicitly through a hard-coded `requiredKeywords` substring match, and several
 * scenarios/judges assumed test coverage meant the unittest idiom
 * (`import unittest` / `class Test...(unittest.TestCase)`). Solutions that used the
 * bare `assert` style the spec explicitly asked for, or pytest-style `def test_...`,
 * were treated as test-less and penalized — the heuristic gave 60 while the LLM judge
 * (which reads the code) gave 95. This recognizes the full range of valid test
 * constructs across Python and JS so a correct bare-assert solution is credited.
 *
 * It is deliberately NOT an always-pass: output with no recognizable assertion /
 * test-runner construct returns false, so genuinely test-less deliverables earn no
 * test credit and stay below threshold.
 */
export function hasTestConstructs(text: string): boolean {
  const TEST_CONSTRUCTS: RegExp[] = [
    /\bassert\b/,                         // Python bare assert / pytest
    /\bdef\s+test_\w+/,                    // pytest-style test functions
    /import\s+unittest|unittest\.TestCase/, // classic unittest idiom (still valid)
    /import\s+pytest|@pytest\./,           // pytest
    /\bexpect\s*\(/,                       // JS: jest / vitest / chai expect()
    /\b(?:it|test|describe)\s*\(/,         // JS test-runner blocks
    /\bassert(?:Equal|True|False|Raises)\b/, // unittest assertion methods
    /console\.assert\s*\(/,                // node assert-ish
  ];
  return TEST_CONSTRUCTS.some((re) => re.test(text));
}

/** Heuristic grade vs the expected output (0-100), plus a reason. Exported for unit tests. */
export function heuristicGrade(g: Golden, status: string, result: { text: string; artifactCount: number }): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Terminal status is a SIGNAL, not a veto. The swarm frequently escalates a ticket
  // for non-quality reasons (a verdict-format miss, an unrelated downstream step), yet
  // the deliverable itself is correct. The 2026-06-21 bare-assert solution was escalated
  // but the code + tests were right. Weight 'complete' at 20 (was 40) so a correct,
  // well-tested deliverable can still clear threshold; escalated still costs points.
  const completed = status === 'complete';
  if (completed) { score += 20; } else { reasons.push(`ticket ended '${status}', not 'complete'`); }

  if (result.artifactCount >= g.expect.requiredArtifacts) { score += 20; } else { reasons.push(`produced ${result.artifactCount}/${g.expect.requiredArtifacts} deliverables`); }

  const lower = result.text.toLowerCase();
  const hit = g.expect.requiredKeywords.filter((k) => lower.includes(k.toLowerCase()));
  const kwScore = g.expect.requiredKeywords.length ? Math.round((hit.length / g.expect.requiredKeywords.length) * 40) : 40;
  score += kwScore;
  if (hit.length < g.expect.requiredKeywords.length) reasons.push(`keywords ${hit.length}/${g.expect.requiredKeywords.length} (missing: ${g.expect.requiredKeywords.filter((k) => !hit.includes(k)).join(', ')})`);

  // Test-coverage credit: broadened to recognize bare `assert`, pytest, unittest, and
  // JS test runners (see hasTestConstructs). Worth 20 points. This is what makes the
  // bare-assert solution score correctly instead of being read as untested. Output with
  // no recognizable test construct earns 0 here, so the gate is NOT weakened to always-pass.
  if (hasTestConstructs(result.text)) { score += 20; } else { reasons.push('no recognizable test constructs (assert / def test_ / unittest / expect())'); }

  return { score: Math.min(100, score), reasons };
}

/**
 * Read the REAL cost of a ticket from the framework's central source of truth — we do NOT
 * re-instrument the test-lab call path. Every LLM call (any provider, any harness) flows through
 * the provider layer, which records tokens+cost into `chat_tasks`, and every unit of swarm work
 * links its task to the ticket via `ticket_task_links`. So cost is captured ONCE, centrally, and
 * is queryable per ticket for ANY work — not just the test lab. We just read it here.
 *
 * Tree query = authoritative subtree cost+tokens (so a ticket that decomposes into child tickets
 * isn't undercounted); direct query = the input/output token split the rollup view doesn't carry.
 * Honest-null: when nothing has been recorded yet (cost rows not written, or a free/local model),
 * everything comes back null rather than a fabricated 0.
 */
async function captureTicketCost(
  ctx: AppContext,
  ticketId: string,
): Promise<{ inputTokens: number | null; outputTokens: number | null; costUsd: number | null }> {
  const none = { inputTokens: null, outputTokens: null, costUsd: null };
  if (!ticketId) return none;
  try {
    const svc = new CostTrackingService(ctx.pool);
    const [tree, direct] = await Promise.all([
      svc.queryCostByTicketTree(ticketId).catch(() => null),
      svc.queryCostByTicket(ticketId).catch(() => null),
    ]);
    const costUsd = tree?.totalCost ?? direct?.totalCost ?? 0;
    const inputTokens = direct?.totalInputTokens ?? 0;
    const outputTokens = direct?.totalOutputTokens ?? 0;
    const totalTokens = (tree?.totalTokens ?? 0) || inputTokens + outputTokens;
    // Nothing recorded → honest null (unmeasured), not a misleading $0 / 0 tokens.
    if (costUsd === 0 && totalTokens === 0) return none;
    return {
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
      costUsd: costUsd || null,
    };
  } catch {
    return none;
  }
}

/** Optional LLM judge (best-effort): scores the result against the rubric. Falls back silently. */
async function judge(ctx: AppContext, g: Golden, result: string): Promise<number | null> {
  try {
    const orchestrator = (ctx as any).orchestrator;
    if (!orchestrator?.processMessage) return null;
    const prompt = [
      'You are a strict QA judge. Score how well the RESULT meets the EXPECTED rubric, 0-100.',
      `EXPECTED: ${g.expect.rubric}`,
      '', 'RESULT:', result.slice(0, 6000), '',
      'Reply with ONLY a JSON object: {"score": <0-100>}',
    ].join('\n');
    const r = await orchestrator.processMessage(`golden-judge-${randomUUID()}`, prompt, { agenticMode: false, autoApprove: false, source: 'test-lab', userSub: OWNER_SUB || 'test-lab' });
    const m = String(r?.response || '').match(/\{[^}]*"score"[^}]*\}/);
    if (!m) return null;
    const n = Number(JSON.parse(m[0]).score);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  } catch (e) { logger.warn({ e }, 'judge failed — heuristic only'); return null; }
}

/** Draft a concrete suggested fix for a persistently-failing scenario (proposal only, never applied). */
async function draftFix(ctx: AppContext, g: Golden, detail: string): Promise<string> {
  try {
    const orchestrator = (ctx as any).orchestrator;
    if (!orchestrator?.processMessage) return '';
    const prompt = [
      `A swarm self-test scenario keeps failing. Propose ONE concrete, specific improvement to the framework`,
      `(a persona/prompt tweak, a routing keyword, a missing capability) that would most likely fix it. Be specific and brief.`,
      `SCENARIO: ${g.name} — ${g.ticket.description}`,
      `WHY IT FAILED: ${detail}`,
      'Reply with 1-3 sentences. Do NOT write code.',
    ].join('\n');
    const r = await orchestrator.processMessage(`golden-fix-${randomUUID()}`, prompt, { agenticMode: false, autoApprove: false, source: 'test-lab', userSub: OWNER_SUB || 'test-lab' });
    return String(r?.response || '').trim().slice(0, 600);
  } catch { return ''; }
}

/** Run one golden scenario once: submit a ticket, poll to terminal, read + grade vs expected. */
async function runOnce(ctx: AppContext, g: Golden): Promise<{ score: number; state: 'pass' | 'fail'; ticketId: string; ticketStatus: string; detail: string; latencyMs: number; artifactCount: number; heuristicScore: number; judgeScore: number | null; costUsd: number | null; inputTokens: number | null; outputTokens: number | null }> {
  const planningWaitMs = g.complexity === 'high' ? 8 * 60_000 : g.complexity === 'medium' ? 7 * 60_000 : 6 * 60_000;
  const completionWaitMs = g.complexity === 'high' ? 15 * 60_000 : g.complexity === 'medium' ? 12 * 60_000 : 10 * 60_000;

  const startedAt = Date.now();
  const ticket = await ctx.ticketService.createTicket({
    ticketType: 'build', status: 'approved',
    title: g.ticket.title, description: g.ticket.description,
    labels: ['test-lab', 'golden', g.id], priority: 'medium' as any,
    assignedAgentId: null, parentTicketId: null, workspaceId: null,
    externalId: null, externalProvider: null, externalUrl: null,
    ownerSub: OWNER_SUB,
    metadata: { source: 'test-lab-golden', goldenScenarioId: g.id },
  } as any);
  const ticketId = ticket.ticketId;

  // Poll: auto-approve a build gate if it appears, then wait for a terminal status.
  const deadline = Date.now() + planningWaitMs + completionWaitMs;
  let status = ticket.status;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const t = await ctx.ticketService.getTicket(ticketId);
    if (!t) break;
    status = t.status;
    if (status === 'approval_required') {
      await ctx.ticketService.updateStatusAs(ticketId, 'in_process_build', 'test-lab', 'Test Lab').catch(() => {});
      continue;
    }
    if (TERMINAL.has(status)) break;
  }

  const latencyMs = Date.now() - startedAt;
  const result = await readResult(ctx, ticketId);
  const h = heuristicGrade(g, status, result);
  const j = await judge(ctx, g, result.text);
  // Blend: if the judge ran, average it with the heuristic; else heuristic only.
  const score = j == null ? h.score : Math.round((h.score + j) * 0.5);
  // Pass semantics (ADR-063, corrected 2026-06-21 after diagnosing the golden tickets): escalation
  // is NOT a non-quality nicety to wave through. Diagnosis found escalation is the DOMINANT outcome
  // (system auto-escalates from in_process_build), so counting an escalated-but-well-scored run as
  // "pass" would manufacture green over a real, systemic swarm failure — inflation we refuse. Honest
  // gate: pass only when score >= passScore, a real deliverable was produced, AND (for a mustComplete
  // scenario) the swarm actually reached 'complete'. An escalated run that produced a good deliverable
  // is surfaced as 'degraded' downstream (not pass, not hard-fail) so the escalation is VISIBLE, not
  // hidden. The deliverable-quality is still captured in the score for triage.
  const passed = score >= g.passScore
    && result.artifactCount >= g.expect.requiredArtifacts
    && (!g.expect.mustComplete || status === 'complete');
  // Cost is READ from the framework's central chat_tasks/ticket_task_links ledger (see
  // captureTicketCost) — the same place every LLM call in the system records into.
  const cost = await captureTicketCost(ctx, ticketId);
  const detail = `score ${score} (heuristic ${h.score}${j == null ? '' : `, judge ${j}`}); status '${status}'; ${result.artifactCount} deliverable(s)${h.reasons.length ? '; ' + h.reasons.join('; ') : ''}`;
  return { score, state: passed ? 'pass' : 'fail', ticketId, ticketStatus: status, detail, latencyMs, artifactCount: result.artifactCount, heuristicScore: h.score, judgeScore: j, costUsd: cost.costUsd, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
}

/** Run a golden scenario with retries (keep best); draft a fix if it never passes. */
async function runGolden(ctx: AppContext, batchId: string, g: Golden): Promise<any> {
  let best: Awaited<ReturnType<typeof runOnce>> | null = null;
  let attempts = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts++;
    let r: Awaited<ReturnType<typeof runOnce>>;
    try { r = await runOnce(ctx, g); }
    catch (e: any) { r = { score: 0, state: 'fail', ticketId: '', ticketStatus: 'error', detail: `run threw: ${e?.message || e}`, latencyMs: 0, artifactCount: 0, heuristicScore: 0, judgeScore: null, costUsd: null, inputTokens: null, outputTokens: null }; }
    if (!best || r.score > best.score) best = r;
    if (r.state === 'pass') break;
  }
  const b = best!;
  const suggestedFix = b.state === 'fail' ? await draftFix(ctx, g, b.detail) : '';
  await ctx.pool.query(
    `INSERT INTO test_lab_golden_runs (batch_id, scenario_id, scenario_name, attempts, best_score, state, ticket_id, ticket_status, detail, suggested_fix)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [batchId, g.id, g.name, attempts, b.score, b.state, b.ticketId || null, b.ticketStatus, b.detail, suggestedFix || null],
  ).catch((err) => logger.warn({ err }, 'persist golden run failed'));

  // Feed the green wall (ADR-063 §eval-wall): persist this run to eval_runs so the dashboard's
  // success-rate / latency / retries / quality / cost history is self-populating from the live nightly
  // loop (not just a manual backfill). Token/cost are READ from the central chat_tasks ledger via
  // captureTicketCost (the framework's single source of truth for every LLM call) — honest-null when
  // nothing was recorded, never a fabricated 0. Security posture rolls in from the Security Center
  // feeder (Phase 4) — stored NULL here until then.
  // state: pass when it cleared threshold AND completed; gap when no deliverable was produced;
  // degraded when a deliverable exists but the run didn't pass (scored below threshold OR escalated
  // instead of completing — the dominant case, surfaced honestly not hidden); fail on a zero/errored run.
  const evalState: EvalRun['state'] =
    b.state === 'pass' ? 'pass' : b.artifactCount === 0 ? 'gap' : b.score > 0 ? 'degraded' : 'fail';
  const evalRun: EvalRun = {
    scenario: g.name,
    state: evalState,
    heuristicScore: b.heuristicScore,
    judgeScore: b.judgeScore,
    finalScore: b.score,
    passed: b.state === 'pass',
    latencyMs: b.latencyMs > 0 ? b.latencyMs : null,
    retries: Math.max(0, attempts - 1),
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    costUsd: b.costUsd,
    securityFindings: null,
    notes: `${b.ticketStatus}: ${b.detail}`.slice(0, 1000),
  };
  await recordEvalRun(ctx.pool, evalRun).catch((err) => logger.warn({ err }, 'recordEvalRun (eval-wall) failed'));

  return { id: g.id, name: g.name, complexity: g.complexity, attempts, score: b.score, state: b.state, ticketId: b.ticketId, ticketStatus: b.ticketStatus, detail: b.detail, passScore: g.passScore, suggestedFix };
}

// ── Async batch store (kick + poll; the loop can run for many minutes) ─────────
interface Batch { batchId: string; status: 'running' | 'done' | 'error'; startedAt: string; finishedAt?: string; total: number; passed?: number; failed?: number; results: any[]; error?: string; }
const BATCHES = new Map<string, Batch>();

// ── Router (mounted under serviceSecretOr — headless-capable) ───────────────────
export function createTestLabGoldenRoutes(ctx: AppContext): Router {
  const router = Router();
  ensureGoldenSchema(ctx.pool).catch((err) => logger.warn({ err }, 'golden schema bootstrap deferred'));

  /** List the golden catalog (what the nightly loop runs). */
  router.get('/catalog', (_req: Request, res: Response) => {
    res.json({ scenarios: GOLDEN.map((g) => ({ id: g.id, name: g.name, complexity: g.complexity, passScore: g.passScore, expect: g.expect })) });
  });

  /** Kick the loop (async — returns a batchId immediately; poll GET /run/:batchId). Body: { scenarioId?: 'all' }. */
  router.post('/run', async (req: Request, res: Response) => {
    const id = String(req.body?.scenarioId || 'all');
    const toRun = id === 'all' ? GOLDEN : GOLDEN.filter((g) => g.id === id);
    if (!toRun.length) { res.status(404).json({ error: `unknown golden scenario: ${id}` }); return; }
    const batchId = randomUUID();
    const batch: Batch = { batchId, status: 'running', startedAt: new Date().toISOString(), total: toRun.length, results: [] };
    BATCHES.set(batchId, batch);
    logger.info({ batchId, count: toRun.length }, 'golden batch started');
    // Fire-and-forget; the host runner polls /run/:batchId.
    (async () => {
      try {
        for (const g of toRun) { batch.results.push(await runGolden(ctx, batchId, g)); }
        batch.passed = batch.results.filter((r) => r.state === 'pass').length;
        batch.failed = batch.results.length - batch.passed;
        batch.status = 'done';
      } catch (e: any) { batch.status = 'error'; batch.error = e?.message || String(e); }
      batch.finishedAt = new Date().toISOString();
      logger.info({ batchId, status: batch.status, passed: batch.passed }, 'golden batch finished');
    })();
    res.status(202).json({ batchId, status: 'running', total: toRun.length });
  });

  /** Poll a batch. Returns the full report once status is 'done'. */
  router.get('/run/:batchId', (req: Request, res: Response) => {
    const b = BATCHES.get(String(req.params.batchId));
    if (!b) { res.status(404).json({ error: 'unknown batch' }); return; }
    res.json(b);
  });

  return router;
}
