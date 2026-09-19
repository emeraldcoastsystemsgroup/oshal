/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard: every `COPY docs/<x>/` in Dockerfile.oshal must have a matching `!docs/<x>/` re-include in .dockerignore. Written after `main` shipped unbuildable for 85 commits — #189 added `COPY docs/guides/` for the in-cockpit help pages without the .dockerignore exception, so `docker build` died at that step with "file not found in build context or excluded by .dockerignore". Nothing caught it because no test builds the image; the break only surfaces when someone actually deploys.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | This guard was theatre against the exact defect it exists to catch. Its extractor took only COPY sources ENDING IN A SLASH, so a file COPY was invisible, and its matcher compared literal strings, so every glob re-include this .dockerignore relies on matched nothing. Dockerfile.oshal COPYs scripts/image-freshness.js, .dockerignore excluded it, main was unbuildable from source for three days, and this file stayed green throughout. It now covers files and directories and resolves glob patterns the way Docker does - proven by deleting the re-include entries and watching it go red.
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
function copiedPaths(dockerfile: string): string[] {
  // FILES as well as directories. The extractor took `([^\s]+\/)` — sources ending in a slash —
  // so a file COPY was invisible to it, which is exactly the shape that shipped: Dockerfile.oshal
  // COPYs scripts/image-freshness.js and .dockerignore excluded it, leaving main unbuildable from
  // source for three days while this guard stayed green.
  return [...dockerfile.matchAll(/^\s*COPY\s+(?:--\S+\s+)*(.+?)\s+\S+\s*$/gm)]
    .flatMap((m) => m[1].split(/\s+/))
    .map((p) => p.replace(/\/$/, ''))
    .filter((p) => p && !p.startsWith('/') && !p.startsWith('--'));
}

/** A .dockerignore pattern -> regex. `*` matches within one segment, as Docker does. */
function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((segment) => segment.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('/');
  // Matching an ancestor excludes everything under it, which is Docker's behaviour.
  return new RegExp(`^${body}(?:/.*)?$`);
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
  for (const raw of lines) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).replace(/\/$/, '');
    if (!pattern) continue;
    // Globs matter: the re-includes this repo relies on are `!scripts/oshal-*.js`,
    // `!scripts/lib/*.js` and friends. Comparing literal strings, as this did, treated every
    // one of them as matching nothing, so a file restored by a glob still read as excluded —
    // and a file excluded with no glob re-include read the same way. Both directions were blind.
    if (patternToRegExp(pattern).test(target)) excluded = !negated;
  }
  return excluded;
}

describe('.dockerignore covers every Dockerfile COPY', () => {
  it('Dockerfile.oshal never COPYs a path the build context excludes', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile.oshal'), 'utf8');
    const ignoreLines = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const broken = copiedPaths(dockerfile).filter((p) => isExcluded(ignoreLines, p));

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
