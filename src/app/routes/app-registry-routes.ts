/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147: the /api/swarm/registries surface behind the App Loader. Three things here are the design, not plumbing. (1) PROBE BEFORE SAVE — a registry URL is validated by actually reading its catalog, so an operator cannot trust a source that does not resolve and an unreachable registry is diagnosed at the moment it is added rather than as an empty shelf later. (2) INSTALL PREVIEW — install mounts a package's routes INTO the controller process and runs its migrations against the platform database, so the preview enumerates exactly that (routes, migrations, bots, schedules, connectors, deps, audit posture) and Install is the second click. (3) PER-REGISTRY FENCED AGGREGATION — one unreachable registry renders as a broken row and never fails the page, mirroring how parseCatalog already fails soft per entry.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | FIX (found verifying the live deploy): a catalog audit binding whose sourceSha is the all-zeros UNAUDITED sentinel was counted as "signed". Every one of the 49 live store entries carries exactly that sentinel with an audit record at status "pending", so the loader labelled every unreviewed package "signed — carries a valid audit binding" on the install-decision screen; and because the unsigned gate keyed off the same flag, a third-party registry could skip allow_unsigned=false simply by publishing a sentinel binding. Audit posture is now a tri-state (audited | pending | none) derived from the binding's SHA, and the install decision is one pure exported function the preview AND the install both call, so the screen can no longer promise an install the route will refuse. The BUILT-IN registry deliberately keeps today's behaviour — it defers to OSHAL_PACKAGE_AUDIT_MODE exactly as /api/swarm/apps/install-remote does (ADR-147 D5: the built-in posture does not change) — so fixing the label does not break installs from the default store.
 */

import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import type { Router, Request, Response, RequestHandler } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import yaml from 'js-yaml';
import fs from 'fs';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import {
  ensureAppRegistrySchema, seedBuiltinRegistry, listRegistries, getRegistry,
  addRegistry, updateRegistry, removeRegistry, recordFetchOutcome, toRegistrySource,
  fetchRegistryCatalog, inferHostKind, normalizeRepoUrl, buildRegistryGitAuth, AppRegistryError,
  type AppRegistry, type RegistryHostKind,
} from '@/features/app-registries';
import { resolvePackageAuditMode } from '@/features/swarm-apps';
import { parseCatalog, type CatalogApp } from './app-store-remote';
import { installerLogTail } from './update-check-cron';

const logger = createChildLogger({ module: 'app-registry-routes' });

const WORKSPACE_ROOT = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
const DEPLOYED_APPS_DIR = path.join(WORKSPACE_ROOT, 'deployed-apps');
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * The all-zeros SHA the audit tooling writes into a binding that has NOT been audited
 * (scripts/oshal-package-audit.js UNAUDITED_SOURCE_SHA). A binding carrying it is a placeholder,
 * not an attestation.
 */
export const UNAUDITED_SOURCE_SHA = '0'.repeat(40);

/** Audit posture as the catalog alone can establish it. */
export type AuditState = 'audited' | 'pending' | 'none';

/**
 * @description Derives a package's audit posture from its catalog binding.
 *
 * The catalog carries only a POINTER (`audits/<name>.json` + a source SHA), so this is the most the
 * list can honestly say without fetching every record: `none` when there is no binding, `pending`
 * when the binding holds the unaudited sentinel SHA, `audited` when it binds a real commit. It does
 * NOT claim `audited` means passed — the installer reads the record itself and refuses a failed
 * one in enforce mode — so the page says "audited", never "safe".
 *
 * @param app - a parsed catalog entry
 * @returns the audit posture
 */
export function catalogAuditState(app: Pick<CatalogApp, 'audit'>): AuditState {
  if (!app.audit) return 'none';
  return app.audit.sourceSha === UNAUDITED_SOURCE_SHA ? 'pending' : 'audited';
}

/** What an install may do, decided once and shared by the preview and the install route. */
export interface InstallAuditDecision {
  allowed: boolean;
  /** The OSHAL_PACKAGE_AUDIT_MODE the installer child runs with. */
  auditMode: 'compatible' | 'enforce';
  /** One sentence the confirm screen shows verbatim. */
  note: string;
}

