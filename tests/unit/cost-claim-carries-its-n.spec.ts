/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P6 guard: the incident-RCA head-to-head ($1.30 vs $4.05) was published on ten surfaces — README, whitepaper, WHY_OSHAL, both decks, the deck generator, two sales personas, the fluency register and the backlog — with no n anywhere and no limits beside it. This holds every one of them to "the number never travels alone", and holds the multi-ticket-type census to the generated artifact so the wider claim cannot be hand-typed either.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review of #623: the strip-the-n mutation removed BOTH n's at once, so it never exercised a bare "$1.30" beside "$4.05 (n=7)" in one sentence — which the per-segment check passed. Added that single-figure mutation as a red case, on the real README and on an invented sentence, and the ledger-tie cases: the census total must equal the ledger total read in the same transaction (the first capture published $149.82 against a $92.05 ledger by charging one task to every ticket it was linked to).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// The checker is CommonJS so the CLI gate runs without a TypeScript bootstrap, exactly like
// scripts/site-apps-catalog.js behind tests/unit/doc-count-claims.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checker = require('../../scripts/cost-claim-check.js') as {
  CENSUS_DOC: string;
  CENSUS_JSON: string;
  claimErrors: (readFile?: (file: string) => string, files?: string[]) => string[];
  censusErrors: (census: Record<string, unknown>, doc: string) => string[];
  figureSpans: (text: string) => Array<{ figure: string; text: string }>;
  ledgerTieErrors: (census: Record<string, unknown>, typeCount: number) => string[];
  renderCensusTable: (census: Record<string, unknown>) => string;
  surfaceFiles: (repo?: string) => string[];
};

const REPO = join(__dirname, '..', '..');
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');

/** The scanned corpus is ~1.3k files; read it once so the mutation cases stay cheap. */
let files: string[] = [];
let corpus = new Map<string, string>();
const fromCorpus = (file: string): string => corpus.get(file) ?? read(file);

/** One mutation: the same corpus with a single file's text replaced. */
function withEdit(file: string, edit: (text: string) => string): (target: string) => string {
  return (target) => (target === file ? edit(fromCorpus(file)) : fromCorpus(target));
}

beforeAll(() => {
  files = checker.surfaceFiles();
  corpus = new Map(files.map((file) => [file, read(file)]));
});

