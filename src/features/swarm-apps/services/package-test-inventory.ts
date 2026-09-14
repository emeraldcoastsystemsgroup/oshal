/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Detect shipped test suites absent from package registration without reading or executing their contents.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface PackageTestInventory {
  appName: string;
  missingRegistrations: string[];
  inventoryError?: string;
}

/** @description Bound metadata traversal and reject links; fixtures without test/spec names are not suites. */
function walk(root: string, relative: string, suites: string[], budget: { entries: number }): void {
  const directory = path.join(root, relative);
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('Invalid test directory.');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (++budget.entries > 4096) throw new Error('Test inventory limit exceeded.');
    if (entry.name.startsWith('.') || ['node_modules', 'data', 'output', 'coverage'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Linked test source is unavailable.');
    const name = relative + '/' + entry.name;
    if (name.length > 512) throw new Error('Test path limit exceeded.');
    if (entry.isDirectory()) walk(root, name, suites, budget);
    else if (entry.isFile() && /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(entry.name)) suites.push(name);
  }
}

/** @description Compare canonical shipped suite filenames with declared package runner files. */
export function inventoryPackageTests(appName: string, packageDir: string, registered: ReadonlySet<string>): PackageTestInventory {
  try {
    const root = realpathSync(packageDir), suites: string[] = [];
    if (existsSync(path.join(root, 'tests'))) walk(root, 'tests', suites, { entries: 0 });
    return { appName, missingRegistrations: suites.filter(file => !registered.has(file)).sort() };
  } catch { return { appName, missingRegistrations: [], inventoryError: 'The current package test inventory could not be verified.' }; }
}
