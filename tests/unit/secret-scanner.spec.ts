/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the Security Center secret-scanner
 *              | honesty fixes: no fabricated "committed" outside a git checkout, AWS doc keys and
 *              | bare identifier captures skipped, *.test.* paths treated as example files.
 */

/**
 * @description
 * Unit tests for the secret scanner's false-positive fixes. The 2026-06-27 Security Center scan
 * labeled every finding "committed" (the in-container scan root has no .git, and the old fallback
 * assumed tracked), flagged AWS documentation keys from DLP test fixtures as critical, and reported
 * identifier NAMES (KEYCLOAK_CLIENT_SECRET, type names) captured by the generic assignment rule as
 * secrets. These tests scan a throwaway non-git directory and pin the corrected behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSecrets } from '../../src/features/security/secret-scanner';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-secret-scan-'));
  // Real-looking key in a plain file (the value is a nonsense test string, not a live credential).
  fs.writeFileSync(path.join(root, 'app.ts'), 'const k = { apiKey: "9f8e7d6c5b4a39281706f5e4d3c2b1a0" };\n');
  // AWS documentation example key — must be skipped entirely.
  fs.writeFileSync(path.join(root, 'docs-key.ts'), 'const aws = "AKIAIOSFODNN7EXAMPLE";\n');
  // Identifier capture — a REFERENCE to a secret, not a secret value.
  fs.writeFileSync(path.join(root, 'oidc-like.ts'), 'const c = { clientSecret: KEYCLOAK_CLIENT_SECRET };\n');
  // Co-located test file — hits must be de-escalated as example fixtures. The PEM header is
  // assembled at runtime so THIS source file never contains the contiguous marker (the repo's
  // pre-commit secret guard would flag it — the very false-positive class these tests pin).
  const pemHeader = ['-----BEGIN RSA', 'PRIVATE', 'KEY-----'].join(' ');
  fs.writeFileSync(path.join(root, 'redactor.test.ts'), `const pk = "${pemHeader}";\n`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanSecrets — git-unavailable honesty', () => {
  it('never claims "committed" when the scan root is not a git checkout', () => {
    const report = scanSecrets(root);
    expect(report.available).toBe(true);
    expect(report.note).toContain('tracked-status unknown');
    for (const f of report.findings) {
      expect((f.evidence as { committed?: unknown }).committed).toBeNull();
      expect(f.detail).not.toContain('git-tracked (committed)');
    }
  });

  it('de-escalates below base severity when tracked-ness is unproven', () => {
    const report = scanSecrets(root);
    const hit = report.findings.find((f) => (f.evidence as { file?: string }).file === 'app.ts');
    expect(hit).toBeDefined();
    // 'Secret assignment' base is high; unknown tracked-ness drops one level.
    expect(hit!.severity).toBe('medium');
  });
});

describe('scanSecrets — false-positive suppression', () => {
  it('skips AWS documentation keys (…EXAMPLE suffix)', () => {
    const report = scanSecrets(root);
    expect(report.findings.some((f) => (f.evidence as { file?: string }).file === 'docs-key.ts')).toBe(false);
  });

  it('skips bare identifier captures from the generic assignment rule', () => {
    const report = scanSecrets(root);
    expect(report.findings.some((f) => (f.evidence as { file?: string }).file === 'oidc-like.ts')).toBe(false);
  });

  it('treats *.test.* files as example fixtures (double de-escalation)', () => {
    const report = scanSecrets(root);
    const hit = report.findings.find((f) => (f.evidence as { file?: string }).file === 'redactor.test.ts');
    expect(hit).toBeDefined();
    expect((hit!.evidence as { exampleFile?: boolean }).exampleFile).toBe(true);
    // Private key base critical → unknown-tracked drops to high → example drops twice more → low.
    expect(hit!.severity).toBe('low');
    expect(hit!.detail).toContain('likely benign');
  });
});
