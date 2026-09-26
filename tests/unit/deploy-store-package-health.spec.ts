/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com    | Pin the Git Bash package-deploy health probe against the MSYS_NO_PATHCONV curl output-path trap.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(resolve(__dirname, '..', '..', 'scripts', 'deploy-store-package.sh'), 'utf8');

describe('store-package deploy host readiness', () => {
  it('keeps Docker container paths literal without passing /dev/null to Windows curl', () => {
    expect(script).toContain('export MSYS_NO_PATHCONV=1');
    expect(script).toMatch(/until curl -sf -m 5 "http:\/\/127\.0\.0\.1:\$PORT\/health" >\/dev\/null 2>&1; do/);
    expect(script).not.toMatch(/^\s*(?:until )?curl[^\n]*-o \/dev\/null/m);
  });
});
