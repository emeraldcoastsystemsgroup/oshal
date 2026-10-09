/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard for the trading watchdog's own identity (scripts/trading-watchdog.ps1 change log 5). On the Spark every per-book read was refused with 401 authorization_identity_required: the service secret plus a sub header carries no verified issuer. The HTTP half runs the SHIPPED container-side fetcher against the real legacy auth chain behind a real listener - the real /api/cli-tokens mint route, the real Bearer middleware, the real application-authorization actor resolver and runtime in enforce mode, and a fixture package mounted where intelligent-trades mounts /api/trading (service-or-oidc, requiresAuth, requiresContext, no catalog): a session-minted token is admitted and the books are audited, while the service-secret read and a bootstrap-minted token get exactly the production 401. The PowerShell half runs the shipped sections under real pwsh: the token reaches the audit exec only through its environment (never argv), an unusable token file is raised without its contents, an authorization_* refusal is reported as the watchdog's own access problem instead of a Schwab re-login, and the script has no `exit` left (PowerShell 7 journals every one as "System error.") while its market-hours gate still ends the run with exit code 0.
 */
import express, { type RequestHandler } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import type { AppContext } from '@/app/composition/app-context';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createCliTokenAuthMiddleware, createCliTokenRoutes } from '@/app/routes/cli-token-routes';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { serviceSecretOr, trustedServiceUserHeaders } from '@/shared/middleware/authz';
import { modulePath, powershell, watchdogPath, watchdogSource } from '../helpers/trading-watchdog-checks-harness';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const APP = 'intelligent-trades';
const SECRET = 'example-watchdog-fixture-service-secret';
const ISSUER = 'https://identity.watchdog-fixture.test';
/** The live-book owner: the sub the watchdog audits and the one its token must belong to. */
const OWNER = 'auth0|watchdog-book-owner';
const admin: AuthorizationActor = { sub: 'fixture-administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const scratch = mkdtempSync(join(tmpdir(), 'oshal-watchdog-identity-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The package half: the three caller-scoped reads block G makes, recording that package code ran. */
const TRADING_MODULE = `exports.createTradingRoutes = function (ctx) {
  return function (req, res) {
    ctx.fixtureReads.push(req.originalUrl);
    if (req.path === '/account') return res.json({ book: 'live', account: { cash: 1000, buyingPower: 2000, equity: 100000 } });
    if (req.path === '/positions') return res.json({ book: 'live', positions: [{ symbol: 'AAPL', qty: 10, avgEntryPrice: 100, marketValue: 700, unrealizedPl: -300 }] });
    if (req.path === '/orders') return res.json({ book: 'live', orders: [] });
    res.status(404).json({ error: 'fixture_not_found' });
  };
};`;

/** intelligent-trades/oshal-app.yaml's /api/trading declaration (store export), with no catalog. */
function manifest(): SwarmAppManifest {
  return { name: APP, displayName: 'Trading fixture', version: '1.0.0', status: 'active', suite: 'ai-finance',
    routes: [{ module: 'routes/trading-routes.js', factory: 'createTradingRoutes', mountPath: '/api/trading',
      auth: 'service-or-oidc', requiresAuth: true, requiresContext: true }] } as SwarmAppManifest;
}

/** Scripted stand-in for the token table, routed on the same SQL substrings as cli-token-auth.spec.ts. */
function tokenPool(): Pool {
  const rows: Array<Record<string, unknown>> = [];
  return { async query(sql: string, params: unknown[] = []) {
    if (sql.includes('INSERT INTO oshal_cli_tokens')) {
      rows.push({ id: params[0], user_sub: params[1], email: params[2] ?? null, token_hash: params[4], revoked_at: null,
        node_client_id: params[6] ?? null, principal_issuer: params[7] ?? null, location_device_id: params[8] ?? null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('WHERE token_hash')) {
      const hit = rows.find((row) => row.token_hash === params[0] && row.revoked_at === null);
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  } } as unknown as Pool;
}

describe('block G reads the books as the dedicated watchdog principal (the real legacy auth chain)', () => {
  let server: Server; let base = ''; const reads: string[] = []; const seen: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SECRET);
    vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', OWNER);
    const root = join(scratch, 'package'); mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(join(root, 'routes', 'trading-routes.js'), TRADING_MODULE);
    const manifestPath = join(root, 'oshal-app.yaml'); writeFileSync(manifestPath, yaml.dump(manifest()));
    const record = { appId: APP, name: APP, displayName: 'Trading fixture', description: '', version: '1.0.0', status: 'active',
      manifestPath, manifest: manifest(), agentIds: [], toolNames: [], scope: 'public', ownerSub: null, tenantId: null,
      guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() } as SwarmApplicationRecord;
    const store = new MemoryAuthorizationStore();
    const policy = new ApplicationAuthorizationService(store, { resolveTier: async () => ({ tier: 'admin', explicit: false }) });
    // The REAL resolver the controller composes, over a pool that refuses every query: nothing here may need one.
    const denyPool = { query: async () => { throw new Error('the fixture database must not be consulted'); } } as unknown as Pool;
    const runtime = new ApplicationAuthorizationRuntime(policy, createApplicationAuthorizationActorResolver(denyPool, { tenantIds: async () => [] }),
      { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' });
    await runtime.start(record); runtime.complete(record);
    const preview = await policy.previewChange(admin, { action: 'grant', app: APP, targetSub: OWNER, targetIssuer: ISSUER,
      role: '@app-admin', reason: 'Watchdog identity fixture', expectedRevision: (await store.read()).revision });
    await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
    const pool = tokenPool();
    const app = express();
    app.use(express.json());
    // A signed-in cockpit session stands in for the OIDC login; no cookie is exactly what the watchdog has.
    app.use((req, _res, next) => {
      const session = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (session) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: decodeURIComponent(session), iss: ISSUER } } });
      if (req.path.startsWith('/api/trading')) seen.push({ ...req.headers });
      next();
    });
    app.use(createCliTokenAuthMiddleware(pool));
    const requiresAuth: RequestHandler = (req, res, next) =>
      ((req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.() ? next() : res.status(401).json({ error: 'not_authenticated' }));
    app.use('/api/cli-tokens', serviceSecretOr(requiresAuth), createCliTokenRoutes(pool));
    await new ManifestRouteMounterImpl(app, requiresAuth, { pool: denyPool, fixtureReads: reads } as unknown as AppContext, undefined, runtime)
      .mount(APP, root, record.manifest.routes!);
    app.use((_req, res) => res.status(404).json({ error: 'fixture_not_found' }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server?.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); vi.unstubAllEnvs(); });

  /** Mint through the real route: a signed-in session, or the service-secret bootstrap. */
  async function mint(how: 'session' | 'bootstrap'): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json',
      ...(how === 'session' ? { cookie: `session=${encodeURIComponent(OWNER)}` } : trustedServiceUserHeaders(OWNER)) };
    const response = await fetch(`${base}/api/cli-tokens`, { method: 'POST', headers, body: JSON.stringify({ label: 'trading-watchdog' }) });
    expect(response.status).toBe(201);
    return (await response.json() as { token: string }).token;
  }

  /** The ps1's own $auditJs, pointed at this listener, run under real node as the container would. */
  async function audit(bearer?: string): Promise<{ errors: Array<{ ref: string; error: string }>; books: string[]; alerts: Array<{ key: string }> }> {
    const start = watchdogSource.indexOf('$auditJs = @\'') + '$auditJs = @\'\n'.length;
    const js = watchdogSource.slice(start, watchdogSource.indexOf('\'@', start))
      .replace('require("/tmp/oshal-wd-checks.js")', `require(${JSON.stringify(modulePath)})`)
      .replace('"/tmp/wd-audit-request.json"', JSON.stringify(join(scratch, 'req.json')))
      .replace('"/tmp/wd-audit-state.json"', JSON.stringify(join(scratch, 'state.json')))
      .replace('"http://127.0.0.1:5000/api/trading"', JSON.stringify(`${base}/api/trading`));
    const file = join(scratch, `fetcher-${Math.random().toString(36).slice(2)}.js`); writeFileSync(file, js);
    writeFileSync(join(scratch, 'req.json'), JSON.stringify({ sub: OWNER, rth: true, coreHolds: '', books: [{ ref: 'live', enabled: true }], settings: {}, auditBudgetSec: 20 }));
    writeFileSync(join(scratch, 'state.json'), '{}');
    const env: NodeJS.ProcessEnv = { ...process.env, SWARM_SERVICE_SECRET: SECRET };
    delete env.OSHAL_WD_BEARER; if (bearer) env.OSHAL_WD_BEARER = bearer;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [file], { env }); let text = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('fetcher timed out')); }, 40_000);
      child.stdout.on('data', (d) => { text += String(d); });
      child.on('close', () => { clearTimeout(timer); resolve(text); });
    });
    return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) as string);
  }

  it('admits a session-minted token: the books are read and audited, and only the bearer is sent', async () => {
    reads.length = 0; seen.length = 0;
    const out = await audit(await mint('session'));
    expect(out.errors).toEqual([]);
    expect(out.books).toEqual(['live']);
    expect(out.alerts.map((a) => a.key).sort()).toEqual(['bleed-live-AAPL', 'deep-loss-live-AAPL']);
    expect(reads).toEqual(['/api/trading/account?book=live', '/api/trading/positions?book=live', '/api/trading/orders?book=live']);
    for (const headers of seen) {
      expect(String(headers.authorization)).toMatch(/^Bearer oshal_pat_/);
      expect(headers['x-service-secret']).toBeUndefined();
      expect(headers['x-oshal-user-sub-b64']).toBeUndefined();
    }
  }, 60_000);

  it('still refuses the service-secret read with the production 401, before any package code runs', async () => {
    reads.length = 0;
    const out = await audit();
    expect(out.books).toEqual([]);
    expect(out.errors).toEqual([{ ref: 'live', error: '/account read failed (fail-closed): HTTP 401 authorization_identity_required' }]);
    expect(reads).toEqual([]);
  }, 60_000);

  it('refuses a token minted through the service-secret bootstrap, which records no issuer', async () => {
    reads.length = 0;
    const out = await audit(await mint('bootstrap'));
    expect(out.errors).toEqual([{ ref: 'live', error: '/account read failed (fail-closed): HTTP 401 authorization_identity_required' }]);
    expect(reads).toEqual([]);
  }, 60_000);
});

