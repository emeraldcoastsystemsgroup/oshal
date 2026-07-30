/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the deploy script's FAILURE contract, which had no test at all. On 2026-07-29 a deploy hit a docker-engine 500, rolled back, the rollback's own api never came up, and the run ended with exit 1 — the same code as a deploy that failed safely — while the box sat with no api container. The operator learned it from `docker ps`. These cases assert the three things that make that impossible to repeat: every step inside rollback() is result-checked (never fire-and-forget), a degraded rollback exits 3 with a named recovery order, and a clean rollback still exits 1. Structural assertions on the script text, because the real thing recreates 34 containers and cannot run in a unit suite — so each case pins a SPECIFIC line shape whose removal is the regression, not a vague substring.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/oshal-deploy.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

/** The body of rollback(), from its opening line to its closing brace at column 0. */
function rollbackBody(): string {
  const start = src.indexOf('\nrollback() {');
  expect(start, 'rollback() must exist').toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end, 'rollback() must be brace-terminated').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('oshal-deploy.sh — the rollback tells you whether the stack is serving', () => {
  it('checks the result of EVERY mutating step inside rollback (none fire-and-forget)', () => {
    const body = rollbackBody();
    // The three steps that were previously unchecked. Each must have its result consumed
    // by a `||` handler on the same logical statement.
    const mustBeChecked = [
      { what: 'docker tag (restore :latest)', re: /docker tag "\$ROLLBACK_TAG" "\$IMAGE"\s*\|\|/ },
      { what: 'api recreate', re: /up -d --force-recreate --no-deps "\$API_SERVICE"[^\n]*\\?\s*\n?\s*\|\|/ },
      { what: 'bot recreate', re: /recreate_bots\s*\|\|/ },
      { what: 'wait_api', re: /wait_api\s*\|\|/ },
    ];
    for (const step of mustBeChecked) {
      expect(step.re.test(body), `${step.what} must have its failure handled inside rollback()`).toBe(true);
    }
  });

  it('marks the run degraded on any rollback-step failure rather than only logging it', () => {
    const body = rollbackBody();
    // wait_api's failure used to be a bare `|| log "..."`, which is the exact shape that
    // hid a dead api behind a success-shaped exit code.
    expect(/wait_api \|\| \{[^}]*degraded=1/.test(body), 'a failed wait_api must set degraded').toBe(true);
    expect(/recreate_bots \|\| \{[^}]*degraded=1/.test(body), 'a failed bot recreate must set degraded').toBe(true);
    expect(/parity drift[^\n]*\n\s*degraded=1|degraded=1[^\n]*\n?/.test(body), 'parity drift must set degraded').toBe(true);
    // And the flag must actually gate an exit, not just be assigned.
    expect(/if \[ "\$degraded" -eq 1 \]/.test(body), 'degraded must gate the exit decision').toBe(true);
  });

  it('exits 3 — a code of its own — when the rollback did not restore a serving stack', () => {
    const body = rollbackBody();
    const degradedBlock = body.slice(body.indexOf('if [ "$degraded" -eq 1 ]'));
    expect(degradedBlock).toMatch(/exit 3/);
    // Exit 3 must be reachable ONLY from the degraded branch: a plain `exit 3` elsewhere
    // would make the code meaningless.
    expect((body.match(/exit 3/g) || []).length).toBe(1);
  });

  it('still exits 1 when the rollback DID restore the previous image (a safe failure)', () => {
    const body = rollbackBody();
    // The final exit of rollback(), after the degraded branch, is the safe-failure path.
    const tail = body.slice(body.lastIndexOf('exit 3'));
    expect(tail).toMatch(/exit 1/);
    expect(tail, 'the safe-failure exit should say the stack is serving').toMatch(/serving/i);
  });

  it('names a concrete recovery order in the degraded message, not just "investigate"', () => {
    const body = rollbackBody();
    const degradedBlock = body.slice(body.indexOf('if [ "$degraded" -eq 1 ]'));
    // The 2026-07-29 run's only guidance was "investigate". These are the two scripts that
    // actually recover the documented failure modes, plus the check that confirms it worked.
    expect(degradedBlock).toMatch(/oshal-up\.sh/);
    expect(degradedBlock).toMatch(/api-bounce\.sh/);
    expect(degradedBlock).toMatch(/deploy-parity-check\.sh/);
  });

  it('documents the exit codes it uses, including 3', () => {
    const header = src.slice(0, src.indexOf('set -uo pipefail'));
    expect(header).toMatch(/EXIT:/);
    expect(header, 'exit 3 must be documented in the contract').toMatch(/\b3\b[^\n]*(serving|hands|degraded)/i);
  });

  it('leaves the no-rollback and preflight contracts intact', () => {
    // --no-rollback must still stop with 1 (deploy failed, operator owns the stack) and
    // preflight failures must still be 2, so the new code cannot have shifted them.
    expect(/NO_ROLLBACK" -eq 1 \] && \{[^}]*exit 1/.test(rollbackBody())).toBe(true);
    expect(src).toMatch(/fail2\(\) \{[^}]*exit 2/);
  });

  it('is syntactically valid bash', () => {
    // A structural spec that passes against a script bash cannot parse is worthless.
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(res.stderr || '').toBe('');
    expect(res.status).toBe(0);
  });
});
