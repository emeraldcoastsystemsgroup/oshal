/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove connector CLIs preserve exact env/file subject bytes and cannot reintroduce trim-based owner aliasing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';
import { requireExactUserSubject as requireKernelSubject } from '@/shared/security/exact-user-subject';

const require = createRequire(import.meta.url);
const cliSubject = require('../../scripts/lib/exact-user-subject.js') as {
  requireExactUserSubject(value: unknown): string;
  resolveExactUserSubject(options: { env: NodeJS.ProcessEnv; cwd: string }): string | undefined;
};
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exact-subject-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('connector CLI exact-subject reader', () => {
  it('preserves significant environment and scope-file bytes', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.oshal-user-sub'), ' File Subject ', 'utf8');
    expect(cliSubject.resolveExactUserSubject({ env: { OSHAL_USER_SUB: ' Env Subject ' }, cwd: root }))
      .toBe(' Env Subject ');
    expect(cliSubject.resolveExactUserSubject({ env: { OSHAL_USER_SUB: '' }, cwd: root }))
      .toBe(' File Subject ');
  });

  it('matches the kernel validator and fails closed on malformed files', () => {
    const root = tempRoot();
    for (const subject of ['plain', ' surrounding ', '🙂', '   ']) {
      expect(cliSubject.requireExactUserSubject(subject)).toBe(requireKernelSubject(subject));
    }
    fs.writeFileSync(path.join(root, '.oshal-user-sub'), 'line\n', 'utf8');
    expect(() => cliSubject.resolveExactUserSubject({ env: {}, cwd: root }))
      .toThrow(/control-free/);
    expect(cliSubject.resolveExactUserSubject({ env: {}, cwd: tempRoot() })).toBeUndefined();
  });

  it('guards every script from trimming an asserted or scoped subject', () => {
    const scriptsRoot = path.resolve(process.cwd(), 'scripts');
    const files = fs.readdirSync(scriptsRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:js|ts)$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/OSHAL_USER_SUB[^\r\n]{0,160}\.trim\s*\(/);
      expect(source, file).not.toMatch(/\.oshal-user-sub[^\r\n]{0,160}\.trim\s*\(/);
    }
  });
});
