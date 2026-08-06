/**
 * App-store remote rail (ADR-085 D7): the store CATALOG + one-call install-from-store.
 *
 * Two endpoints on the /api/swarm/apps router (mount-level requiresAuth applies):
 *  - GET  /catalog        — the store repo's machine-derived marketplace.json, fetched
 *                           server-side (OSHAL_STORE_TOKEN honored for a private store; an
 *                           absent token degrades honestly to available:false, never an
 *                           error loop). Any signed-in user may browse.
 *  - POST /install-remote — OPERATOR-ONLY (requiresOperator, fail-closed allowlist): fetch
 *                           the named package from the catalog's own `source:` block via the
 *                           battle-tested installer (scripts/oshal-app.js install — sparse
 *                           git-subdir clone, package validation, npm-style dependency
 *                           resolution, provenance stamp) into the writable deployed-apps/
 *                           volume, then hot-load it through the SAME SwarmAppService.loadApp
 *                           rail every other install path uses. This installs CODE, so the
 *                           gate matches the strictest apps-route precedent (guest-tier /
 *                           dropData / update-apply): operators only, nobody by default.
 *
 * The repo/ref always come from the CATALOG entry — never from the caller — so this endpoint
 * can only ever install what the store publishes (no arbitrary-git-URL fetch surface).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D7: GET /api/swarm/apps/catalog (marketplace.json via the store repo, OSHAL_STORE_TOKEN-aware, honest degrade) + operator-only POST /api/swarm/apps/install-remote (catalog-pinned source -> scripts/oshal-app.js install -> SwarmAppService.loadApp hot-load). Closes the "install-remote planned, not built" backlog entry.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Default the store to the PUBLIC repo. This route defaulted to the private trunk while scripts/oshal-install.sh downloaded the public snapshot — one product, two stores, and the one the cockpit asked for is unreadable without a token, so every signed-in user without OSHAL_STORE_TOKEN saw an empty Discover shelf and an honest-but-useless "not anonymously readable". The private trunk is now the OVERRIDE (set OSHAL_STORE_REPO on a box that should read it), not the default.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: isolate the catalog-pinned installer child from controller/database/session/provider credentials; forward only OS/runtime, proxy/TLS settings, non-interactive Git controls, and the exact resolved store token.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: retain only canonical audit pointers in the registry, refuse installable rows without one, and pass the fail-closed audit mode into the isolated installer.
 */
