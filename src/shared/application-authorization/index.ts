/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/** Shared types and the exact validator used by the standalone package CLI. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { AuthorizationCatalog } from './types';
const contract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-authorization-contract.js')) as {
  validateAuthorizationCatalog(value: unknown): AuthorizationCatalog;
  parseAuthorizationCatalog(source: string): AuthorizationCatalog;
  loadApplicationAuthorization(packageDir: string, manifest: { authorization?: unknown; uses?: unknown }): AuthorizationCatalog | null;
};
export const validateAuthorizationCatalog = contract.validateAuthorizationCatalog;
export const parseAuthorizationCatalog = contract.parseAuthorizationCatalog;
export const loadApplicationAuthorization = contract.loadApplicationAuthorization;
export * from './types';