/**
 * @description Decides whether a package may be installed and under which audit mode.
 *
 * ONE function, called by BOTH the preview and the install, so the confirm screen can never offer
 * an install the route will refuse (or refuse one the route would allow).
 *
 *  - **Built-in registry** — defers to the deployment's OSHAL_PACKAGE_AUDIT_MODE exactly as
 *    /api/swarm/apps/install-remote does. ADR-147 D5 promises the built-in posture does not
 *    change; applying the third-party gate here would refuse every pending-audit package in the
 *    default store, which installs today.
 *  - **Third-party, audited** — runs under the deployment's mode; the installer verifies the record.
 *  - **Third-party, pending or no audit** — refused unless that registry's allow_unsigned is on,
 *    and then forced to `compatible`, since an unaudited package can never satisfy enforce.
 *
 * @param state - the package's audit posture
 * @param registry - the source registry's builtin + allowUnsigned flags
 * @param boxMode - the deployment's resolved OSHAL_PACKAGE_AUDIT_MODE
 * @returns whether to install, the mode to run the installer under, and the reason
 */
export function decideInstallAudit(
  state: AuditState,
  registry: Pick<AppRegistry, 'builtin' | 'allowUnsigned' | 'slug'>,
  boxMode: 'compatible' | 'enforce',
): InstallAuditDecision {
  if (registry.builtin) {
    if (state === 'audited') return { allowed: true, auditMode: boxMode, note: 'audited; the installer verifies the record and pins the audited commit' };
    if (boxMode === 'enforce') {
      return { allowed: false, auditMode: boxMode, note: `not audited, and this deployment enforces package audits — it will not install` };
    }
    return { allowed: true, auditMode: boxMode, note: 'not audited yet; this deployment allows it with a warning and installs the branch tip, not an audited commit' };
  }
  if (state === 'audited') return { allowed: true, auditMode: boxMode, note: 'audited by its registry; the installer verifies the record' };
  if (!registry.allowUnsigned) {
    return {
      allowed: false, auditMode: boxMode,
      note: `not audited, and "${registry.slug}" does not allow unaudited packages — turn that on for this source if you accept it`,
    };
  }
  return { allowed: true, auditMode: 'compatible', note: 'not audited; allowed because you enabled unaudited packages for this source' };
}

/** One catalog entry plus which registry it came from — the identity collisions are resolved by. */
export interface AggregatedApp extends CatalogApp {
  registry: string;
  registryLabel: string;
  /** True ONLY when the binding names a real audited commit — never for the sentinel. */
  signed: boolean;
  auditState: AuditState;
}

/** Per-registry catalog cache, replacing the single module-level global of the one-store rail. */
const catalogCache = new Map<string, { at: number; apps: AggregatedApp[]; ok: boolean; reason?: string }>();

/** Maps a store error to its status; anything else is a 500 with no internals leaked. */
function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof AppRegistryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err, context }, 'app-registry route failed');
  res.status(500).json({ error: 'registry operation failed' });
}

/**
 * @description Reads one registry's catalog, honouring the 5-minute cache, and records the
 * outcome on the row so the page can render a broken source honestly.
 * @param pool - Postgres pool.
 * @param registry - the registry to read.
 * @param refresh - true to bypass the cache.
 * @returns The registry's entries plus an ok flag and a reason when not ok.
 */
