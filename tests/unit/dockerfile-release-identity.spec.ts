/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 guard on the image's release identity. OSHAL_RELEASE changes on every release cut, and an ARG or ENV changes the cache key of every layer after it: declared above the heavy RUN layers it would turn each cut into a full multi-GB rebuild (the GIT_SHA lesson of 2026-07-25), and folded into IMAGE_VERSION - declared before those layers - it would do the same. These cases pin the declaration after the final stage's last RUN, the ENV that /api/version reads, the oshal.release label cut-release.sh verifies, and IMAGE_VERSION left untouched.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dockerfile = fs.readFileSync(path.resolve(process.cwd(), 'Dockerfile.oshal'), 'utf8');

/** The instructions of the final build stage, one entry per logical line (continuations joined). */
function finalStageInstructions(): string[] {
  const logical: string[] = [];
  let current = '';
  for (const raw of dockerfile.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!current && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
    if (current && line.trimStart().startsWith('#')) continue;
    current = current ? `${current} ${line.trim()}` : line.trim();
    if (current.endsWith('\\')) { current = current.slice(0, -1).trimEnd(); continue; }
    logical.push(current);
    current = '';
  }
  const lastFrom = logical.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
  expect(lastFrom, 'Dockerfile.oshal must have a FROM').toBeGreaterThan(-1);
  return logical.slice(lastFrom);
}

describe('Dockerfile.oshal release identity (ADR-167)', () => {
  const stage = finalStageInstructions();
  const indexOf = (re: RegExp) => stage.findIndex((l) => re.test(l));

  it('declares ARG OSHAL_RELEASE exactly once, after the final stage\'s last RUN', () => {
    const args = stage.filter((l) => /^ARG\s+OSHAL_RELEASE\b/.test(l));
    expect(args).toEqual(['ARG OSHAL_RELEASE=unreleased']);
    const lastRun = stage.map((l) => /^RUN\s/.test(l)).lastIndexOf(true);
    expect(lastRun).toBeGreaterThan(-1);
    expect(indexOf(/^ARG\s+OSHAL_RELEASE\b/)).toBeGreaterThan(lastRun);
    expect(dockerfile.match(/^ARG\s+OSHAL_RELEASE\b/gm)).toHaveLength(1);
  });

  it('bakes it into the ENV that /api/version reads, after the ARG', () => {
    const env = indexOf(/^ENV\s+OSHAL_RELEASE=\$\{OSHAL_RELEASE\}$/);
    expect(env).toBeGreaterThan(indexOf(/^ARG\s+OSHAL_RELEASE\b/));
  });

  it('labels the image oshal.release, the label cut-release.sh verifies', () => {
    const label = stage.find((l) => /^LABEL\s/.test(l) && l.includes('org.opencontainers.image.revision'));
    expect(label, 'the tail LABEL block must exist').toBeDefined();
    expect(label).toContain('oshal.release="${OSHAL_RELEASE}"');
    expect(stage.indexOf(label as string)).toBeGreaterThan(indexOf(/^ARG\s+OSHAL_RELEASE\b/));
  });

  it('leaves IMAGE_VERSION alone: it sits above the heavy layers and never carries the release', () => {
    expect(dockerfile).toMatch(/^ARG IMAGE_VERSION=dev$/m);
    expect(dockerfile).not.toMatch(/IMAGE_VERSION=\$\{?OSHAL_RELEASE/);
    expect(dockerfile).not.toMatch(/OSHAL_RELEASE=\$\{?IMAGE_VERSION/);
  });
});
