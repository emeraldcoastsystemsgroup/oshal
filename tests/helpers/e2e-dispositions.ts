/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Reader for tests/e2e-dispositions.json, the registry that gives every Playwright spec outside the green ratchet one explicit class and a reason. playwright.config.ts derives its testIgnore from the registry's unsupported-in-ci rows (so the default `npx playwright test` stops picking up specs that can only run against a signed-in hosted browser, an external IdP, a real model or a docker stack), and tests/unit/e2e-dispositions.spec.ts uses the same reader and the same spec discovery to prove the registry and the green list partition the suite.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The classes a spec outside the green ratchet can carry. */
export const E2E_DISPOSITION_CLASSES = [
  'unsupported-in-ci',
  'product-defect',
  'fixture-defect',
  'awaiting-classification',
] as const;

/** One class from E2E_DISPOSITION_CLASSES. */
export type E2eDispositionClass = (typeof E2E_DISPOSITION_CLASSES)[number];

/** A whole spec file's disposition. */
export interface E2eSpecDisposition {
  file: string;
  class: E2eDispositionClass;
  reason: string;
  /** How to run it where it CAN run (required for unsupported-in-ci). */
  runWith?: string;
  /** The BACKLOG heading that owns the fix (required for product-defect). */
  backlog?: string;
}

/** A single test inside a green-listed spec that skips under the CI e2e env by design. */
export interface E2eSkippedTestDisposition {
  file: string;
  /** The skip call's own description argument, verbatim - the key the skip audit matches on. */
  skipMessage: string;
  class: 'unsupported-in-ci';
  reason: string;
  runWith: string;
}

/** The parsed registry. */
export interface E2eDispositionRegistry {
  specs: E2eSpecDisposition[];
  skippedTests: E2eSkippedTestDisposition[];
}

/** Registry location, relative to the repository root. */
export const E2E_DISPOSITIONS_PATH = 'tests/e2e-dispositions.json';

/**
 * Setting this to a truthy value lifts the registry-derived ignores, so a spec that is
 * unsupported in CI can still be run on purpose against the harness its row names (for example
 * a Keycloak on :8080, or a docker stack for the dynamic-agent proof).
 */
export const INCLUDE_UNSUPPORTED_ENV = 'OSHAL_E2E_INCLUDE_UNSUPPORTED';

/**
 * Playwright's default testMatch (`**\/*.@(spec|test).?(c|m)[jt]s?(x)`) as a RegExp, so the guard
 * discovers exactly the files the runner would.
 */
const PLAYWRIGHT_TEST_FILE = /\.(spec|test)\.(c|m)?[jt]sx?$/;

/**
 * @description Reads and parses the disposition registry. Structural validation lives in the
 * guard (tests/unit/e2e-dispositions.spec.ts) so a malformed row fails there with a message,
 * not inside the Playwright config load.
 * @param repoRoot Repository root (defaults to the current working directory).
 * @returns The registry's spec rows and skipped-test rows.
 */
export function readE2eDispositions(repoRoot: string = process.cwd()): E2eDispositionRegistry {
  const raw = JSON.parse(readFileSync(path.join(repoRoot, E2E_DISPOSITIONS_PATH), 'utf8')) as Partial<E2eDispositionRegistry>;
  return { specs: raw.specs ?? [], skippedTests: raw.skippedTests ?? [] };
}

/**
 * @description The testIgnore globs for the default Playwright config: one per unsupported-in-ci
 * row, unless INCLUDE_UNSUPPORTED_ENV is truthy. Paths are repo-relative with forward slashes;
 * Playwright prefixes a relative string glob with `**\/`, so each one matches only that file.
 * @param registry The parsed registry.
 * @param env Environment to read the opt-in from (defaults to process.env).
 * @returns The globs to add to testIgnore (empty when the opt-in is set).
 */
export function unsupportedInCiIgnores(
  registry: E2eDispositionRegistry,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const optIn = ['true', '1', 'yes'].includes((env[INCLUDE_UNSUPPORTED_ENV] ?? '').toLowerCase().trim());
  if (optIn) return [];
  return registry.specs.filter((row) => row.class === 'unsupported-in-ci').map((row) => row.file);
}

/**
 * @description Checks that the green list and the registry partition the discovered specs: every
 * discovered spec is in exactly one of them, every registry row names a discovered spec once, and
 * every row carries what its class requires (a reason always; runWith for unsupported-in-ci; a
 * backlog heading that exists for product-defect).
 * @param discovered Every spec file Playwright's default testMatch finds (listE2eSpecFiles).
 * @param green The parsed green list.
 * @param registry The parsed registry.
 * @param backlogHeadings The `###`/`##` heading texts of docs/BACKLOG.md, for product-defect rows.
 * @returns One human-readable line per violation; empty when the partition holds.
 */
export function partitionViolations(
  discovered: string[],
  green: string[],
  registry: E2eDispositionRegistry,
  backlogHeadings: string[],
): string[] {
  const out: string[] = [];
  const known = new Set(discovered);
  const greenSet = new Set(green);
  const rows = new Map<string, number>();
  for (const row of registry.specs) {
    rows.set(row.file, (rows.get(row.file) ?? 0) + 1);
    if (!known.has(row.file)) out.push(`${row.file}: registry row for a spec Playwright does not discover`);
    if (greenSet.has(row.file)) out.push(`${row.file}: both in the green list and in the registry`);
    if (!(E2E_DISPOSITION_CLASSES as readonly string[]).includes(row.class)) out.push(`${row.file}: unknown class "${row.class}"`);
    if (!row.reason?.trim()) out.push(`${row.file}: no reason`);
    if (row.class === 'unsupported-in-ci' && !row.runWith?.trim()) out.push(`${row.file}: unsupported-in-ci without runWith`);
    if (row.class === 'product-defect' && !backlogHeadings.includes(row.backlog ?? '')) {
      out.push(`${row.file}: product-defect must name an existing docs/BACKLOG.md heading (got "${row.backlog ?? ''}")`);
    }
  }
  for (const [file, count] of rows) if (count > 1) out.push(`${file}: ${count} registry rows`);
  for (const file of green) if (!known.has(file)) out.push(`${file}: green-list entry for a spec Playwright does not discover`);
  for (const file of discovered) {
    if (!greenSet.has(file) && !rows.has(file)) out.push(`${file}: neither in the green list nor in the registry`);
  }
  for (const row of registry.skippedTests) {
    if (!greenSet.has(row.file)) out.push(`${row.file}: skippedTests row for a spec outside the green list`);
    if (!row.skipMessage?.trim() || !row.reason?.trim() || !row.runWith?.trim()) out.push(`${row.file}: skippedTests row needs skipMessage, reason and runWith`);
  }
  return out;
}

/**
 * @description Every file under tests/ that Playwright's default config would treat as a test
 * file before testIgnore: the default testMatch, with tests/unit (the vitest tree) and
 * node_modules left out. Walks the disk because that is what the runner walks.
 * @param repoRoot Repository root (defaults to the current working directory).
 * @returns Repo-relative forward-slash paths, sorted.
 */
export function listE2eSpecFiles(repoRoot: string = process.cwd()): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (child === 'tests/unit' || entry.name === 'node_modules') continue;
        walk(child);
      } else if (entry.isFile() && PLAYWRIGHT_TEST_FILE.test(entry.name)) {
        found.push(child);
      }
    }
  };
  walk('tests');
  return found.sort();
}
