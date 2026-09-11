/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Expose the same package-local catalog validator to CLI and activation consumers.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { LoadedPackageTestCatalog, PackageTestCatalog } from './types';
const contract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-test-catalog.js')) as {
  validatePackageTestCatalog(value: unknown, manifest: { name?: string; smoke?: unknown }): PackageTestCatalog;
  loadPackageTestCatalog(packageDir: string, manifest: { name?: string; testing?: unknown; uses?: unknown; smoke?: unknown }): LoadedPackageTestCatalog | null;
  packageTestSource(packageDir: string): string;
};
/** @description Validate metadata without execution. @param value Parsed catalog. @param manifest Owning manifest. @returns Validated catalog. */
export const validatePackageTestCatalog = contract.validatePackageTestCatalog;
/** @description Load confined declared files. @param packageDir Installed root. @param manifest Owning manifest. @returns Catalog and fingerprints, or null. */
export const loadPackageTestCatalog = contract.loadPackageTestCatalog;
/** @description Keep provenance private behind an opaque fingerprint. @param packageDir Installed root. @returns Source identifier. */
export const packageTestSource = contract.packageTestSource;
export * from './types';
