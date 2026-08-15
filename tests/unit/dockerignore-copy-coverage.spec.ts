/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard: every `COPY docs/<x>/` in Dockerfile.oshal must have a matching `!docs/<x>/` re-include in .dockerignore. Written after `main` shipped unbuildable for 85 commits — #189 added `COPY docs/guides/` for the in-cockpit help pages without the .dockerignore exception, so `docker build` died at that step with "file not found in build context or excluded by .dockerignore". Nothing caught it because no test builds the image; the break only surfaces when someone actually deploys.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * @description Directory paths a Dockerfile COPYs out of the build context.
 * @param {string} dockerfile Dockerfile contents.
 * @returns {string[]} Source directory paths, trailing slash stripped.
 */
function copiedDirs(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^\s*COPY\s+(?:--\S+\s+)*([^\s]+\/)\s+\S+/gm)]
    .map((m) => m[1].replace(/\/$/, ''))
    .filter((p) => !p.startsWith('/') && !p.includes('*'));
}

/**
 * @description Whether .dockerignore excludes a path without re-including it.
 * Mirrors Docker's last-match-wins rule for the shapes this repo actually uses:
 * a bare directory line excludes it, a later `!path` (or `!ancestor`) restores it.
 * @param {string[]} lines .dockerignore lines, comments and blanks removed.
 * @param {string} target Path being COPYed.
 * @returns {boolean} True when the build context would NOT contain the path.
 */
function isExcluded(lines: string[], target: string): boolean {
  let excluded = false;
  const segments = target.split('/');
  // Every ancestor of the target, plus the target itself: excluding `docs` hides `docs/guides`.
  const selfAndAncestors = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  for (const raw of lines) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/\/$/, '');
    if (selfAndAncestors.includes(pattern)) excluded = !negated;
  }
  return excluded;
}

describe('.dockerignore covers every Dockerfile COPY', () => {
  it('Dockerfile.oshal never COPYs a directory the build context excludes', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile.oshal'), 'utf8');
    const ignoreLines = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const broken = copiedDirs(dockerfile).filter((dir) => isExcluded(ignoreLines, dir));

    expect(
      broken,
      `Dockerfile.oshal COPYs these paths, but .dockerignore excludes them — `
        + `docker build fails at that step with "file not found in build context":\n`
        + broken.map((d) => `  COPY ${d}/  →  add "!${d}/" to .dockerignore`).join('\n'),
    ).toEqual([]);
  });

  // Pins the specific regression rather than trusting the generic rule alone: docs/ is excluded
  // wholesale, so each COPYed subdirectory needs its own re-include and it is easy to add the
  // COPY and forget the exception — which is exactly what happened.
  it('keeps the re-includes the docs COPYs depend on', () => {
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile.oshal'), 'utf8');

    for (const dir of ['docs/governance', 'docs/guides']) {
      if (!dockerfile.includes(`COPY ${dir}/`)) continue;
      expect(ignore, `.dockerignore must re-include ${dir}/ — Dockerfile.oshal COPYs it`)
        .toMatch(new RegExp(`^!${dir}/?$`, 'm'));
    }
  });
});
