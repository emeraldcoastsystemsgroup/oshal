#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cost guard: FAIL if any GitHub Actions workflow regains an automatic trigger. Hosted-runner minutes are the account's binding constraint and this has now regressed TWICE — per-push CI (07-08), then an "hourly during business hours" cron that ran ~55 full pipelines/week on the public mirror, unattended, until it took the account to zero (07-14). A rule nobody enforces is a rule that comes back.
 */

/**
 * @description Assert every workflow in .github/workflows/ is MANUAL-ONLY (workflow_dispatch).
 *
 * The rule: **no `push:`, no `schedule:`, no `pull_request:`.** Anything automatic bills hosted
 * runner minutes, forever, whether or not anyone is watching — which is exactly how the budget went
 * to zero. The single automated gate is LOCAL (`scripts/ci-local.sh`, one nightly run, $0), and
 * builds and deploys are local too.
 *
 * This is deliberately a DUMB text check, not a YAML parse: it must also catch a trigger that is
 * commented back in, reformatted, or added under an alias. Top-level trigger keys are indented
 * exactly two spaces under `on:`, which is what the regex keys on. `push:` as a *parameter* of
 * docker/build-push-action is indented far deeper and is correctly ignored.
 *
 * Usage:
 *   node scripts/check-workflow-triggers.js            # this repo
 *   node scripts/check-workflow-triggers.js <dir>      # e.g. a mirror checkout's .github/workflows
 *
 * Exit 0 = every workflow is manual-only. Exit 1 = something is billing us.
 */

const fs = require('fs');
const path = require('path');

/** Triggers that cause GitHub to run a workflow without a human asking. */
const AUTOMATIC_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'schedule'];

/**
 * @description Find every workflow file in a directory.
 * @param {string} dir - Workflow directory.
 * @returns {string[]} Absolute paths.
 */
function workflowFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(dir, f));
}

/**
 * @description Extract the top-level trigger keys from a workflow's `on:` block.
 *
 * Scans from `on:` until the next column-0 key, collecting keys indented exactly two spaces.
 * Also handles the inline forms `on: push` and `on: [push, pull_request]`.
 *
 * @param {string} src - Workflow YAML source.
 * @returns {string[]} The declared trigger names.
 */
function declaredTriggers(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start === -1) return [];

  // Inline forms: `on: push` / `on: [push, pull_request]`
  const inline = /^on:\s*\[?([a-z_,\s]+)\]?\s*$/.exec(lines[start]);
  if (inline && inline[1].trim()) {
    return inline[1].split(',').map((s) => s.trim()).filter(Boolean);
  }

  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[a-zA-Z_]/.test(line)) break; // next top-level key — the `on:` block ended
    const m = /^ {2}([a-z_]+):/.exec(line); // exactly two spaces = a top-level trigger
    if (m) out.push(m[1]);
  }
  return out;
}

const dir = process.argv[2] || path.join(__dirname, '..', '.github', 'workflows');
const files = workflowFiles(dir);
const violations = [];

/**
 * The ONE sanctioned exception, and it is narrow on purpose.
 *
 * This repository is public-track: a commit here reaches the world with no sanitizer in front of
 * it, and `publish-gate.sh` is the wall. A pre-push hook is bypassable (`--no-verify`, a fresh
 * clone with no `core.hooksPath`), so the gate must ALSO run server-side on every PR or it is not
 * a gate — it is a suggestion. That workflow is a checkout plus a grep: seconds of runner time, no
 * npm install, no docker build. It is not the class of spend that took the account to zero twice.
 *
 * Scoped to one file AND one trigger. `publish-gate.yml` may declare `pull_request`; it may not
 * declare `push` or `schedule`, and no other workflow may declare anything automatic.
 */
const EXCEPTIONS = { 'publish-gate.yml': ['pull_request'] };

for (const file of files) {
  const triggers = declaredTriggers(fs.readFileSync(file, 'utf8'));
  const allowed = EXCEPTIONS[path.basename(file)] || [];
  const bad = triggers.filter((t) => AUTOMATIC_TRIGGERS.includes(t) && !allowed.includes(t));
  if (bad.length) violations.push({ file: path.relative(process.cwd(), file), bad });
}

if (violations.length) {
  console.error('\n✗ GitHub Actions workflows have AUTOMATIC triggers — these bill hosted-runner minutes:\n');
  for (const v of violations) {
    console.error(`  • ${v.file} — ${v.bad.map((b) => `${b}:`).join(', ')}`);
  }
  console.error(
    '\nWorkflows must be MANUAL-ONLY (workflow_dispatch). Hosted-runner minutes are the account\'s\n' +
      'binding constraint; this has already gone to zero twice. The one automated gate is LOCAL:\n' +
      'scripts/ci-local.sh (nightly, $0). Builds and deploys are local too.\n' +
      'If you genuinely need a hosted run: Actions tab → "Run workflow".\n',
  );
  process.exit(1);
}

if (!process.argv.includes('--quiet')) {
  console.log(`✓ ${files.length} workflow(s) are manual-only — no automatic hosted-runner billing.`);
}
