/**
 * Update-check cron — the swarm's "is anything newer?" daemon (apps + core).
 *
 * Two checks, both read-only and network-light, on one daily timer:
 *  - APPS: every installed store package (deployed-apps/<name>/oshal-app.yaml) is compared
 *    against its own `source:` provenance block — the manifest at source.url/source.ref on
 *    raw.githubusercontent.com. `version:` is the drift contract (same rule as
 *    scripts/app-store-drift-check.sh): the store bumps it on every publish.
 *  - CORE: the running image's commit (GIT_SHA baked at build by oshal-deploy.sh) is compared
 *    against the tip of the upstream repo's main branch via the GitHub API.
 *
 * DETECTION ONLY — nothing is auto-applied. Applying an app update stays the operator recipe
 * (oshal-app.js install / the drift-check re-stage), and core updates ship via oshal-deploy.sh.
 * Results surface on GET /api/updates (auth-gated) and as a badge on /applications/.
 * On by default; set UPDATE_CHECK_ENABLED=0 to disable. Private-repo sources that 404
 * anonymously report status 'unknown', never an error loop.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial update-check daemon: daily app-vs-store + core-vs-upstream version checks, GET /api/version (first runtime self-identity) + auth-gated GET /api/updates.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Completion: operator-gated POST /api/updates/apps/:name/apply (re-install from the package's own source: via scripts/oshal-app.js, then hot-reload through the injected SwarmAppService.loadApp) + notifyOperator alert when a check first finds an update (detectNewUpdates transition diff — no re-alert on every daily tick).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Private-store support (opt-in): OSHAL_STORE_TOKEN (fallback GITHUB_TOKEN) authorizes the raw/API fetches and rides to the installer as env for apply — live check found ALL 42 installed packages source from the private oshal-applications repo, so anonymous checks reported every app "unknown". Token is env-only: never in argv, scrubbed from captured installer output.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: isolate the operator-triggered update installer from controller/database/session/provider credentials; admit only OS/runtime, proxy/TLS settings, non-interactive Git controls, and the exact resolved store token.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: pass the validated package-audit posture to update installers so enforce mode re-installs only an exact evidenced SHA.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import yaml from 'js-yaml';
import type { Express, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import { notifyOperator } from '@/features/notifications';
import { resolvePackageAuditMode } from '@/features/swarm-apps';

const logger = createChildLogger({ module: 'update-check-cron' });

const WORKSPACE_ROOT = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
const DEPLOYED_APPS_DIR = path.join(WORKSPACE_ROOT, 'deployed-apps');
const CORE_REPO = process.env.UPDATE_CHECK_CORE_REPO || 'emeraldcoastsystemsgroup/oshal';
const CORE_BRANCH = process.env.UPDATE_CHECK_CORE_BRANCH || 'main';
const FETCH_TIMEOUT_MS = 10_000;
const UPDATE_INSTALL_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
] as const;

/**
 * Build the app-update installer's least-privilege environment.
 *
 * The install command is catalog/manifest-pinned and needs only Node/Git runtime settings plus
 * network trust. It must not inherit controller, database, session, connector, model-provider,
 * or ambient Git credential-helper authority. The resolved private-store token is explicit and
 * omitted entirely for an anonymous public-store install.
 */
export function buildUpdateInstallerProcessEnv(
  storeToken: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of UPDATE_INSTALL_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  if (storeToken) env.OSHAL_STORE_TOKEN = storeToken;
  return env;
}

/**
 * @description Produce a bounded, secret-scrubbed installer log while retaining the APP-02
 * NOT AUDIT-VERIFIED warning even when later validation output exceeds the normal tail.
 * @param output - Combined installer stdout/stderr.
 * @param storeToken - Exact store token to redact if a child unexpectedly echoed it.
 * @returns At most sixteen lines safe for API responses and structured logs.
 */
