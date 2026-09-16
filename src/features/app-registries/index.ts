/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com | ADR-147 D10: the resolve-and-pin fence joins the barrel, so the routes and the guards reach it the same way they reach the literal-URL fence.
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
export type {
  RegistryHostKind, RegistrySource, CatalogFetchResult, CatalogFetchDeps,
} from './services/registry-host-adapters';

export {
  isBlockedAddress,
  resolveHostFence,
  pinnedLookup,
  gitResolveArgs,
  DEFAULT_HOST_RESOLVER,
} from './services/registry-dns-fence';
export type { HostResolver, PinnedAddress, HostFenceResult } from './services/registry-dns-fence';
