/** Versioned metadata, never an executable command supplied by a package or browser. */
export type PackageTestLevel = 'unit' | 'integration' | 'browser' | 'live';
export type PackageTestRunner = { kind: 'smoke'; smoke: string } | {
  kind: 'vitest' | 'node-test' | 'playwright' | 'external'; scope: 'package' | 'core'; files: string[]; revision?: string;
};
export interface PackageTestDeclaration { version: 1; catalog: string }
export interface PackageTestCase {
  id: string; name: string; purpose: string; level: PackageTestLevel; runner: PackageTestRunner;
  expected: string[]; prerequisites: string[];
  sideEffects: 'none' | 'fixture-write' | 'external-write' | 'device-action';
  isolation: { mode: 'none' | 'disposable' | 'live'; fixtures?: string[]; cleanup?: string };
  limits: { timeoutMs: number; maxMemoryMb?: number };
  installation: 'never' | 'safe-smoke';
}
export interface PackageTestCatalog { version: 1; cases: PackageTestCase[] }
export interface LoadedPackageTestCatalog { catalog: PackageTestCatalog; revisions: Record<string, string> }
