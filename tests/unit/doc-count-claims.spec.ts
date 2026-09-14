/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-9 guard: every count written into the whitepaper, reference, stem-cell and feature-catalog pages must equal the count scripts/site-apps-catalog.js derives from the tree, and the registry-bot counter must agree with the registry the runtime actually serves. Hand-typed "26 registry bots · 68 persona definitions" and "63 ADRs (latest ADR-061)" drifted for months because nothing owned them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry-local';

type Counts = Record<string, number>;

// The repository script is CommonJS so it can run without a TypeScript bootstrap.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const catalog = require('../../scripts/site-apps-catalog.js') as {
  countRepo: () => Counts;
  docClaimErrors: (counts?: Counts, readDoc?: (file: string) => string) => string[];
  DOC_CLAIMS: Array<{ file: string; what: string; count: string }>;
};

const REPO = join(__dirname, '..', '..');
const readDoc = (file: string): string => readFileSync(join(REPO, file), 'utf8');

describe('doc count claims are derived from the tree (BUG-9)', () => {
  it('every gated count in the docs equals the tree count', () => {
    expect(catalog.docClaimErrors()).toEqual([]);
  });

  it('the registry-bot counter agrees with the registry the runtime serves', () => {
    expect(catalog.countRepo().registryBots).toBe(LOCAL_BOT_REGISTRY.length);
  });

  it('a stale literal goes red and names the file and both numbers', () => {
    const counts = catalog.countRepo();
    const stale = catalog.docClaimErrors(counts, (file) =>
      file === 'docs/reference.md'
        ? readDoc(file).replace(`${counts.personas} persona YAML files`, '68 persona YAML files')
        : readDoc(file));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('docs/reference.md');
    expect(stale[0]).toContain(`claims 68, repo has ${counts.personas}`);
  });

  it('a reworded claim goes red instead of silently leaving the gate', () => {
    const errors = catalog.docClaimErrors(catalog.countRepo(), (file) =>
      file === 'docs/reference.md' ? readDoc(file).replace('persona YAML files', 'persona files') : readDoc(file));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no longer contains the phrase');
  });

  it('covers each page the bug named', () => {
    const files = new Set(catalog.DOC_CLAIMS.map((c) => c.file));
    for (const file of ['docs/OSHAL-WHITEPAPER.md', 'docs/reference.md', 'docs/the-stem-cell-model.md',
      'docs/architecture/platform-feature-catalog.md']) {
      expect(files.has(file)).toBe(true);
    }
  });
});