export function installerLogTail(output: string, storeToken: string): string {
  const lines = scrubSecret(output.replace(/\u001b\[[0-9;]*m/g, ''), storeToken).split('\r').join('').split('\n');
  const tail = lines.slice(-15);
  const warning = lines.find((line) => line.includes('NOT AUDIT-VERIFIED'));
  if (warning && !tail.includes(warning)) tail.unshift(warning);
  return tail.join('\n');
}

/** One installed store package's check result. */
export interface AppUpdateStatus {
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** true = newer in store; false = current; null = could not determine (no source / fetch failed). */
  updateAvailable: boolean | null;
  sourceUrl: string | null;
  error?: string;
}

/** The core platform's check result. */
export interface CoreUpdateStatus {
  runningVersion: string | null;
  runningCommit: string | null;
  latestCommit: string | null;
  latestCommitDate: string | null;
  /** true = upstream main is ahead; false = current; null = running commit unknown / fetch failed. */
  updateAvailable: boolean | null;
  repo: string;
  error?: string;
}

/** The full report GET /api/updates serves. */
export interface UpdateCheckReport {
  checkedAt: string | null;
  core: CoreUpdateStatus | null;
  apps: AppUpdateStatus[];
}

let started = false;
let inFlight: Promise<UpdateCheckReport> | null = null;
let lastReport: UpdateCheckReport = { checkedAt: null, core: null, apps: [] };

/**
 * Compare two version strings, semver-ish, without a dependency.
 *
 * @description Splits each version into a dotted numeric core and an optional pre-release tail
 *  (after the first `-`). Numeric segments compare numerically, missing segments count as 0,
 *  non-numeric segments fall back to lexical compare, and a release outranks its own pre-release
 *  (1.2.0 > 1.2.0-beta.1). This mirrors how the store bumps `version:` — it is a drift signal,
 *  not a full semver implementation (no build metadata).
 * @param a first version (leading `v` tolerated)
 * @param b second version
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: string[]; pre: string | null } => {
    const s = String(v).trim().replace(/^v/i, '');
    const dash = s.indexOf('-');
    const core = (dash === -1 ? s : s.slice(0, dash)).split('.');
    return { core, pre: dash === -1 ? null : s.slice(dash + 1) };
  };
  const pa = parse(a); const pb = parse(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const sa = pa.core[i] ?? '0'; const sb = pb.core[i] ?? '0';
    const na = Number(sa); const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa.localeCompare(sb);
    }
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;   // release > pre-release
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/**
 * Build the raw.githubusercontent.com URL for a package manifest from its `source:` block.
 *
 * @description Only GitHub `git-subdir` sources are resolvable (the only shape the installer
 *  writes today). Tolerates a trailing `.git` and a trailing slash on the repo URL.
 * @param source the manifest's ADR-085 provenance block
 * @returns the raw manifest URL, or null when the source is absent or not GitHub-shaped
 */
export function rawManifestUrl(source: { url?: string; path?: string; ref?: string } | undefined): string | null {
  if (!source?.url || !source.path) return null;
  const m = String(source.url).trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const ref = source.ref || 'main';
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${encodeURIComponent(ref)}/${source.path.replace(/^\/+|\/+$/g, '')}/oshal-app.yaml`;
}

/**
 * Read one deployed package's manifest fields needed for the check.
 *
 * @description Parses `<dir>/oshal-app.yaml` for name/version/source. Returns null when the
 *  manifest is missing or unparseable — the caller reports it as unknown, never throws.
 * @param dir the package directory (deployed-apps/<name>)
 * @returns the parsed fields, or null
 */
export function readLocalManifest(dir: string): { name: string; version: string | null; source?: { url?: string; path?: string; ref?: string } } | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'oshal-app.yaml'), 'utf8');
    const doc = yaml.load(raw) as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object' || typeof doc.name !== 'string') return null;
    return {
      name: doc.name,
      version: typeof doc.version === 'string' || typeof doc.version === 'number' ? String(doc.version) : null,
      source: (doc.source && typeof doc.source === 'object') ? doc.source as { url?: string; path?: string; ref?: string } : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the `version:` value from raw manifest YAML text.
 *
 * @description Full yaml.load on remote content, with a top-of-file regex fallback so a store
 *  manifest with one bad block elsewhere still yields its version.
 * @param text the fetched oshal-app.yaml body
 * @returns the version string, or null
 */
export function parseRemoteVersion(text: string): string | null {
  try {
    const doc = yaml.load(text) as Record<string, unknown> | null;
    const v = doc && typeof doc === 'object' ? doc.version : undefined;
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  } catch { /* fall through to the regex */ }
  const m = text.match(/^version:\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : null;
}

/**
 * The opt-in store/GitHub token for private-source checks and applies.
 *
 * @description OSHAL_STORE_TOKEN first (the canonical name — the installer honors the same env),
 *  GITHUB_TOKEN as a fallback, empty string when neither is set (anonymous mode). NEVER log or
 *  echo the returned value.
 * @returns the token, or '' for anonymous
 */
export function resolveStoreToken(): string {
  return (process.env.OSHAL_STORE_TOKEN || process.env.GITHUB_TOKEN || '').trim();
}

/**
 * Remove every occurrence of a secret from text before it is logged or returned.
 *
 * @param text the text to scrub
 * @param secret the secret to remove (no-op when empty)
 * @returns the scrubbed text
 */
export function scrubSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

/** GET with a hard timeout and the User-Agent GitHub requires; null body on any failure. */
async function fetchText(url: string, accept: string): Promise<{ status: number; body: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const token = resolveStoreToken();
    const headers: Record<string, string> = { 'User-Agent': 'oshal-update-check', Accept: accept };
    if (token) headers.Authorization = `token ${token}`; // raw.githubusercontent + api.github.com both honor this scheme
    const res = await fetch(url, { signal: ac.signal, headers });
    return { status: res.status, body: res.ok ? await res.text() : null };
  } catch (err) {
    logger.warn({ err, url }, 'update-check fetch failed');
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** The running build's identity: package.json version + the GIT_SHA baked by oshal-deploy.sh. */
export function getRunningBuild(): { version: string | null; commit: string | null } {
  let version: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch (err) {
    logger.error({ err }, 'update-check: reading package.json failed');
  }
  const sha = (process.env.GIT_SHA || '').trim();
  return { version, commit: sha && sha !== 'unknown' ? sha : null };
}

/** Check every installed store package against its source manifest. */
async function checkAppUpdates(): Promise<AppUpdateStatus[]> {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(DEPLOYED_APPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => path.join(DEPLOYED_APPS_DIR, d.name));
  } catch {
    return []; // no deployed-apps dir on this node — nothing installed
  }
  const out: AppUpdateStatus[] = [];
  for (const dir of dirs) {
    const local = readLocalManifest(dir);
    if (!local) continue;
    const url = rawManifestUrl(local.source);
    const status: AppUpdateStatus = {
      name: local.name, installedVersion: local.version, latestVersion: null,
      updateAvailable: null, sourceUrl: url,
    };
    if (!url) {
      status.error = 'no resolvable source: block';
    } else {
      const res = await fetchText(url, 'text/plain');
      const remote = res.body ? parseRemoteVersion(res.body) : null;
      if (remote) {
        status.latestVersion = remote;
        status.updateAvailable = local.version ? compareVersions(remote, local.version) > 0 : null;
      } else {
        status.error = res.status === 404 || res.status === 403
          ? `source not anonymously readable (HTTP ${res.status})`
          : `manifest fetch failed (HTTP ${res.status})`;
      }
    }
    out.push(status);
  }
  return out;
}

/** Check the running core commit against the tip of the upstream branch. */
async function checkCoreUpdate(): Promise<CoreUpdateStatus> {
  const build = getRunningBuild();
  const status: CoreUpdateStatus = {
    runningVersion: build.version, runningCommit: build.commit,
    latestCommit: null, latestCommitDate: null, updateAvailable: null, repo: CORE_REPO,
  };
  const res = await fetchText(`https://api.github.com/repos/${CORE_REPO}/commits/${encodeURIComponent(CORE_BRANCH)}`, 'application/vnd.github+json');
  if (!res.body) {
    status.error = `upstream commit fetch failed (HTTP ${res.status})`;
    return status;
  }
  try {
    const doc = JSON.parse(res.body) as { sha?: string; commit?: { committer?: { date?: string } } };
    if (typeof doc.sha === 'string') {
      status.latestCommit = doc.sha;
      status.latestCommitDate = doc.commit?.committer?.date ?? null;
      status.updateAvailable = build.commit
        ? !(doc.sha.startsWith(build.commit) || build.commit.startsWith(doc.sha))
        : null; // running commit unknown (pre-GIT_SHA image) — can't compare
    }
  } catch (err) {
    logger.error({ err }, 'update-check: parsing upstream commit response failed');
    status.error = 'upstream response unparseable';
  }
  return status;
}

/**
 * Diff two reports for updates that are NEW in `next` — the alert transition.
 *
 * @description An update is "new" when it wasn't already being reported for the same target
 *  version/commit in `prev` — so the daily tick alerts once per released version, not every
 *  day the operator hasn't applied it yet.
 * @param prev the previous cached report
 * @param next the report just produced
 * @returns human-readable lines, one per newly-seen update (empty = nothing to announce)
 */
export function detectNewUpdates(prev: UpdateCheckReport, next: UpdateCheckReport): string[] {
  const lines: string[] = [];
  for (const app of next.apps) {
    if (app.updateAvailable !== true) continue;
    const before = prev.apps.find((p) => p.name === app.name);
    if (before?.updateAvailable === true && before.latestVersion === app.latestVersion) continue;
    lines.push(`app ${app.name}: v${app.installedVersion} -> v${app.latestVersion}`);
  }
  if (next.core?.updateAvailable === true) {
    const seen = prev.core?.updateAvailable === true && prev.core.latestCommit === next.core.latestCommit;
    if (!seen) {
      lines.push(`core: running ${next.core.runningCommit?.slice(0, 12)} -> upstream ${next.core.latestCommit?.slice(0, 12)} (deploy via scripts/oshal-deploy.sh)`);
    }
  }
  return lines;
}

/**
 * Run one full update check (apps + core) and cache the report.
 *
 * @description Concurrent callers share one in-flight run. Never rejects — per-item failures
 *  land in each item's `error` field so one dead source can't hide the rest. A check that
 *  FIRST sees an update (per detectNewUpdates) fires a fire-and-forget operator notification;
 *  notifyOperator is a clean no-op when no transport is configured.
 * @returns the fresh report (also served by GET /api/updates)
 */
export async function runUpdateCheck(): Promise<UpdateCheckReport> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const startedAt = Date.now();
    const prevReport = lastReport;
    const [core, apps] = await Promise.all([checkCoreUpdate(), checkAppUpdates()]);
    lastReport = { checkedAt: new Date().toISOString(), core, apps };
    const fresh = detectNewUpdates(prevReport, lastReport);
    if (fresh.length) {
      void notifyOperator({ text: `oshal update-check: updates available\n${fresh.join('\n')}` })
        .catch((err) => logger.error({ err }, 'update-check: operator notification failed'));
    }
    const appUpdates = apps.filter((a) => a.updateAvailable === true).map((a) => `${a.name} ${a.installedVersion}->${a.latestVersion}`);
    logger.info({
      durationMs: Date.now() - startedAt, appsChecked: apps.length, appUpdates,
      coreUpdateAvailable: core.updateAvailable, coreLatest: core.latestCommit?.slice(0, 12) ?? null,
    }, appUpdates.length || core.updateAvailable ? 'update-check: UPDATES AVAILABLE' : 'update-check: everything current');
    return lastReport;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** What the update routes need from the app layer to hot-reload a re-installed package. */
export interface UpdateApplyDeps {
  /** SwarmAppService.loadApp — re-registers the freshly installed manifest live. */
  loadApp: (manifestPath: string, scopeMeta?: { ownerSub?: string | null }) => Promise<unknown>;
}

type ApplyResult =
  | { ok: true; log: string }
  | { ok: false; status: number; error: string; log?: string };

/**
 * Apply one app update: re-install the package from its own store source, then hot-reload it.
 *
 * @description Runs the battle-tested installer (`scripts/oshal-app.js install`) with the repo/ref
 *  taken from the INSTALLED manifest's `source:` block — never from the caller — then re-loads the
 *  manifest through SwarmAppService so the new version registers live (bots, tools, routes,
 *  version row). Only names that are already-installed store packages with a resolvable GitHub
 *  source are updatable; a private store repo without anonymous read fails cleanly at the git
 *  step. Nothing here auto-runs — the operator clicks per update.
 * @param name the installed package name (slug-validated, must exist in deployed-apps/)
 * @param ownerSub the applying session's sub, stamped as owner on reload (the little-monsters
 *  RLS lesson: a person-scoped package reloaded with a NULL owner vanishes for non-operators)
 * @param deps the injected loadApp
 * @returns ok + installer log tail, or a status-shaped error for the route to surface
 */
export async function applyAppUpdate(name: string, ownerSub: string | null, deps: UpdateApplyDeps): Promise<ApplyResult> {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) return { ok: false, status: 400, error: 'invalid package name' };
  const dir = path.join(DEPLOYED_APPS_DIR, name);
  const local = readLocalManifest(dir);
  if (!local) return { ok: false, status: 404, error: `"${name}" is not an installed store package` };
  if (!rawManifestUrl(local.source)) {
    return { ok: false, status: 409, error: `"${name}" has no resolvable source: block — update it manually` };
  }
  const repo = String(local.source!.url);
  const ref = local.source!.ref || 'main';
  logger.info({ name, repo, ref }, 'applying app update');
  const token = resolveStoreToken();
  const auditMode = resolvePackageAuditMode();
  const run = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'oshal-app.js'), 'install', name, '--repo', repo, '--ref', ref, '--dest', DEPLOYED_APPS_DIR],
      {
        cwd: process.cwd(),
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...buildUpdateInstallerProcessEnv(token),
          OSHAL_PACKAGE_AUDIT_MODE: auditMode,
        },
      },
      (err, stdout, stderr) => {
        const raw = err ? (err as NodeJS.ErrnoException).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : (err ? 1 : 0), output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
  // Strip ANSI color + any token echo from the installer's CLI output before it travels as an
  // API payload or a log field.
  const log = installerLogTail(run.output, token);
  if (run.code !== 0) {
    logger.error({ name, code: run.code, log }, 'app update install failed');
    return { ok: false, status: 502, error: `install failed — see log`, log };
  }
  try {
    await deps.loadApp(path.join(dir, 'oshal-app.yaml'), { ownerSub });
  } catch (err) {
    logger.error({ err, name }, 'app update installed but hot-reload failed');
    return { ok: false, status: 500, error: 'installed on disk but hot-reload failed — reload it from the admin bar', log };
  }
  await runUpdateCheck(); // refresh the report so the badge clears immediately
  logger.info({ name }, 'app update applied + hot-reloaded');
  return { ok: true, log };
}