async function readRegistryCatalog(
  pool: Pool, registry: AppRegistry, refresh: boolean,
): Promise<{ ok: boolean; apps: AggregatedApp[]; reason?: string }> {
  const cached = catalogCache.get(registry.slug);
  if (!refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached;

  const source = await toRegistrySource(pool, registry);
  const result = await fetchRegistryCatalog(source);
  if (!result.ok || !result.text) {
    const entry = { at: Date.now(), apps: [] as AggregatedApp[], ok: false, reason: result.reason };
    catalogCache.set(registry.slug, entry);
    await recordFetchOutcome(pool, registry.slug, { ok: false, error: result.reason });
    return entry;
  }
  let apps: AggregatedApp[];
  try {
    apps = parseCatalog(result.text).map((a) => ({
      ...a,
      registry: registry.slug,
      registryLabel: registry.displayName,
      signed: catalogAuditState(a) === 'audited',
      auditState: catalogAuditState(a),
    }));
  } catch (err) {
    const reason = `catalog is not valid marketplace.json: ${(err as Error).message}`;
    const entry = { at: Date.now(), apps: [] as AggregatedApp[], ok: false, reason };
    catalogCache.set(registry.slug, entry);
    await recordFetchOutcome(pool, registry.slug, { ok: false, error: reason });
    return entry;
  }
  const entry = { at: Date.now(), apps, ok: true };
  catalogCache.set(registry.slug, entry);
  await recordFetchOutcome(pool, registry.slug, { ok: true, packageCount: apps.length });
  return entry;
}

/**
 * @description Reads every enabled, trusted registry and merges the results.
 * PER-REGISTRY FENCED: a failure becomes a `sources[]` row marked not-ok, never an exception —
 * one dead registry must not blank the loader page.
 * @param pool - Postgres pool.
 * @param refresh - true to bypass the caches.
 * @returns The merged apps and a per-source health list.
 */
async function aggregateCatalog(pool: Pool, refresh: boolean): Promise<{
  apps: AggregatedApp[];
  sources: { slug: string; label: string; ok: boolean; reason?: string; count: number }[];
}> {
  const registries = (await listRegistries(pool)).filter((r) => r.enabled && r.trustState === 'trusted');
  const apps: AggregatedApp[] = [];
  const sources: { slug: string; label: string; ok: boolean; reason?: string; count: number }[] = [];
  for (const registry of registries) {
    const result = await readRegistryCatalog(pool, registry, refresh);
    apps.push(...result.apps);
    sources.push({
      slug: registry.slug, label: registry.displayName,
      ok: result.ok, reason: result.reason, count: result.apps.length,
    });
  }
  return { apps, sources };
}

/**
 * @description Enumerates what installing a package would actually DO, by reading its manifest at
 * the pinned ref without installing anything.
 *
 * This is the blast-radius screen. Activation `require()`s the package's routes into the
 * controller process and runs its migrations against the platform database, so "install" is code
 * deployment; the operator is entitled to see the specific list before approving it.
 *
 * @param manifest - the parsed oshal-app.yaml.
 * @param entry - the catalog entry it came from.
 * @returns The bounded description the confirm screen renders.
 */
export function describeManifestImpact(manifest: Record<string, unknown>, entry: AggregatedApp): {
  routes: { count: number; mounts: string[] };
  migrations: { count: number; files: string[] };
  bots: { count: number; names: string[]; dedicatedNodes: number };
  schedules: { count: number; cadences: string[] };
  connectors: string[];
  dependencies: string[];
  signed: boolean;
  auditState: AuditState;
  auditReason: string;
} {
  const routes = Array.isArray(manifest.routes) ? manifest.routes as Record<string, unknown>[] : [];
  const migrations = Array.isArray(manifest.migrations) ? manifest.migrations as string[] : [];
  const bots = Array.isArray(manifest.bots) ? manifest.bots as Record<string, unknown>[] : [];
  const schedules = Array.isArray(manifest.schedules) ? manifest.schedules as Record<string, unknown>[] : [];
  const uses = (manifest.uses ?? {}) as { connectors?: unknown };
  const deps = (manifest.dependencies ?? {}) as { apps?: unknown; connectors?: unknown };
  const connectors = new Set<string>();
  for (const list of [uses.connectors, deps.connectors]) {
    if (Array.isArray(list)) list.forEach((c) => connectors.add(String(c)));
  }
  return {
    routes: {
      count: routes.length,
      mounts: routes.map((r) => String(r.mountPath ?? r.path ?? '?')).slice(0, 12),
    },
    migrations: { count: migrations.length, files: migrations.map(String).slice(0, 12) },
    bots: {
      count: bots.length,
      names: bots.map((b) => String(b.name ?? b.id ?? '?')).slice(0, 12),
      dedicatedNodes: bots.filter((b) => b.requiresOwnNode === true).length,
    },
    schedules: {
      count: schedules.length,
      cadences: schedules.map((s) => String(s.cron ?? s.every ?? s.interval ?? '?')).slice(0, 12),
    },
    connectors: [...connectors].slice(0, 12),
    dependencies: Array.isArray(deps.apps) ? deps.apps.map(String).slice(0, 12) : [],
    signed: entry.signed,
    auditState: entry.auditState,
    auditReason: entry.auditState === 'audited'
      ? 'audited — its registry binds the reviewed commit'
      : entry.auditState === 'pending'
        ? 'audit pending — this package has not been reviewed yet'
        : 'no audit record — this package has not been reviewed',
  };
}

/** Locates a package in the aggregated catalog, resolving `<registry>/<name>` or a bare name. */
async function locate(pool: Pool, registrySlug: string, name: string): Promise<{
  registry: AppRegistry; entry: AggregatedApp;
}> {
  if (!NAME_RE.test(name)) throw new AppRegistryError(400, 'invalid package name');
  const registry = await getRegistry(pool, registrySlug);
  if (!registry) throw new AppRegistryError(404, `no registry named "${registrySlug}"`);
  if (!registry.enabled || registry.trustState !== 'trusted') {
    throw new AppRegistryError(409, `registry "${registrySlug}" is disabled or revoked`);
  }
  const catalog = await readRegistryCatalog(pool, registry, false);
  if (!catalog.ok) throw new AppRegistryError(503, `registry catalog unavailable: ${catalog.reason}`);
  const entry = catalog.apps.find((a) => a.name === name);
  if (!entry) throw new AppRegistryError(404, `"${name}" is not published by "${registrySlug}"`);
  return { registry, entry };
}

/**
 * @description Runs the battle-tested installer for a catalog-pinned package, then hot-loads it
 * through the same SwarmAppService rail every other install path uses.
 * @param pool - Postgres pool.
 * @param registry - the source registry.
 * @param entry - the catalog entry (repo/ref come from HERE, never from the caller).
 * @param ownerSub - the installing session's sub, stamped as owner on load.
 * @param loadApp - injected SwarmAppService.loadApp.
 * @returns ok plus the installer log tail, or a status-shaped error.
 */
async function runInstall(
  pool: Pool, registry: AppRegistry, entry: AggregatedApp, ownerSub: string | null,
  loadApp: (manifestPath: string, scopeMeta?: { ownerSub?: string | null }) => Promise<unknown>,
): Promise<{ ok: true; log: string } | { ok: false; status: number; error: string; log?: string }> {
  if (entry.status !== 'ready') {
    return { ok: false, status: 409, error: `"${entry.name}" is not installable — registry status is "${entry.status}"` };
  }
  const decision = decideInstallAudit(entry.auditState, registry, resolvePackageAuditMode());
  if (!decision.allowed) return { ok: false, status: 409, error: `"${entry.name}": ${decision.note}` };
  if (!entry.source) return { ok: false, status: 409, error: `"${entry.name}" has no resolvable source` };

  const source = await toRegistrySource(pool, registry);
  const run = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'oshal-app.js'), 'install', entry.name,
        '--repo', entry.source!.url, '--ref', entry.source!.ref, '--dest', DEPLOYED_APPS_DIR],
      {
        cwd: process.cwd(), timeout: 180_000, maxBuffer: 1024 * 1024,
        env: {
          ...buildInstallerEnv(),
          ...(source.token ? { OSHAL_STORE_TOKEN: source.token } : {}),
          // Decided once by decideInstallAudit — the same call the preview renders from.
          OSHAL_PACKAGE_AUDIT_MODE: decision.auditMode,
        },
      },
      (err, stdout, stderr) => {
        const raw = err ? (err as NodeJS.ErrnoException).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : (err ? 1 : 0), output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
  const log = installerLogTail(run.output, source.token);
  if (run.code !== 0) return { ok: false, status: 502, error: 'install failed — see log', log };

  try {
    await loadApp(path.join(DEPLOYED_APPS_DIR, entry.name, 'oshal-app.yaml'), { ownerSub });
  } catch (err) {
    return {
      ok: false, status: 500, log,
      error: `installed on disk but hot-load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, log };
}

/** Least-privilege environment for the installer child — no DB, session or provider credentials. */
function buildInstallerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
    'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

/** What the install routes need from the app layer — SwarmAppService.loadApp, injected. */
export interface AppRegistryDeps {
  loadApp: (manifestPath: string, scopeMeta?: { ownerSub?: string | null }) => Promise<unknown>;
}

/**
 * @description Boot step: create the registry table and seed the built-in row from
 * OSHAL_STORE_REPO. Non-fatal — a swarm must still start with a degraded registry store, and the
 * single-store rail (/api/swarm/apps/catalog) keeps working independently of this table.
 * @param pool - Postgres pool.
 * @returns Resolves when ready, or when the failure has been logged.
 */
export async function initializeAppRegistries(pool: Pool): Promise<void> {
  try {
    await ensureAppRegistrySchema(pool);
    const builtin = await seedBuiltinRegistry(pool);
    logger.info({ builtin: builtin.slug, url: builtin.url }, 'app registries initialized');
  } catch (err) {
    logger.error({ err }, 'app registry initialization FAILED — the App Loader will be unavailable');
  }
}

/**
 * @description Builds the app-registry router. EVERY route is operator-gated: browsing a
 * registry catalog reveals what an operator has chosen to trust, and installing runs code.
 * @param pool - Postgres pool.
 * @param requiresAuth - the deployment's auth middleware, injected.
 * @param deps - the injected loadApp.
 * @returns The configured router.
 */
export function createAppRegistryRoutes(pool: Pool, requiresAuth: RequestHandler, deps: AppRegistryDeps): Router {
  const router = createRouter();
  const guard = [requiresAuth, requiresOperator];

  router.get('/', ...guard, async (_req: Request, res: Response) => {
    try { res.json({ registries: await listRegistries(pool) }); }
    catch (err) { fail(res, err, 'GET /'); }
  });

  /** Probe a URL BEFORE it is saved — an operator must not be able to trust a dead source. */
  router.post('/probe', ...guard, async (req: Request, res: Response) => {
    const url = normalizeRepoUrl(String(req.body?.url ?? ''));
    const ref = String(req.body?.ref ?? 'main').trim() || 'main';
    const hostKind = (req.body?.hostKind as RegistryHostKind) || inferHostKind(url);
    try {
      const result = await fetchRegistryCatalog({
        slug: 'probe', url, ref, hostKind,
        token: typeof req.body?.token === 'string' ? req.body.token : '',
        allowPrivateHost: req.body?.allowPrivateHost === true,
      });
      if (!result.ok || !result.text) { res.json({ ok: false, reason: result.reason, hostKind }); return; }
      const apps = parseCatalog(result.text);
      res.json({
        ok: true, hostKind, packageCount: apps.length,
        signedCount: apps.filter((a) => catalogAuditState(a) === 'audited').length,
        sample: apps.slice(0, 8).map((a) => ({ name: a.name, displayName: a.displayName, version: a.version })),
      });
    } catch (err) {
      res.json({ ok: false, hostKind, reason: `catalog is not valid marketplace.json: ${(err as Error).message}` });
    }
  });

  router.post('/', ...guard, async (req: Request, res: Response) => {
    const caller = getCaller(req);
    try {
      const registry = await addRegistry(pool, {
        slug: String(req.body?.slug ?? '').trim(),
        displayName: String(req.body?.displayName ?? '').trim(),
        url: String(req.body?.url ?? ''),
        ref: typeof req.body?.ref === 'string' ? req.body.ref : 'main',
        hostKind: req.body?.hostKind as RegistryHostKind | undefined,
        allowUnsigned: req.body?.allowUnsigned === true,
        allowPrivateHost: req.body?.allowPrivateHost === true,
        token: typeof req.body?.token === 'string' ? req.body.token : '',
        trustedBySub: caller.sub,
        trustNote: typeof req.body?.trustNote === 'string' ? req.body.trustNote : null,
      });
      catalogCache.delete(registry.slug);
      res.status(201).json({ registry });
    } catch (err) { fail(res, err, 'POST /'); }
  });

  router.patch('/:slug', ...guard, async (req: Request, res: Response) => {
    try {
      const registry = await updateRegistry(pool, String(req.params.slug), {
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : undefined,
        url: typeof req.body?.url === 'string' ? req.body.url : undefined,
        ref: typeof req.body?.ref === 'string' ? req.body.ref : undefined,
        hostKind: req.body?.hostKind as RegistryHostKind | undefined,
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
        trustState: req.body?.trustState === 'revoked' || req.body?.trustState === 'trusted' ? req.body.trustState : undefined,
        allowUnsigned: typeof req.body?.allowUnsigned === 'boolean' ? req.body.allowUnsigned : undefined,
        allowPrivateHost: typeof req.body?.allowPrivateHost === 'boolean' ? req.body.allowPrivateHost : undefined,
        token: typeof req.body?.token === 'string' ? req.body.token : undefined,
      });
      catalogCache.delete(registry.slug);
      res.json({ registry });
    } catch (err) { fail(res, err, 'PATCH /:slug'); }
  });

  router.delete('/:slug', ...guard, async (req: Request, res: Response) => {
    try {
      const removed = await removeRegistry(pool, String(req.params.slug));
      catalogCache.delete(String(req.params.slug));
      res.json({ removed });
    } catch (err) { fail(res, err, 'DELETE /:slug'); }
  });

  router.get('/catalog', ...guard, async (req: Request, res: Response) => {
    try { res.json(await aggregateCatalog(pool, req.query.refresh === '1')); }
    catch (err) { fail(res, err, 'GET /catalog'); }
  });

  /** The blast-radius screen. Reads the package's manifest at the pinned ref; installs nothing. */
  router.get('/:slug/preview/:name', ...guard, async (req: Request, res: Response) => {
    try {
      const { registry, entry } = await locate(pool, String(req.params.slug), String(req.params.name));
      const manifest = await readRemoteManifest(pool, registry, entry);
      res.json({
        name: entry.name, displayName: entry.displayName, version: entry.version,
        registry: registry.slug, registryLabel: registry.displayName,
        source: entry.source, allowUnsigned: registry.allowUnsigned,
        install: decideInstallAudit(entry.auditState, registry, resolvePackageAuditMode()),
        impact: describeManifestImpact(manifest, entry),
      });
    } catch (err) { fail(res, err, 'GET /preview'); }
  });

  router.post('/install', ...guard, async (req: Request, res: Response) => {
    const caller = getCaller(req);
    const slug = String(req.body?.registry ?? '');
    const name = String(req.body?.name ?? '');
    try {
      const { registry, entry } = await locate(pool, slug, name);
      logger.warn({ name, registry: slug, by: caller.sub }, 'INSTALLING PACKAGE FROM REGISTRY');
      const result = await runInstall(pool, registry, entry, caller.sub ?? null, deps.loadApp);
      if (!result.ok) { res.status(result.status).json({ error: result.error, log: result.log }); return; }
      res.status(201).json({ installed: true, name: entry.name, registry: slug, log: result.log });
    } catch (err) { fail(res, err, 'POST /install'); }
  });

  return router;
}

/**
 * @description Fetches a package's oshal-app.yaml at the catalog-pinned ref so the preview can
 * describe it. Uses the same sparse-clone the installer does, but checks out ONLY the manifest —
 * nothing is written to deployed-apps and no code is executed.
 * @param pool - Postgres pool.
 * @param registry - the source registry.
 * @param entry - the catalog entry.
 * @returns The parsed manifest, or an empty object when it cannot be read.
 */
async function readRemoteManifest(
  pool: Pool, registry: AppRegistry, entry: AggregatedApp,
): Promise<Record<string, unknown>> {
  const source = await toRegistrySource(pool, registry);
  const auth = buildRegistryGitAuth(source);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-preview-'));
  const repo = entry.source?.url ?? registry.url;
  const ref = entry.source?.ref ?? registry.ref;
  try {
    await runGit(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '-b', ref, repo, tmp], auth);
    await runGit(['-C', tmp, 'sparse-checkout', 'set', '--no-cone', `${entry.name}/oshal-app.yaml`], auth);
    const file = path.join(tmp, entry.name, 'oshal-app.yaml');
    if (!fs.existsSync(file)) return {};
    return (yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {};
  } catch (err) {
    logger.warn({ err, name: entry.name }, 'preview manifest read failed');
    return {};
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs one git command with a registry's auth env. */
function runGit(args: string[], auth: { argsPrefix: string[]; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...auth.argsPrefix, ...args], { env: auth.env, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout).trim());
      });
  });
}