describe('the watchdog\'s PowerShell plumbing (real pwsh, real files)', () => {
  const TOKEN = `oshal_pat_${'ab'.repeat(24)}`;
  const section = (start: string, end: string): string => {
    const a = watchdogSource.indexOf(start); const b = watchdogSource.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error(`watchdog source markers missing: ${start} -> ${end}`);
    return watchdogSource.slice(a, b);
  };
  /** A recording `docker`: one JSON line per call with its argv and the bearer in ITS environment. */
  const fakeDocker = join(scratch, 'fake-docker.js');
  writeFileSync(fakeDocker, [
    'const fs = require("fs"); const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.WD_FAKE_DOCKER_RECORD, JSON.stringify({ args, bearer: process.env.OSHAL_WD_BEARER ?? null }) + "\\n");',
    'if (args[0] === "exec") process.stdout.write(JSON.stringify({ alerts: [], suppressed: [], recovered: [], state: null, warnings: [], errors: [], books: ["live"] }));',
  ].join('\n'));

  /** Run the shipped settings/exec, symbol-state and book-audit sections, then `body`, under real pwsh. */
  function probe(body: string[], env: Record<string, string>): { status: number | null; out: string; calls: Array<{ args: string[]; bearer: string | null }> } {
    const record = join(scratch, `calls-${Math.random().toString(36).slice(2)}.jsonl`); writeFileSync(record, '');
    const file = join(scratch, `probe-${Math.random().toString(36).slice(2)}.ps1`);
    writeFileSync(file, [
      '$ErrorActionPreference = "Continue"',
      'function Log($m) { Write-Host ("LOG " + $m) }',
      'function Raise($cond, $msg) { Write-Host ("RAISE " + $cond + " :: " + $msg) }',
      '$alerts = New-Object System.Collections.ArrayList',
      '$ApiContainer = "oshal-local-api"; $LiveSub = "spec-sub"; $LiveAlertPct = 5; $script:WdEnv = @{}',
      section('# ---- wd: settings + exec ----', '# ---- wd: end settings + exec ----'),
      section('# ---- wd: symbol state ----', '# ---- wd: end symbol state ----'),
      section('# ---- wd: book audit ----', '# ---- wd: end book audit ----'),
      `$script:WdDockerExe = ${JSON.stringify(process.execPath)}`,
      `$script:WdDockerArgPrefix = @(${JSON.stringify(fakeDocker)})`,
      ...body,
    ].join('\n'));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, TEMP: scratch, WD_FAKE_DOCKER_RECORD: record, ...env };
    if (!('OSHAL_WATCHDOG_TOKEN_FILE' in env)) delete childEnv.OSHAL_WATCHDOG_TOKEN_FILE;
    delete childEnv.OSHAL_WD_BEARER;
    const r = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 90_000, env: childEnv });
    if (r.error) throw new Error(`PowerShell (${powershell}) is required for this guard and did not run: ${r.error.message}`);
    const calls = readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
  }
  const auditOnce = ['$r = Invoke-WdBookAudit @(@{ Ref = "live"; Enabled = $true }) $true "" "{}"',
    'Write-Host ("RESULT books=" + (@($r.books) -join ","))',
    'Write-Host ("AFTER bearer=" + $(if ($env:OSHAL_WD_BEARER) { "present" } else { "absent" }))'];

  it('hands the token to the audit exec through its environment only - never argv - and clears it after', () => {
    const tokenFile = join(scratch, 'watchdog.token'); writeFileSync(tokenFile, `${TOKEN}\n`);
    const run = probe(auditOnce, { OSHAL_WATCHDOG_TOKEN_FILE: tokenFile });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('RESULT books=live');
    expect(run.out).toContain('AFTER bearer=absent');
    expect(run.out).not.toContain('RAISE');
    const exec = run.calls.filter((c) => c.args[0] === 'exec');
    expect(exec).toEqual([{ args: ['exec', '-e', 'OSHAL_WD_BEARER', 'oshal-local-api', 'node', '/tmp/wd-audit.js'], bearer: TOKEN }]);
    for (const call of run.calls) expect(call.args.join(' ')).not.toContain(TOKEN);
    expect(run.calls.filter((c) => c.args[0] === 'cp').every((c) => c.bearer === null), 'only the audit exec carries it').toBe(true);
    expect(run.out).not.toContain(TOKEN);
  }, 60_000);

  it('keeps the previous exec exactly when no token file is configured', () => {
    const run = probe(auditOnce, {});
    expect(run.status, run.out).toBe(0);
    expect(run.calls.filter((c) => c.args[0] === 'exec')).toEqual([{ args: ['exec', 'oshal-local-api', 'node', '/tmp/wd-audit.js'], bearer: null }]);
    expect(run.out).not.toContain('RAISE');
  }, 60_000);

  it('raises an unusable token file without echoing what is in it, and falls back to the previous exec', () => {
    for (const [name, content] of [['missing.token', null], ['two.token', `${TOKEN}\n${TOKEN}\n`], ['junk.token', 'not-a-token-SENTINEL-VALUE\n']] as const) {
      const tokenFile = join(scratch, name); if (content !== null) writeFileSync(tokenFile, content);
      const run = probe(auditOnce, { OSHAL_WATCHDOG_TOKEN_FILE: tokenFile });
      expect(run.status, run.out).toBe(0);
      expect(run.out, name).toContain('RAISE watchdog-token-unreadable :: OSHAL_WATCHDOG_TOKEN_FILE is set');
      expect(run.out, name).not.toContain('SENTINEL-VALUE');
      expect(run.out, name).not.toContain(TOKEN);
      expect(run.calls.filter((c) => c.args[0] === 'exec').map((c) => c.args), name).toEqual([['exec', 'oshal-local-api', 'node', '/tmp/wd-audit.js']]);
    }
  }, 120_000);

  it('reports an authorization_* refusal as the watchdog\'s own access problem, never as a Schwab re-login', () => {
    const errors = [
      { ref: 'live', error: '/account read failed (fail-closed): HTTP 401 authorization_identity_required' },
      { ref: 'b-1', error: '/account read failed (fail-closed): HTTP 503 broker_not_configured' },
      { ref: 'b-2', error: '/positions read failed (fail-closed): HTTP 403 authorization_tier_denied' },
      { ref: 'b-3', error: '/orders read failed (fail-closed): HTTP 500 upstream exploded' },
    ];
    const json = JSON.stringify({ errors, alerts: [], suppressed: [], recovered: [], warnings: [], state: null });
    const run = probe([`$r = ConvertFrom-Json '${json}'`, `Send-WdAuditAlerts $r ${JSON.stringify(join(scratch, 'sym.json'))}`], {});
    expect(run.status, run.out).toBe(0);
    const raised = run.out.split('\n').filter((line) => line.startsWith('RAISE '));
    const identity = raised.find((line) => line.includes('watchdog-access-authorization_identity_required-')) ?? '';
    expect(identity).toContain("Book 'live' is UNREADABLE because the oshal api refused the WATCHDOG'S OWN read");
    expect(identity).toContain('a Schwab re-login will not fix it');
    expect(identity).toContain('OSHAL_WATCHDOG_TOKEN_FILE');
    expect(identity).not.toMatch(/re-login \(the|Reconnect from the trading surface/);
    expect(raised.find((line) => line.includes('watchdog-access-authorization_tier_denied-'))).toContain('access to the trading application');
    expect(raised.find((line) => line.startsWith('RAISE live-relogin-'))).toContain("Book 'b-1' is UNREADABLE - the broker looks disconnected/expired");
    expect(raised.find((line) => line.startsWith('RAISE audit-error-b-3'))).toBeTruthy();
    expect(raised).toHaveLength(4);
    // The key is per code and per day, like the re-login key, so the 60-minute suppressor paces it.
    expect(identity).toMatch(/^RAISE watchdog-access-authorization_identity_required-\d{4}-\d{2}-\d{2} :: /);
  }, 60_000);

  it('has no `exit` statement left, and its market-hours gate still ends the run with exit code 0', () => {
    const count = spawnSync(powershell, ['-NoProfile', '-Command',
      `$e=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(watchdogPath).replace(/"/g, "'")}, [ref]$null, [ref]$e); "errors=" + $e.Count + " exits=" + $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExitStatementAst] }, $true).Count`],
    { encoding: 'utf8', timeout: 60_000 });
    expect(count.stdout.trim(), count.stderr).toBe('errors=0 exits=0');
    const gate = watchdogSource.slice(watchdogSource.indexOf('# Market-hours gate'), watchdogSource.indexOf('{ return }') + '{ return }'.length);
    for (const [when, passes] of [['2026-10-10T16:00:00', false], ['2026-10-07T16:00:00', true]] as const) {
      const file = join(scratch, `gate-${passes}.ps1`);
      writeFileSync(file, ['[CmdletBinding()]', 'param()',
        `function Get-Date { [datetime]::SpecifyKind([datetime]'${when}', 'Utc') }`, gate, 'Write-Host "PAST THE GATE"'].join('\n'));
      const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', timeout: 60_000 });
      expect(r.status, `${when}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout.includes('PAST THE GATE'), when).toBe(passes);
    }
  }, 60_000);
});