import path from 'path';
import { execFile } from 'child_process';
import type { Router, Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import { resolvePackageAuditMode } from '@/features/swarm-apps';
import { installerLogTail, resolveStoreToken } from './update-check-cron';

const logger = createChildLogger({ module: 'app-store-remote' });

const WORKSPACE_ROOT = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
const DEPLOYED_APPS_DIR = path.join(WORKSPACE_ROOT, 'deployed-apps');
/**
 * The store repo the catalog is read from — the PUBLIC store, which is what the installer
 * (scripts/oshal-install.sh) downloads and the only one an unauthenticated deployment can read.
 * A box that should read the private trunk instead sets OSHAL_STORE_REPO + OSHAL_STORE_TOKEN.
 */
const STORE_REPO = process.env.OSHAL_STORE_REPO || 'https://github.com/emeraldcoastsystemsgroup/oshal-apps';
const STORE_REF = process.env.OSHAL_STORE_REF || 'main';
const FETCH_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
/** Same slug contract as the installer + the update-apply route. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REMOTE_INSTALL_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
] as const;

/**
 * Build the store installer's least-privilege environment.
 *
 * The child needs Node/Git runtime discovery, temporary storage, and optional network trust
 * configuration. It does not need the controller database, session authority, connector keys,
 * model-provider keys, or the operator's ambient Git credential helpers. The already resolved
 * store token is the only credential admitted and remains absent for public-store installs.
 */
export function buildRemoteAppInstallerProcessEnv(
  storeToken: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of REMOTE_INSTALL_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  if (storeToken) env.OSHAL_STORE_TOKEN = storeToken;
  return env;
}

/** One catalog entry, as the Discover surface renders it (never hand-typed anywhere). */
export interface CatalogApp {
  name: string;
  displayName: string;
  description: string;
  suite: string | null;
  version: string | null;
  /** Store lifecycle: only 'ready' entries are installable. */
  status: string;
  source: { url: string; path: string; ref: string } | null;
  /** APP-02 immutable attestation pointer; null means browse-only and never installable. */
  audit: { record: string; sourceSha: string } | null;
}

/** The catalog fetch result — `available:false` is the HONEST degrade, not an error. */
export interface StoreCatalog {
  available: boolean;
  /** Human-readable reason when unavailable (e.g. private store without OSHAL_STORE_TOKEN). */
  reason?: string;
  repo: string;
  apps: CatalogApp[];
}

/**
 * @description Resolve the raw.githubusercontent.com URL for the store's marketplace.json.
 * Only GitHub https repos are resolvable (the only store shape that exists); tolerates a
 * trailing `.git` / slash, mirroring rawManifestUrl in the update-check daemon.
 * @param repo - the store repo URL (default: the oshal-applications store)
 * @param ref - the branch/tag to read (default main)
 * @returns the raw marketplace.json URL, or null when the repo is not GitHub-shaped
 */
export function marketplaceUrl(repo: string = STORE_REPO, ref: string = STORE_REF): string | null {
  const m = String(repo).trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${encodeURIComponent(ref)}/marketplace.json`;
}

/**
 * @description Parse marketplace.json text into typed catalog entries. Fail-soft PER ENTRY —
 * one malformed store row must never hide the other 40 — but fail-closed on a document that
 * is not a `{ apps: [...] }` object (that is a broken store, not a partial one).
 * @param text - the fetched marketplace.json body
 * @returns the valid entries, in store order
 * @throws when the document itself is unparseable or has no apps array
 */
export function parseCatalog(text: string): CatalogApp[] {
  const doc = JSON.parse(text) as { apps?: unknown };
  if (!doc || !Array.isArray(doc.apps)) throw new Error('marketplace.json has no apps[] array');
  const out: CatalogApp[] = [];
  for (const raw of doc.apps) {
    const a = raw as Record<string, unknown>;
    if (typeof a?.name !== 'string' || !NAME_RE.test(a.name)) continue;
    const src = a.source as Record<string, unknown> | undefined;
    const source =
      src && typeof src.url === 'string' && typeof src.path === 'string'
        ? { url: src.url, path: src.path, ref: typeof src.ref === 'string' ? src.ref : 'main' }
        : null;
    const auditValue = a.audit as Record<string, unknown> | undefined;
    const auditKeys = auditValue && !Array.isArray(auditValue) ? Object.keys(auditValue).sort() : [];
    const audit = auditValue
      && auditKeys.join(',') === 'record,sourceSha'
      && auditValue.record === `audits/${a.name}.json`
      && typeof auditValue.sourceSha === 'string'
      && /^[0-9a-f]{40}$/.test(auditValue.sourceSha)
      ? { record: auditValue.record, sourceSha: auditValue.sourceSha }
      : null;
    out.push({
      name: a.name,
      displayName: typeof a.displayName === 'string' ? a.displayName : a.name,
      description: typeof a.description === 'string' ? a.description : '',
      suite: typeof a.suite === 'string' ? a.suite : null,
      version: typeof a.version === 'string' || typeof a.version === 'number' ? String(a.version) : null,
      status: typeof a.status === 'string' ? a.status : 'unknown',
      source,
      audit,
    });
  }
  return out;
}

let catalogCache: { at: number; catalog: StoreCatalog } | null = null;

/**
 * @description Fetch the store catalog (marketplace.json) with the same token posture as the
 * update-check daemon: OSHAL_STORE_TOKEN (fallback GITHUB_TOKEN) authorizes a private store;
 * with no token a private store reports `available:false` with a reason — an honest degrade,
 * never a throw. Cached for 5 minutes; `refresh` bypasses the cache.
 * @param refresh - true to bypass the in-memory cache
 * @returns the catalog (possibly unavailable, never rejected)
 */
export async function fetchStoreCatalog(refresh = false): Promise<StoreCatalog> {
  if (!refresh && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
  const url = marketplaceUrl();
  if (!url) {
    return { available: false, reason: `store repo is not a GitHub https URL: ${STORE_REPO}`, repo: STORE_REPO, apps: [] };
  }
  let catalog: StoreCatalog;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const token = resolveStoreToken();
    const headers: Record<string, string> = { 'User-Agent': 'oshal-app-store', Accept: 'text/plain' };
    if (token) headers.Authorization = `token ${token}`;
    const res = await fetch(url, { signal: ac.signal, headers });
    if (!res.ok) {
      catalog = {
        available: false,
        reason:
          res.status === 404 || res.status === 403
            ? `store catalog not ${token ? 'readable with the configured token' : 'anonymously readable'} (HTTP ${res.status})${token ? '' : ' — set OSHAL_STORE_TOKEN for a private store'}`
            : `store catalog fetch failed (HTTP ${res.status})`,
        repo: STORE_REPO,
        apps: [],
      };
    } else {
      catalog = { available: true, repo: STORE_REPO, apps: parseCatalog(await res.text()) };
    }
  } catch (err) {
    logger.warn({ err, url }, 'store catalog fetch failed');
    catalog = { available: false, reason: 'store catalog unreachable', repo: STORE_REPO, apps: [] };
  } finally {
    clearTimeout(timer);
  }
  catalogCache = { at: Date.now(), catalog };
  return catalog;
}

/** What install-remote needs from the app layer — SwarmAppService.loadApp, injected. */
export interface InstallRemoteDeps {
  loadApp: (manifestPath: string, scopeMeta?: { ownerSub?: string | null }) => Promise<unknown>;
}

type InstallResult =
  | { ok: true; name: string; log: string }
  | { ok: false; status: number; error: string; log?: string };

/**
 * @description One-call install from the store catalog: resolve the package IN the catalog
 * (the caller supplies only a name — repo/ref/path come from the store's own entry, so this
 * can never fetch an arbitrary git URL), run the battle-tested installer (sparse clone at the
 * entry's source, package validation, npm-style dependency resolution, provenance stamp) into
 * deployed-apps/, then hot-load through the injected SwarmAppService.loadApp rail. Fail-closed
 * at every step: bad name 400, not in catalog 404, catalog unavailable 503, not `status:
 * ready` 409, non-GitHub source 409, installer failure 502 (nothing partially registered).
 * @param name - the catalog package name (slug-validated)
 * @param ownerSub - the installing session's sub, stamped as owner on load (the
 *  little-monsters RLS lesson: a person-scoped package with a NULL owner vanishes)
 * @param deps - the injected loadApp
 * @returns ok + installer log tail, or a status-shaped error for the route to surface
 */
export async function installRemoteApp(name: string, ownerSub: string | null, deps: InstallRemoteDeps): Promise<InstallResult> {
  if (!NAME_RE.test(name)) return { ok: false, status: 400, error: 'invalid package name' };
  const catalog = await fetchStoreCatalog();
  if (!catalog.available) {
    return { ok: false, status: 503, error: `store catalog unavailable: ${catalog.reason ?? 'unknown'}` };
  }
  const entry = catalog.apps.find((a) => a.name === name);
  if (!entry) return { ok: false, status: 404, error: `"${name}" is not in the store catalog` };
  if (entry.status !== 'ready') {
    return { ok: false, status: 409, error: `"${name}" is not installable — store status is "${entry.status}"` };
  }
  if (!entry.audit) {
    return { ok: false, status: 409, error: `"${name}" has no valid APP-02 audit binding in the catalog` };
  }
  if (!entry.source || !/^https:\/\/github\.com\//.test(entry.source.url)) {
    return { ok: false, status: 409, error: `"${name}" has no resolvable GitHub source in the catalog` };
  }
  logger.info({ name, repo: entry.source.url, ref: entry.source.ref }, 'install-remote: installing from store');
  const token = resolveStoreToken();
  const auditMode = resolvePackageAuditMode();
  const run = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'oshal-app.js'), 'install', name, '--repo', entry.source!.url, '--ref', entry.source!.ref, '--dest', DEPLOYED_APPS_DIR],
      {
        cwd: process.cwd(),
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...buildRemoteAppInstallerProcessEnv(token),
          OSHAL_PACKAGE_AUDIT_MODE: auditMode,
        },
      },
      (err, stdout, stderr) => {
        const raw = err ? (err as NodeJS.ErrnoException).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : (err ? 1 : 0), output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
  // Strip ANSI color + any token echo before the installer output travels as an API payload.
  const log = installerLogTail(run.output, token);
  if (run.code !== 0) {
    logger.error({ name, code: run.code, log }, 'install-remote: installer failed');
    return { ok: false, status: 502, error: 'install failed — see log', log };
  }
  try {
    await deps.loadApp(path.join(DEPLOYED_APPS_DIR, name, 'oshal-app.yaml'), { ownerSub });
  } catch (err) {
    logger.error({ err, name }, 'install-remote: installed on disk but hot-load failed');
    return {
      ok: false,
      status: 500,
      error: `installed on disk but hot-load failed: ${err instanceof Error ? err.message : String(err)}`,
      log,
    };
  }
  logger.info({ name }, 'install-remote: installed + hot-loaded');
  return { ok: true, name, log };
}

/**
 * @description Register the catalog + install-remote routes on the swarm-apps router.
 * MUST be called before the router's `/:name` params are registered, or `/catalog` would be
 * captured as an app name. Mount-level requiresAuth (server.ts) covers both; install-remote
 * additionally wears requiresOperator — installing code is an operator action, fail-closed
 * (an empty operator allowlist means nobody).
 * @param router - the /api/swarm/apps router
 * @param deps - the injected loadApp (SwarmAppService)
 * @returns nothing; mutates the router
 */
export function registerAppStoreRemoteRoutes(router: Router, deps: InstallRemoteDeps): void {
  router.get('/catalog', async (req: Request, res: Response) => {
    try {
      const catalog = await fetchStoreCatalog(req.query.refresh === '1');
      res.json(catalog);
    } catch (err) {
      logger.error({ err }, 'GET /catalog failed');
      res.status(500).json({ error: 'catalog fetch failed' });
    }
  });

  router.post('/install-remote', requiresOperator, async (req: Request, res: Response) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    logger.info({ name, by: getCaller(req).sub }, 'POST /install-remote');
    try {
      const result = await installRemoteApp(name, getCaller(req).sub ?? null, deps);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, log: result.log });
        return;
      }
      res.status(201).json({ installed: true, name: result.name, log: result.log });
    } catch (err) {
      logger.error({ err, name }, 'install-remote failed');
      res.status(500).json({ error: 'install failed' });
    }
  });
}
