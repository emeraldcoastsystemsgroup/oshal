/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The shared harness for the two watchdog-check specs (trading-watchdog-checks.spec.ts and trading-watchdog-corroboration.spec.ts), extracted when the first passed 975 code lines. Holds the shipped-file paths and sources, the plain-object fixtures (position, order, settings, BOOK, kindsOf, NOW) and mutationHarness(): the MUTANT loader that rewrites one exact, unique substring of the shipped module into a scratch copy, plus dispose(), which removes the scratch dir and asserts the shipped module's sha256 is byte-identical to what the run started with. Each spec owns its own scratch dir; nothing here writes to the repo.
 */
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Repo root, resolved from tests/helpers. */
export const root = join(__dirname, '..', '..');
/** The shipped decidable-checks module the specs load and mutate copies of. */
export const modulePath = join(root, 'scripts', 'lib', 'trading-watchdog-checks.js');
/** The shipped PowerShell watchdog whose plumbing the original spec executes. */
export const watchdogPath = join(root, 'scripts', 'trading-watchdog.ps1');
/** The module's bytes as text, for mutation anchors and the ASCII assertion. */
export const moduleSource = readFileSync(modulePath, 'utf8');
/** The watchdog's bytes as text, for the source-pinned wiring cases. */
export const watchdogSource = readFileSync(watchdogPath, 'utf8');
/** The PowerShell binary the plumbing cases spawn. */
export const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const C = require(modulePath);

/** The specs' fixed clock: a Friday 11:00 ET, inside regular trading hours. */
export const NOW = Date.parse('2026-09-04T15:00:00.000Z');
/**
 * @description An ISO timestamp n minutes before NOW, for order ages.
 * @param n - Minutes before the fixed clock.
 * @returns ISO string.
 */
export const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

/**
 * @description A broker position row in the api's shape, overridable per case.
 * @param symbol - Ticker.
 * @param over - Field overrides.
 * @returns The row.
 */
export const position = (symbol: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ symbol, qty: 100, avgEntryPrice: 100, marketValue: 10_000, unrealizedPl: 0, ...over });

/**
 * @description A ledger order row (a resting sell by default), overridable per case.
 * @param symbol - Ticker.
 * @param over - Field overrides.
 * @returns The row.
 */
export const order = (symbol: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ symbol, side: 'sell', status: 'accepted', qty: '10.000000', limit_price: null, created_at: minutesAgo(5), ...over });

/**
 * @description The module defaults plus the evaluator's non-numeric inputs, overridable per case.
 * @param over - Setting overrides.
 * @returns Settings for evaluateBook.
 */
export const settings = (over: Record<string, unknown> = {}): any => Object.assign(
  C.defaultSettings({}), { core: new Set<string>(), rth: true, nowMs: NOW }, over);

/** The default book under audit. */
export const BOOK = { ref: 'b-spec', enabled: true };

/**
 * @description The sorted finding kinds of an evaluation, the shape most cases assert on.
 * @param r - An evaluateBook result.
 * @returns Sorted kind names.
 */
export const kindsOf = (r: { findings: Array<{ kind: string }> }): string[] => r.findings.map((f) => f.kind).sort();

/** What mutationHarness() hands a spec. */
export interface MutationHarness {
  /** A per-spec scratch directory for mutants, fetcher copies, probe scripts and state files. */
  scratch: string;
  /** Loads a MUTANT copy of the shipped module with one exact substring replaced. */
  mutant: (from: string, to: string) => any;
  /** Removes the scratch dir and asserts the shipped module is byte-identical to the run's start. */
  dispose: () => void;
}

/**
 * @description Builds a spec's mutation harness. `mutant` loads a copy of the shipped module with
 * one exact substring replaced - the repo file is never touched, the mutant lives in the scratch
 * dir, and a `from` text that is absent or not unique throws, so a refactor that renames a guarded
 * line fails loudly instead of quietly proving nothing. `dispose` belongs in the spec's afterAll:
 * it removes the scratch dir and asserts the shipped module's hash is unchanged.
 * @returns The harness.
 */
export function mutationHarness(): MutationHarness {
  const scratch = mkdtempSync(join(tmpdir(), 'oshal-wd-checks-'));
  const hashBefore = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
  const mutant = (from: string, to: string): any => {
    expect(moduleSource.split(from).length - 1, `mutation anchor is not unique: ${from}`).toBe(1);
    const file = join(scratch, `mutant-${createHash('sha1').update(from + to).digest('hex').slice(0, 10)}.js`);
    writeFileSync(file, moduleSource.replace(from, to));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(file);
  };
  const dispose = (): void => {
    rmSync(scratch, { recursive: true, force: true });
    expect(createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
      'the mutation cases must never write to the shipped module').toBe(hashBefore);
  };
  return { scratch, mutant, dispose };
}
