/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147: feature barrel. Everything outside this slice imports from '@/features/app-registries' — never a deep path into services/ (Feature-Sliced Design).
 */

export {
  ensureAppRegistrySchema,
  seedBuiltinRegistry,
  listRegistries,
  getRegistry,
  addRegistry,
  updateRegistry,
  removeRegistry,
  recordFetchOutcome,
  resolveRegistryKey,
  toRegistrySource,
  AppRegistryError,
} from './services/app-registry-store';
export type { AppRegistry, SecretBackend } from './services/app-registry-store';

export {
  inferHostKind,
  normalizeRepoUrl,
  fetchFenceProblem,
  catalogUrlFor,
  buildRegistryGitAuth,
  fetchRegistryCatalog,
  MAX_CATALOG_BYTES,
} from './services/registry-host-adapters';
export type { RegistryHostKind, RegistrySource, CatalogFetchResult } from './services/registry-host-adapters';
