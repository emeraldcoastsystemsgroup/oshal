/** CLI and activation share this exact package-local validator. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { LoadedPackageTestCatalog, PackageTestCatalog } from './types';
const contract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-test-catalog.js')) as {
  validatePackageTestCatalog(value: unknown, manifest: { name?: string; smoke?: unknown }): PackageTestCatalog;
  loadPackageTestCatalog(packageDir: string, manifest: { name?: string; testing?: unknown; uses?: unknown; smoke?: unknown }): LoadedPackageTestCatalog | null;
  packageTestSource(packageDir: string): string;
};
export const validatePackageTestCatalog = contract.validatePackageTestCatalog;
export const loadPackageTestCatalog = contract.loadPackageTestCatalog;
export const packageTestSource = contract.packageTestSource;
export * from './types';
