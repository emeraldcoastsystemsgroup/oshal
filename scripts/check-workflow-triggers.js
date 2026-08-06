#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Cost guard: FAIL if any GitHub Actions workflow regains an automatic trigger. Hosted-runner minutes are the account's binding constraint and this has now regressed TWICE — per-push CI (07-08), then an "hourly during business hours" cron that ran ~55 full pipelines/week on the public mirror, unattended, until it took the account to zero (07-14). A rule nobody enforces is a rule that comes back.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Permit the bounded SEC-06 PR/main/weekly workflow while keeping general CI manual-only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Revert entry 2 and restore entry 1's incident history, which entry 2 deleted. Widening this allowlist to admit security.yml made the guard bless the very workflow whose ~225 job-minutes per PR and per merge it exists to refuse — a cost guard that grants its own exception is not a guard. The security jobs are kept and run in scripts/ci-local.sh at $0. Also drops the inverted `missing-<trigger>` checks: requiring push/schedule to be PRESENT meant turning billing OFF failed the build. Operator decision 2026-08-06.
 */

/**
 * @description Assert every workflow in .github/workflows/ is MANUAL-ONLY (workflow_dispatch).
 *
 * The rule: **no `push:`, no `schedule:`, no `pull_request:`.** Anything automatic bills hosted
 * runner minutes, forever, whether or not anyone is watching — which is exactly how the budget went
 * to zero. The single automated gate is LOCAL (`scripts/ci-local.sh`, one nightly run, $0), and
 * builds and deploys are local too.
 *
 * `publish-gate.yml` is the one standing exception: it runs on PRs because it is the wall between
 * a commit and the public, and it is cheap.
 *
 * This is deliberately a DUMB text check, not a YAML parse: it must also catch a trigger that is
 * commented back in, reformatted, or added under an alias.
 */

const fs = require('fs');
const path = require('path');

const AUTOMATIC_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'schedule'];
const EXCEPTIONS = { 'publish-gate.yml': ['pull_request'] };

/** @description Find every YAML workflow in stable order. */
function workflowFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => path.join(dir, file));
}

/** @description Extract top-level trigger names from block and inline `on` forms. */
function declaredTriggers(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start === -1) return [];
  const inline = /^on:\s*\[?([a-z_,\s]+)\]?\s*$/.exec(lines[start]);
  if (inline?.[1].trim()) return inline[1].split(',').map((value) => value.trim()).filter(Boolean);

  const out = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[a-zA-Z_]/.test(lines[index])) break;
    const match = /^ {2}([a-z_]+):/.exec(lines[index]);
    if (match) out.push(match[1]);
  }
  return out;
}

/** @description Return trigger-policy violations for all workflow files. */
function findViolations(files) {
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const triggers = declaredTriggers(source);
    const allowed = EXCEPTIONS[path.basename(file)] || [];
    const bad = triggers.filter((trigger) => AUTOMATIC_TRIGGERS.includes(trigger) && !allowed.includes(trigger));
    if (bad.length) violations.push({ file: path.relative(process.cwd(), file), bad });
  }
  return violations;
}

const dir = process.argv[2] || path.join(__dirname, '..', '.github', 'workflows');
const files = workflowFiles(dir);
const violations = findViolations(files);

if (violations.length > 0) {
  console.error('\nGitHub Actions automatic-trigger scope violates the bounded gate policy:\n');
  for (const violation of violations) console.error(`  - ${violation.file}: ${violation.bad.join(', ')}`);
  console.error(
    '\nWorkflows are MANUAL-ONLY (workflow_dispatch). The only exception is publish-gate.yml on ' +
      'pull_request. Automatic triggers bill hosted-runner minutes and have zeroed this account ' +
      'twice; the enforced gate is local — scripts/ci-local.sh, $0.\n',
  );
  process.exit(1);
}

if (!process.argv.includes('--quiet')) {
  console.log(`${files.length} workflow(s) keep automatic execution inside the bounded gate policy.`);
}
