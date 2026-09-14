/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define versioned package test metadata without executable command inputs.
 */
/** @description Classify the evidence required by a declared suite. */
export type PackageTestLevel = 'unit' | 'integration' | 'browser' | 'live';
/** @description Reference a fixed runner family and confined suite files; never a shell command. */
export type PackageTestRunner = { kind: 'smoke'; smoke: string } | {
  kind: 'vitest' | 'node-test' | 'playwright' | 'external'; scope: 'package' | 'core'; files: string[]; revision?: string;
};
/** @description Bind the manifest to a versioned package-local catalog. */
export interface PackageTestDeclaration { version: 1; catalog: string }
/** @description Declare purpose, prerequisites and isolation without claiming execution. */
export interface PackageTestCase {
  id: string; name: string; purpose: string; level: PackageTestLevel; runner: PackageTestRunner;
  expected: string[]; prerequisites: string[];
  sideEffects: 'none' | 'fixture-write' | 'external-write' | 'device-action';
  isolation: { mode: 'none' | 'disposable' | 'live'; fixtures?: string[]; cleanup?: string };
  limits: { timeoutMs: number; maxMemoryMb?: number };
  installation: 'never' | 'safe-smoke';
}
/** @description Keep suite identifiers inside one explicit schema version. */
export interface PackageTestCatalog { version: 1; cases: PackageTestCase[] }
/** @description Attach file-content fingerprints for stale-result and selection checks. */
export interface LoadedPackageTestCatalog { catalog: PackageTestCatalog; revisions: Record<string, string> }