describe('a published cost figure never travels without its n (BACKLOG P6)', () => {
  it('scans the real tracked surfaces, not a hand-kept list', () => {
    // A vacuous scan is the failure mode this guard exists to avoid: if discovery ever returns
    // an empty or tiny set, every assertion below passes while proving nothing.
    expect(files.length).toBeGreaterThan(100);
    for (const known of ['README.md', 'docs/WHY_OSHAL.md', 'docs/OSHAL-WHITEPAPER.md',
      'docs/assets/oshal/OSHAL-overview-deck.md', 'docs/assets/oshal/build_oshal_deck.py',
      'ai-lab/bot-personas/capture-specialist.yaml', 'docs/BACKLOG.md']) {
      expect(files).toContain(known);
    }
  });

  it('every $1.30 / $4.05 on every surface states its n and its limits', () => {
    expect(checker.claimErrors(fromCorpus, files)).toEqual([]);
  });

  it('goes red when a surface drops the n, and names the file and line', () => {
    const errors = checker.claimErrors(
      withEdit('README.md', (text) => text.replace(/\(n=1[^)]*\)/, '').replace(/\(n=7[^)]*\)/, '')),
      files,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('README.md:');
    expect(errors.join('\n')).toContain('no n in the same segment');
  });

  it('goes red when ONE figure loses its n while the other in the same sentence keeps it', () => {
    // The reviewer's mutation on #623: strip only "(n=1)" from the README so "$1.30" sits bare
    // in the same sentence as "$4.05 (n=7 historical incident tickets)". A per-segment check
    // let the second figure's n vouch for the first; the n has to travel with each figure.
    const original = fromCorpus('README.md');
    expect(original).toContain('$1.30 (n=1)');
    const errors = checker.claimErrors(withEdit('README.md', (text) => text.replace('$1.30 (n=1)', '$1.30')), files);
    const readme = errors.filter((error) => error.startsWith('README.md:'));
    expect(readme.length).toBe(1);
    expect(readme[0]).toContain('states $1.30 with no n');
  });

  it('holds the n per figure on an invented sentence: the bare one is named, the qualified one is not', () => {
    const invented = 'docs/business/a-new-slide.md';
    const text = 'oshal runs an RCA for $1.30 where the pipeline cost $4.05 (n=7 tickets) — one workload, not a benchmark.\n';
    const errors = checker.claimErrors((target) => (target === invented ? text : fromCorpus(target)), [...files, invented]);
    const mine = errors.filter((error) => error.startsWith(`${invented}:`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('states $1.30 with no n');
    expect(mine.join('\n')).not.toContain('states $4.05');
    // And the spans themselves: the first figure owns the lead-in, the second owns its tail.
    expect(checker.figureSpans(text).map((span) => span.figure)).toEqual(['$1.30', '$4.05']);
    expect(checker.figureSpans('median of n=7 tickets | $4.05 |')[0].text).toContain('n=7');
  });

  it('goes red when the block around the figure drops its limits', () => {
    const errors = checker.claimErrors(
      withEdit('docs/OSHAL-WHITEPAPER.md', (text) => text.replace(/one workload/g, 'routinely')
        .replace(/one corpus/g, 'many corpora').replace(/not a benchmark/g, 'a benchmark')),
      files,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('docs/OSHAL-WHITEPAPER.md:');
    expect(errors.join('\n')).toContain('carries none of the limits');
  });

  it('catches a brand-new surface that quotes the number bare — discovery, not an allowlist', () => {
    const invented = 'docs/business/a-new-slide.md';
    const errors = checker.claimErrors(
      (target) => (target === invented ? 'oshal runs an RCA for $1.30 instead of $4.05.\n' : fromCorpus(target)),
      [...files, invented],
    );
    expect(errors.some((error) => error.startsWith(`${invented}:`))).toBe(true);
  });
});

describe('the wider cost claim is generated from the ledger (BACKLOG P6)', () => {
  const census = (): Record<string, unknown> => JSON.parse(read(checker.CENSUS_JSON));

  it('the published census is clean, dated, sourced and covers more than one ticket type', () => {
    const artifact = census();
    expect(checker.censusErrors(artifact, read(checker.CENSUS_DOC))).toEqual([]);
    expect((artifact.ticketTypes as unknown[]).length).toBeGreaterThan(1);
    expect(String(artifact.capturedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('every census row carries an n and a median, so no number is published bare', () => {
    for (const row of census().ticketTypes as Array<Record<string, unknown>>) {
      expect(Number(row.tickets)).toBeGreaterThanOrEqual(1);
      expect(typeof row.medianCostUsd).toBe('number');
      expect(Number(row.maxCostUsd)).toBeGreaterThanOrEqual(Number(row.medianCostUsd));
    }
  });

  it('goes red when the census collapses back to a single ticket type', () => {
    const artifact = census();
    artifact.ticketTypes = (artifact.ticketTypes as unknown[]).slice(0, 1);
    const errors = checker.censusErrors(artifact, read(checker.CENSUS_DOC));
    expect(errors.join('\n')).toContain('more than one ticket type');
  });

  it('goes red when the published table is hand-edited away from the artifact', () => {
    const doc = read(checker.CENSUS_DOC).replace(/\| n=\d+ \|/, '| n=999 |');
    expect(checker.censusErrors(census(), doc).join('\n')).toContain('not what');
  });

  it('the census total is the ledger total — each task counted once, not once per linked ticket', () => {
    const artifact = census();
    const ledger = artifact.ledger as { tasks: number; llmRequests: number; costUsd: number };
    const totals = artifact.totals as { llmRequests: number; costUsd: number };
    expect(ledger.tasks).toBeGreaterThan(0);
    expect(Math.abs(totals.costUsd - ledger.costUsd)).toBeLessThanOrEqual(0.01);
    expect(totals.llmRequests).toBe(ledger.llmRequests);
    const summed = (artifact.ticketTypes as Array<{ totalCostUsd: number }>).reduce((sum, row) => sum + row.totalCostUsd, 0);
    expect(Math.abs(summed - ledger.costUsd)).toBeLessThanOrEqual(0.01);
    expect(checker.ledgerTieErrors(artifact, (artifact.ticketTypes as unknown[]).length)).toEqual([]);
  });

  it('goes red when the census sums to more than the ledger — the #623 first-capture defect', () => {
    const artifact = census();
    const ledger = artifact.ledger as { costUsd: number; llmRequests: number };
    // The shape of the original defect: 30 multi-linked tasks charged 2–5 times over.
    artifact.totals = { ...(artifact.totals as object), costUsd: ledger.costUsd + 57.77, llmRequests: ledger.llmRequests + 185 };
    const errors = checker.censusErrors(artifact, read(checker.CENSUS_DOC));
    expect(errors.join('\n')).toContain('charged to more than one ticket');
    expect(errors.join('\n')).toContain('LLM calls but the ledger holds');
  });

  it('goes red when the artifact carries no ledger to tie to', () => {
    const artifact = census();
    delete artifact.ledger;
    expect(checker.censusErrors(artifact, read(checker.CENSUS_DOC)).join('\n')).toContain('missing ledger');
  });

  it('goes red when the artifact loses its date or its source', () => {
    const artifact = census();
    delete artifact.capturedAt;
    delete artifact.source;
    const errors = checker.censusErrors(artifact, read(checker.CENSUS_DOC));
    expect(errors.join('\n')).toContain('missing capturedAt');
    expect(errors.join('\n')).toContain('missing source');
  });
});
