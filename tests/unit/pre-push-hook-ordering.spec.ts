/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the one ordering rule inside .githooks/pre-push: the publish gate — the only wall between this public repo and the world — must run BEFORE the OSHAL_SKIP_PREPUSH_VERIFY escape hatch returns. The flag documented itself as "you may skip the typecheck, never the leak gate" while sitting at the top of the script, so any agent that used it to get past an unrunnable typecheck silently pushed ungated. A comment cannot enforce an ordering; this does.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = resolve('.githooks/pre-push');

describe('.githooks/pre-push — the publish gate outranks the skip flag', () => {
  const hook = readFileSync(HOOK_PATH, 'utf8');

  it('invokes publish-gate.sh', () => {
    expect(hook).toContain('publish-gate.sh');
  });

  it('reaches the publish gate before the OSHAL_SKIP_PREPUSH_VERIFY early exit', () => {
    const gateAt = hook.indexOf('publish-gate.sh');
    const skipAt = hook.search(/if \[ "\$\{OSHAL_SKIP_PREPUSH_VERIFY:-0\}" = "1" \]/);
    expect(gateAt).toBeGreaterThan(-1);
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeGreaterThan(gateAt);
  });

  it('has exactly one OSHAL_SKIP_PREPUSH_VERIFY branch, so there is no second earlier exit', () => {
    const matches = hook.match(/\$\{OSHAL_SKIP_PREPUSH_VERIFY:-0\}/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('exits non-zero when the publish gate fails (the gate is fail-closed, never advisory)', () => {
    const gateBlock = hook.slice(hook.indexOf('publish-gate.sh'), hook.indexOf('publish-gate.sh') + 400);
    expect(gateBlock).toContain('exit 1');
  });
});