/**
 * Mount GET /api/version (public) and GET /api/updates (auth-gated).
 *
 * @description /api/version is the platform's first runtime self-identity — package.json version
 *  + the build commit — public like /api/health (the source repo is public; this leaks nothing).
 *  /api/updates serves the cached report; `?refresh=1` awaits a fresh check (auth-gated, so no
 *  anonymous fetch-amplification against GitHub). When `deps` is provided, also mounts
 *  POST /api/updates/apps/:name/apply — requiresAuth + requiresOperator (it rewrites the shared
 *  deployed-apps volume and re-registers bots/tools/routes — an operator action, like /load).
 * @param app the Express app
 * @param requiresAuth the OIDC gate middleware (routes are anonymous by default — see oidc.ts)
 * @param deps optional apply wiring (loadApp); absent = detection-only surface
 */
export function registerUpdateRoutes(app: Express, requiresAuth: RequestHandler, deps?: UpdateApplyDeps): void {
  app.get('/api/version', (_req, res) => {
    const build = getRunningBuild();
    res.json({ name: 'oshal', version: build.version, commit: build.commit });
  });
  app.get('/api/updates', requiresAuth, async (req, res) => {
    try {
      const report = req.query.refresh === '1' ? await runUpdateCheck() : lastReport;
      res.json({ success: true, ...report });
    } catch (err) {
      logger.error({ err }, 'GET /api/updates failed');
      res.status(500).json({ success: false, error: 'update check failed' });
    }
  });
  if (deps) {
    app.post('/api/updates/apps/:name/apply', requiresAuth, requiresOperator, async (req, res) => {
      const name = String(req.params.name || '');
      logger.info({ name }, 'POST /api/updates/apps/:name/apply');
      try {
        const result = await applyAppUpdate(name, getCaller(req).sub ?? null, deps);
        if (!result.ok) {
          res.status(result.status).json({ success: false, error: result.error, log: result.log });
          return;
        }
        res.json({ success: true, log: result.log });
      } catch (err) {
        logger.error({ err, name }, 'apply app update failed');
        res.status(500).json({ success: false, error: 'apply failed' });
      }
    });
  }
}

