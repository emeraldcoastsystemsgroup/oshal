/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cost guard as a TEST, so it fails in the normal suite and not only in the nightly gate. GitHub Actions workflows must be MANUAL-ONLY: hosted-runner minutes are the account's binding constraint and this has regressed TWICE — per-push CI (07-08), then an "hourly during business hours" cron on the public mirror that ran ~55 full pipelines a week, unattended, until the account hit zero (07-14). A rule nobody enforces is a rule that comes back.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW_DIR = '.github/workflows';

/** Triggers that make GitHub run a workflow — and bill us — without a human asking. */
const AUTOMATIC_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'schedule'];

/**
 * @description Extract the top-level trigger keys from a workflow's `on:` block.
 *
 * Text-based on purpose: it must also catch a trigger that is reformatted or commented back in.
 * Top-level triggers sit at exactly two spaces under `on:`; `push:` as a docker/build-push-action
 * PARAMETER is indented far deeper and is correctly ignored.
 *
 * @param src - Workflow YAML source.
 * @returns The declared trigger names.
 */
function declaredTriggers(src: string): string[] {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start === -1) return [];

  const inline = /^on:\s*\[?([a-z_,\s]+)\]?\s*$/.exec(lines[start]);
  if (inline && inline[1].trim()) {
    return inline[1].split(',').map((s) => s.trim()).filter(Boolean);
  }

  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[a-zA-Z_]/.test(lines[i])) break; // next top-level key
    const m = /^ {2}([a-z_]+):/.exec(lines[i]);
    if (m) out.push(m[1]);
  }
  return out;
}

describe('GitHub Actions cost guard — workflows are MANUAL-ONLY', () => {
  const files = existsSync(WORKFLOW_DIR)
    ? readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))
    : [];

  it('finds the workflow directory', () => {
    expect(existsSync(WORKFLOW_DIR)).toBe(true);
  });

  // The single most expensive mistake this repo has made, twice. An automatic trigger bills hosted
  // runner minutes forever, unattended — an hourly cron on the public mirror quietly ran ~55 full
  // pipelines a week (7 jobs each, incl. a Docker build+push) until the account hit zero.
  // The ONE exception, mirroring scripts/check-workflow-triggers.js. This repo is public-track, so
  // publish-gate.sh is the only thing between a commit and the world — and a pre-push hook is
  // bypassable (--no-verify, or a clone that never set core.hooksPath). It must run server-side on
  // every PR or it is a suggestion, not a gate. Cost is a checkout plus a grep. Scoped to one file
  // AND one trigger: publish-gate.yml may declare pull_request, never push or schedule.
  const EXCEPTIONS: Record<string, string[]> = { 'publish-gate.yml': ['pull_request'] };

  it.each(files)('%s declares NO unsanctioned automatic trigger', (file) => {
    const triggers = declaredTriggers(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    const allowed = EXCEPTIONS[file] ?? [];
    const automatic = triggers.filter((t) => AUTOMATIC_TRIGGERS.includes(t) && !allowed.includes(t));

    expect(
      automatic,
      `${file} would run on ${automatic.join('/')} and bill hosted-runner minutes. ` +
        `Workflows must be workflow_dispatch only — the one automated gate is LOCAL (scripts/ci-local.sh, $0).`,
    ).toEqual([]);
  });

  it('the publish-gate exception stays narrow — PR only, never push or schedule', () => {
    const gate = join(WORKFLOW_DIR, 'publish-gate.yml');
    if (!existsSync(gate)) return;
    const triggers = declaredTriggers(readFileSync(gate, 'utf8'));
    expect(triggers, 'the publish gate must run on every PR — that is the bypass-proof half').toContain(
      'pull_request',
    );
    for (const costly of ['push', 'schedule', 'pull_request_target']) {
      expect(triggers, `publish-gate.yml widened to ${costly} — the exception is PR-only`).not.toContain(
        costly,
      );
    }
  });

  it('every workflow can still be run by hand (workflow_dispatch)', () => {
    for (const file of files) {
      const triggers = declaredTriggers(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
      expect(triggers, `${file} has no workflow_dispatch — it could never be run at all`).toContain(
        'workflow_dispatch',
      );
    }
  });
});
