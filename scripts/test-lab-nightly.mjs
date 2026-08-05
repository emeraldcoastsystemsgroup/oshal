#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial host-side nightly golden-scenario runner, report writer, and optional report committer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require TEST_LAB_OWNER_SUB and send it only in the secret-authenticated trust header so the API can establish a non-operator owner identity instead of using its ambient service-secret operator stamp.
 *
 * AI Test Lab — nightly runner (host-side) — ADR-063 §nightly.
 * -----------------------------------------------------------------------------
 * Drives the headless golden loop (POST /api/test-lab/golden/run with the service secret), then
 * writes a morning report + a baseline to docs/test-lab-reports/ and GIT-COMMITS them. This runs
 * on the HOST (not in the container) because (a) it must reach the repo to git-commit, and (b) the
 * git-committable report path (docs/) isn't mounted into the container.
 *
 * Per the propose-you-approve model: this commits ONLY the report + baseline. Any SUGGESTED FIX in
 * the report is for the operator to approve — it is never applied or committed automatically.
 *
 * Usage:  node scripts/test-lab-nightly.mjs [scenarioId|all] [--no-commit]
 * Env:    SWARM_SERVICE_SECRET + TEST_LAB_OWNER_SUB (read from .env),
 *         TEST_LAB_API (default http://127.0.0.1:5000)
 */
'use strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = resolve(ROOT, 'docs', 'test-lab-reports');

function envFromDotenv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

const SECRET = envFromDotenv('SWARM_SERVICE_SECRET');
const OWNER_SUB = envFromDotenv('TEST_LAB_OWNER_SUB').trim();
// The api container publishes 5000 → host ${OSHAL_API_PORT:-35457}; track that default.
const API = process.env.TEST_LAB_API || `http://127.0.0.1:${envFromDotenv('OSHAL_API_PORT') || '35457'}`;
const scenarioId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';
const noCommit = process.argv.includes('--no-commit');

if (!SECRET) { console.error('SWARM_SERVICE_SECRET not found (env or .env). Cannot authenticate headless.'); process.exit(2); }
if (!OWNER_SUB) { console.error('TEST_LAB_OWNER_SUB not found (env or .env). Cannot attribute owner-scoped writes.'); process.exit(2); }

function isoStamp() { return new Date().toISOString(); }
function dateSlug() { return new Date().toISOString().slice(0, 10); }

// The shared secret authenticates this runner; the separate header says which single user's rows
// it may access. The API honors that owner only after validating the secret and stamps it into RLS.
const HDRS = {
  'content-type': 'application/json',
  'x-service-secret': SECRET,
  'x-oshal-user-sub': OWNER_SUB,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the headless golden endpoint to be reachable before kicking the run. On a scheduled
 * 04:30 wake the Docker API container may still be starting, so we poll GET /catalog (auth'd with
 * the service secret) for up to ~10 min instead of losing the whole night to a single failed fetch.
 * Returns true once ready; false if it never came up.
 */
async function waitForApi() {
  const url = `${API}/api/test-lab/golden/catalog`;
  for (let i = 0; i < 40; i++) { // 40 × 15s = 10 min
    try {
      const r = await fetch(url, { headers: HDRS });
      if (r.ok) return true;
      // 401/403 means it's UP but the secret is wrong — fail fast, retrying won't help.
      if (r.status === 401 || r.status === 403) { console.error(`[test-lab-nightly] API up but auth rejected (HTTP ${r.status}) — check SWARM_SERVICE_SECRET.`); return false; }
    } catch { /* not reachable yet */ }
    if (i === 0) console.log('[test-lab-nightly] API not reachable yet — waiting (container may be starting)…');
    await sleep(15_000);
  }
  return false;
}

async function run() {
  console.log(`[test-lab-nightly] running golden '${scenarioId}' against ${API} …`);
  if (!(await waitForApi())) { console.error(`[test-lab-nightly] API ${API} not reachable after 10 min — aborting (no report written; Task Scheduler LastTaskResult will show this exit).`); process.exit(4); }
  const kick = await fetch(`${API}/api/test-lab/golden/run`, { method: 'POST', headers: HDRS, body: JSON.stringify({ scenarioId }) });
  if (!kick.ok) { console.error(`run kick failed HTTP ${kick.status}: ${(await kick.text()).slice(0, 300)}`); process.exit(1); }
  const { batchId } = await kick.json();
  console.log(`[test-lab-nightly] batch ${batchId} running; polling (each golden can take up to ~16 min)…`);

  // Poll until done/error. Up to ~90 min for the full set.
  let report = null;
  for (let i = 0; i < 360; i++) {
    await sleep(15_000);
    const r = await fetch(`${API}/api/test-lab/golden/run/${batchId}`, { headers: HDRS });
    if (!r.ok) { console.error(`poll failed HTTP ${r.status}`); continue; }
    const b = await r.json();
    if (b.status === 'done') { report = b; break; }
    if (b.status === 'error') { console.error(`batch error: ${b.error}`); process.exit(1); }
    if (i % 4 === 0) console.log(`[test-lab-nightly] …still running (${b.results?.length || 0}/${b.total} graded)`);
  }
  if (!report) { console.error('[test-lab-nightly] timed out waiting for the batch.'); process.exit(1); }

  mkdirSync(REPORT_DIR, { recursive: true });
  const prev = loadBaseline();
  const md = renderMarkdown(report, prev);
  const reportPath = resolve(REPORT_DIR, `${dateSlug()}.md`);
  writeFileSync(reportPath, md, 'utf8');
  writeFileSync(resolve(REPORT_DIR, 'latest.md'), md, 'utf8');
  const baseline = { generatedAt: isoStamp(), scores: Object.fromEntries(report.results.map((r) => [r.id, { score: r.score, state: r.state }])) };
  writeFileSync(resolve(REPORT_DIR, 'baseline.json'), JSON.stringify(baseline, null, 2), 'utf8');

  console.log(`[test-lab-nightly] ${report.passed}/${report.total} passed. report: ${reportPath}`);

  if (!noCommit) commit(report);
  // Exit non-zero if anything failed, so a scheduler can surface it.
  process.exit(report.failed > 0 ? 3 : 0);
}

function loadBaseline() {
  try { return JSON.parse(readFileSync(resolve(REPORT_DIR, 'baseline.json'), 'utf8')).scores || {}; }
  catch { return {}; }
}

function trend(id, score, prev) {
  const p = prev[id]?.score;
  if (p == null) return '(new)';
  if (score > p) return `up ${score - p} (was ${p})`;
  if (score < p) return `DOWN ${p - score} (was ${p})`;
  return `flat (${p})`;
}

function renderMarkdown(report, prev) {
  const lines = [];
  lines.push(`# AI Test Lab — nightly golden report (${dateSlug()})`);
  lines.push('');
  lines.push(`- Batch: \`${report.batchId}\``);
  lines.push(`- Window: ${report.startedAt} → ${report.finishedAt}`);
  lines.push(`- Result: **${report.passed}/${report.total} passed**, ${report.failed} failed.`);
  lines.push('');
  lines.push('| Scenario | Result | Score | vs last night | Attempts | Ticket status |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of report.results) {
    lines.push(`| ${r.name} | ${r.state.toUpperCase()} | ${r.score}/100 (pass ≥${r.passScore}) | ${trend(r.id, r.score, prev)} | ${r.attempts} | ${r.ticketStatus} |`);
  }
  lines.push('');
  for (const r of report.results) {
    lines.push(`## ${r.name} — ${r.state.toUpperCase()} (${r.score}/100)`);
    lines.push(`- Ticket: \`${r.ticketId || '(none)'}\` → ${r.ticketStatus}`);
    lines.push(`- Detail: ${r.detail}`);
    if (r.suggestedFix) {
      lines.push('');
      lines.push(`> **Suggested fix (proposal — NOT applied, needs your approval):** ${r.suggestedFix}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('_Generated by `scripts/test-lab-nightly.mjs`. Suggested fixes are proposals only; nothing in the framework was changed. Approve a fix, then I apply + commit it._');
  return lines.join('\n') + '\n';
}

function commit(report) {
  try {
    execSync('git add docs/test-lab-reports/', { cwd: ROOT, stdio: 'pipe' });
    const msg = `chore(test-lab): nightly golden report ${dateSlug()} (${report.passed}/${report.total} passed)\n\nAuto-committed report + baseline only (propose-you-approve; no framework changes).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
    execSync(`git commit -F -`, { cwd: ROOT, input: msg, stdio: 'pipe' });
    console.log('[test-lab-nightly] committed report + baseline.');
  } catch (e) {
    const out = (e.stdout || e.stderr || '').toString();
    if (/nothing to commit/i.test(out)) console.log('[test-lab-nightly] nothing to commit.');
    else console.error('[test-lab-nightly] commit failed:', out.slice(0, 300));
  }
}

run().catch((e) => { console.error('[test-lab-nightly] error:', e.message); process.exit(1); });
