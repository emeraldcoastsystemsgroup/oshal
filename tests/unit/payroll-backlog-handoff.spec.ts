/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for BACKLOG "Payroll package backlog handoff". The payroll deferred-work queue was sixteen numbered items in this repository's docs/BACKLOG.md; the handoff deleted them and the queue now lives in the package that ships it (payroll/BACKLOG.md, app store repo). Core documents that were never updated kept pointing readers at a core backlog that no longer holds the items - the same dangling-reference defect the package README and ADR-123 were fixed for. These cases read the SHIPPED core documents off disk and walk the REAL runtime source roots, so both halves of the entry's done-when are asserted against the tree rather than a fixture: every backlog link a core payroll document makes resolves to the package-owned queue, each document still names that queue, and core retains no payroll implementation code - only shared framework dependencies.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');

/** The canonical, package-owned payroll queue. Core cannot link it relatively: it is another repo. */
const PACKAGE_QUEUE_URL =
  'https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/payroll/BACKLOG.md';

/** The core documents that speak about payroll's deferred work and must send the reader to it. */
const CORE_PAYROLL_DOCS = ['docs/apps/payroll.md', 'docs/adr/123-payroll-app.md'];

/**
 * The tree roots that would make core "hold payroll code" rather than a shared framework
 * dependency. Documentation (docs/) and the marketing site (site/) are deliberately NOT here:
 * an ADR and an operator guide are core's to keep, a route or an engine is not (Rule 0c).
 */
const RUNTIME_SOURCE_ROOTS = ['src', 'any-bot', 'swarm-apps', 'scripts', 'ai-lab', 'config-seed'];

/** Directories never worth descending into during the tree walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next']);

/**
 * @description Read a repository file as text, or '' when it is absent, so that a missing file
 * fails on the case's own assertion instead of blowing up in setup.
 * @param rel - Repository-relative path.
 * @returns The file's UTF-8 contents, or an empty string.
 */
function read(rel: string): string {
  const file = path.join(REPO, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * @description Collect every markdown link target in `text` that points at a file named
 * BACKLOG.md, in any directory and in either repository.
 * @param text - Markdown source.
 * @returns The raw link targets, in document order.
 */
function backlogLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const link = /\]\(([^)\s]*BACKLOG\.md)(?:#[^)\s]*)?\)/gi;
  let match = link.exec(text);
  while (match !== null) {
    targets.push(match[1]);
    match = link.exec(text);
  }
  return targets;
}

/**
 * @description Walk a repository directory and return every file path whose name mentions payroll.
 * @param root - Repository-relative directory to walk; a missing directory yields nothing.
 * @returns Repository-relative paths, forward-slashed.
 */
function payrollNamedFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/payroll/i.test(entry.name)) found.push(path.relative(REPO, full).replace(/\\/g, '/'));
        walk(full);
      } else if (/payroll/i.test(entry.name)) {
        found.push(path.relative(REPO, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(REPO, root));
  return found;
}

describe('payroll backlog handoff — the queue lives in the package, and core says so', () => {
  it.each(CORE_PAYROLL_DOCS)('%s links every backlog reference at the package queue', (rel) => {
    const text = read(rel);
    expect(text, `${rel} is missing`).not.toBe('');

    const targets = backlogLinkTargets(text);
    const strays = targets.filter((target) => target !== PACKAGE_QUEUE_URL);
    expect(
      strays,
      `${rel} links a BACKLOG.md that is not the package-owned payroll queue. ` +
        `The sixteen numbered items left this repository at the handoff; a link to core's own ` +
        `backlog sends the reader to a file that no longer holds them.`,
    ).toEqual([]);
  });

  it.each(CORE_PAYROLL_DOCS)('%s names the package-owned queue by path', (rel) => {
    const text = read(rel);
    expect(
      text.includes('payroll/BACKLOG.md'),
      `${rel} never names payroll/BACKLOG.md, so a reader is told what is deferred but not where ` +
        `its done-when criteria live.`,
    ).toBe(true);
  });

  it('the operator guide points at the queue where it lists what is not built', () => {
    const text = read('docs/apps/payroll.md');
    const gaps = text.slice(text.indexOf('## Other known gaps'));
    expect(gaps, 'docs/apps/payroll.md has no "Other known gaps" section').not.toBe('');
    expect(
      backlogLinkTargets(gaps),
      'the gap list must end at the package queue, not at a core backlog that dropped the items',
    ).toContain(PACKAGE_QUEUE_URL);
  });

  it.each(RUNTIME_SOURCE_ROOTS)('core retains no payroll implementation under %s/', (root) => {
    expect(
      payrollNamedFiles(root),
      `core must retain only the shared framework dependencies this app installs against ` +
        `(Rule 0c): payroll ships from the app store repository.`,
    ).toEqual([]);
  });
});
