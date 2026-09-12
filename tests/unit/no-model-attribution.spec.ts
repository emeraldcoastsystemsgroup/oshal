/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: no tracked text file may carry a model co-author trailer (a Co-Authored-By line at the vendor's no-reply address) or a "Generated with" model-tool footer. No model attribution is allowed in this repo's commits, PR bodies or files (operator directive); scripts/test-lab-nightly.mjs stamped such a trailer into every auto-committed report, and the history of three repos had to be rewritten to remove it. Scans tracked files via git when a .git dir exists and walks the tree otherwise (the ci-local --head export shape), and proves it goes red on a fixture that contains the trailer.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { extname, join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const SELF = 'tests/unit/no-model-attribution.spec.ts';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// ~50 MB of tracked text; a cold-cache read right after a fresh export has been measured at ~6 s,
// and the ceiling leaves room for a loaded CI host without weakening the assertion.
const TREE_WALK_TIMEOUT_MS = 60_000;

/** Never text; skipped by extension so the walk does not read images and archives. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2',
  '.ttf', '.eot', '.pptx', '.docx', '.xlsx', '.mp3', '.mp4', '.wav', '.bin', '.exe', '.dll', '.jar',
]);

/**
 * The two shapes the harness appends. A trailer must carry the vendor no-reply address and the
 * footer must be the markdown link, so prose that merely mentions the words does not match.
 */
const ATTRIBUTION = /co-authored-by:[^\n]*<noreply@anthropic\.com>|generated with \[claude code\]\(/i;

/**
 * @description Enumerate the files to scan: tracked files when git metadata exists, else a full
 * walk that skips dependency and VCS directories (the export shape used by ci-local --head).
 * @param root - Directory to enumerate.
 * @returns Root-relative paths with forward slashes.
 */
function listFiles(root: string): string[] {
  if (existsSync(join(root, '.git'))) {
    const out = execFileSync('git', ['-C', root, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  }
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
      else files.push(relPath);
    }
  };
  walk(root, '');
  return files;
}

/**
 * @description Find every text file under a root that carries model attribution.
 * @param root - Checkout or fixture directory.
 * @returns Root-relative paths of offending files (empty when the tree is clean).
 */
function findAttribution(root: string): string[] {
  const offenders: string[] = [];
  for (const rel of listFiles(root)) {
    if (rel === SELF || BINARY_EXT.has(extname(rel).toLowerCase())) continue;
    const abs = join(root, rel);
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size > MAX_TEXT_BYTES) continue;
    const bytes = readFileSync(abs);
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary without a listed extension
    if (ATTRIBUTION.test(bytes.toString('utf8'))) offenders.push(rel);
  }
  return offenders;
}

/**
 * @description Build a fixture tree (no .git, so the walk path is exercised) with one file.
 * @param name - File name inside the fixture.
 * @param content - File content.
 * @returns Fixture directory path.
 */
function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-model-attribution-'));
  writeFileSync(join(dir, name), content);
  return dir;
}

describe('no model attribution in tracked files', () => {
  it('this tree carries no model co-author trailer or model-tool footer', () => {
    expect(findAttribution(REPO_ROOT)).toEqual([]);
  }, TREE_WALK_TIMEOUT_MS);

  it('goes red on a file that carries the co-author trailer', () => {
    const trailer = ['Co-Authored-By', ': Some Model <noreply@', 'anthropic.com>'].join('');
    const dir = fixture('notes.md', `chore: nightly report\n\n${trailer}\n`);
    try {
      expect(findAttribution(dir)).toEqual(['notes.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goes red on a file that carries the generated-with footer', () => {
    const footer = ['Generated with [Claude', ' Code](https://example.invalid/tool)'].join('');
    const dir = fixture('PR_BODY.md', `## Summary\n\nfix\n\n${footer}\n`);
    try {
      expect(findAttribution(dir)).toEqual(['PR_BODY.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag prose that merely mentions the words', () => {
    const dir = fixture('policy.md', 'Co-Authored-By trailers naming a model are forbidden; nothing is generated with a model byline.\n');
    try {
      expect(findAttribution(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