/**
 * Start the update-check timer once (boot check after a short delay, then daily).
 *
 * @description On by default — set UPDATE_CHECK_ENABLED=0/false to disable (air-gapped or
 *  no-phone-home deployments). UPDATE_CHECK_INTERVAL_HOURS overrides the cadence (min 1h,
 *  default 24h — two anonymous GitHub requests per run, far under the 60/hr anonymous limit).
 *  Timers are unref'd and the double-start guard follows the 2026-07-05 leak-audit convention.
 */
export function startUpdateCheckCron(): void {
  if (started) return;
  started = true;
  if (['0', 'false', 'no'].includes((process.env.UPDATE_CHECK_ENABLED || '').toLowerCase())) {
    logger.info('update-check cron disabled (UPDATE_CHECK_ENABLED=0)');
    return;
  }
  const hours = Math.max(1, Number.parseFloat(process.env.UPDATE_CHECK_INTERVAL_HOURS || '24') || 24);
  logger.info({ intervalHours: hours, coreRepo: CORE_REPO }, 'update-check cron enabled');
  const boot = setTimeout(() => {
    void runUpdateCheck().catch((err) => logger.error({ err }, 'boot update check failed'));
  }, 3 * 60 * 1000);
  boot.unref();
  const timer = setInterval(() => {
    void runUpdateCheck().catch((err) => logger.error({ err }, 'scheduled update check failed'));
  }, hours * 60 * 60 * 1000);
  timer.unref();
}
