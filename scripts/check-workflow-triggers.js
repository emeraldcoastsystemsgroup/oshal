#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Fail if a workflow regains an unsanctioned automatic trigger.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Permit the bounded SEC-06 PR/main/weekly workflow while keeping general CI manual-only.
 */

/**
 * @description Enforce the repository's narrow automatic-workflow budget and security contract.
 *
 * General CI remains manual-only. `publish-gate.yml` may run on PRs. `security.yml` must run on
 * PRs, exact main pushes, and one weekly schedule so source and advisory drift are both covered.
 * No other workflow may run automatically.
 */

const fs = require('fs');
const path = require('path');

const AUTOMATIC_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'schedule'];
const EXCEPTIONS = {
  'publish-gate.yml': ['pull_request'],
  'security.yml': ['pull_request', 'push', 'schedule'],
};

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

/** @description Validate the exact scope of the one scheduled security workflow. */
function securityTriggerViolations(source, triggers) {
  const violations = [];
  const required = ['pull_request', 'push', 'schedule', 'workflow_dispatch'];
  violations.push(...required.filter((trigger) => !triggers.includes(trigger)).map((v) => `missing-${v}`));
  if (!/^  push:\s*\n    branches: \[main\]$/m.test(source)) violations.push('push-not-main-only');
  if (!/^  schedule:\s*\n    - cron: "17 07 \* \* 1"$/m.test(source)) violations.push('schedule-not-weekly');
  return violations;
}

/** @description Return trigger-policy violations for all workflow files. */
function findViolations(files) {
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const triggers = declaredTriggers(source);
    const basename = path.basename(file);
    const allowed = EXCEPTIONS[basename] || [];
    const bad = triggers.filter((trigger) => AUTOMATIC_TRIGGERS.includes(trigger) && !allowed.includes(trigger));
    if (basename === 'security.yml') bad.push(...securityTriggerViolations(source, triggers));
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
    '\nGeneral workflows remain manual-only. Only publish-gate.yml (PR) and security.yml ' +
      '(PR, exact main push, one weekly schedule) may run automatically.\n',
  );
  process.exit(1);
}

if (!process.argv.includes('--quiet')) {
  console.log(`${files.length} workflow(s) keep automatic execution inside the bounded gate policy.`);
}
