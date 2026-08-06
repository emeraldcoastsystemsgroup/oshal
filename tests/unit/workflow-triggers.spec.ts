/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the manual-only workflow budget after two automatic full-CI billing regressions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Permit the bounded SEC-06 PR/main/weekly workflow while preserving manual-only general CI.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW_DIR = '.github/workflows';
const AUTOMATIC_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'schedule'];
const EXCEPTIONS: Record<string, string[]> = {
  'publish-gate.yml': ['pull_request'],
  'security.yml': ['pull_request', 'push', 'schedule'],
};

/** @description Extract top-level trigger keys from block and inline workflow `on` forms. */
function declaredTriggers(source: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start === -1) return [];
  const inline = /^on:\s*\[?([a-z_,\s]+)\]?\s*$/.exec(lines[start]);
  if (inline?.[1].trim()) return inline[1].split(',').map((value) => value.trim()).filter(Boolean);

  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[a-zA-Z_]/.test(lines[index])) break;
    const match = /^ {2}([a-z_]+):/.exec(lines[index]);
    if (match) out.push(match[1]);
  }
  return out;
}

describe('GitHub Actions automatic-trigger budget', () => {
  const files = existsSync(WORKFLOW_DIR)
    ? readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file))
    : [];

  it('finds the workflow directory and every workflow remains manually runnable', () => {
    expect(existsSync(WORKFLOW_DIR)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const triggers = declaredTriggers(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
      expect(triggers, `${file} cannot be run manually`).toContain('workflow_dispatch');
    }
  });

  it.each(files)('%s declares no unsanctioned automatic trigger', (file) => {
    const triggers = declaredTriggers(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    const allowed = EXCEPTIONS[file] ?? [];
    const bad = triggers.filter((trigger) => AUTOMATIC_TRIGGERS.includes(trigger) && !allowed.includes(trigger));
    expect(bad, `${file} widened automatic execution beyond the reviewed budget`).toEqual([]);
  });

  it('keeps the public publish gate PR-only', () => {
    const source = readFileSync(join(WORKFLOW_DIR, 'publish-gate.yml'), 'utf8');
    const triggers = declaredTriggers(source);
    expect(triggers).toContain('pull_request');
    for (const forbidden of ['push', 'schedule', 'pull_request_target']) expect(triggers).not.toContain(forbidden);
  });

  it('keeps the security gate PR + exact-main + weekly only', () => {
    const source = readFileSync(join(WORKFLOW_DIR, 'security.yml'), 'utf8');
    const triggers = declaredTriggers(source);
    expect(triggers.sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch'].sort());
    expect(source).toMatch(/^  push:\s*\n    branches: \[main\]$/m);
    expect(source).toMatch(/^  schedule:\s*\n    - cron: "17 07 \* \* 1"$/m);
    expect(source).not.toContain('pull_request_target:');
  });
});
