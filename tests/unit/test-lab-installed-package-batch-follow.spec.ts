/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the batch-history follow on the real server with the real Create package: a local admin session, disposable pgvector Postgres, Docker runners, real Chromium, no refresh click.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Give the hooks that own the isolated fixture browser the fixture's exit budget, so a confirmed but slow shutdown on a loaded box is failed by neither deadline.
 */
// The live api admits only a signed-in session to the Test Lab data routes, so the native
// observation cannot be scripted against it. This spec is the local-host equivalent: the REAL
// server (src/app/server.ts) in LOCAL_AUTH mode (ADR-117) with a seeded first administrator and a
// real cookie session, a DISPOSABLE pgvector Postgres migrated by the server's own migration
// service, the REAL Create package exported from the store checkout, its five Node suites in the
// same disposable Docker runners the live Lab uses, and the real page in real Chromium. The mock
// identity cannot be used here: under MOCK_OIDC no login provider is configured, so the server-owned
// batch cannot re-derive its operator and cancels itself. Nothing here touches the live api,
// database, Redis or Chroma: every address the server would dial is pinned to a closed port.
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { type APIRequestContext,type Browser,type BrowserContext,type Page } from 'playwright';
import { execFileSync,spawn,type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join,relative,resolve } from 'node:path';
import { Pool } from 'pg';
import { bootstrapFirstAdmin,ensureLocalUserSchema,localSubForEmail } from '@/features/local-auth';
import { DatabaseBootstrapService } from '@/features/tool-registry/services/database-bootstrap-service';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.setConfig({ hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

/** OSHAL_STORE_REPO is what scripts/ci-local.sh exports to the unit gate; OSHAL_STORE_DIR is its kernel-skills sibling. */
const STORE = resolve(process.env.OSHAL_STORE_DIR ?? process.env.OSHAL_STORE_REPO ?? join(process.cwd(),'..','oshal-applications'));
const PACKAGE = 'create';
/** The sandbox resolves its runner image from the container named by HOSTNAME; the live api's own image is the honest choice. */
const RUNNER_CONTAINER = process.env.OSHAL_LAB_FOLLOW_RUNNER_CONTAINER ?? 'oshal-local-api';
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const REPORT_DIR = process.env.OSHAL_LAB_FOLLOW_REPORT_DIR;
/** Ignored by git; keeps the exported package inside the repo's module-resolution path. */
const FIXTURE_BASE = join(process.cwd(),'temp');
/** Fixture-only local administrator; the disposable database is the only place it ever exists. */
const ADMIN = { email: 'lab-follow-admin@example.com',password: `lab-follow-${randomUUID()}` };
const LOCAL_ISSUER = 'urn:oshal:local-auth';
const ADMIN_SUB = localSubForEmail(ADMIN.email);
const TARGET = { targetSub: ADMIN_SUB,targetIssuer: LOCAL_ISSUER };

function docker(args: string[]): string {
  return execFileSync('docker',args,{ encoding: 'utf8',stdio: ['ignore','pipe','pipe'] }).trim();
}
function freePort(): Promise<number> {
  return new Promise((done,fail) => {
    const probe = createServer(); probe.unref();
    probe.on('error',fail);
    probe.listen(0,'127.0.0.1',() => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
  });
}
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now()+timeoutMs; let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (ok(value)) return value; last = value; }
    catch (error) { last = error instanceof Error ? error.message : error; }
    await new Promise<void>(tick => setTimeout(tick,1000));
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms; last: ${JSON.stringify(last)?.slice(0,300)}`);
}

/** Export the package exactly as committed in the store checkout through git alone (no tar: GNU tar
 * on Windows reads a drive-letter path as a remote host); the working tree is never read. */
function exportPackage(packages: string): { dir: string; commit: string } {
  if (!existsSync(join(STORE,PACKAGE,'oshal-app.yaml'))) throw new Error(`Store checkout with ${PACKAGE}/ is required at ${STORE} (set OSHAL_STORE_DIR).`);
  const git = (args: string[]) => execFileSync('git',['-C',STORE,...args],{ maxBuffer: 64*1024*1024 });
  const commit = git(['rev-parse','HEAD']).toString('utf8').trim();
  mkdirSync(packages,{ recursive: true });
  const files = git(['ls-tree','-r','--name-only','-z','HEAD',PACKAGE]).toString('utf8').split('\0').filter(Boolean);
  for (const file of files) {
    if (file.split('/').includes('..')) throw new Error(`Refusing path ${file}`);
    const target = join(packages,...file.split('/')); mkdirSync(join(target,'..'),{ recursive: true });
    writeFileSync(target,git(['show',`HEAD:${file}`]));
  }
  if (!existsSync(join(packages,PACKAGE,'tests','test-lab.yaml'))) throw new Error('Exported package lacks tests/test-lab.yaml');
  return { dir: packages,commit };
}

class DisposablePostgres {
  readonly name = `oshal-lab-follow-pg-${randomUUID().slice(0,8)}`;
  private started = false;
  async start(): Promise<string> {
    const password = randomUUID();
    docker(['run','--detach','--rm','--name',this.name,'--label','oshal.test-fixture=lab-follow-postgres','--publish','127.0.0.1::5432',
      '--tmpfs','/var/lib/postgresql/data','--memory','512m','--cpus','1','--env',`POSTGRES_PASSWORD=${password}`,'--env','POSTGRES_DB=oshal',POSTGRES_IMAGE]);
    this.started = true;
    const port = /:(\d+)$/.exec(docker(['port',this.name,'5432/tcp']))?.[1];
    if (!port) throw new Error('Disposable Postgres must publish one loopback port');
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/oshal`;
    const pool = new Pool({ connectionString: url,max: 1,connectionTimeoutMillis: 500 });
    try { await until(() => pool.query('SELECT 1'),() => true,30000,'Disposable Postgres readiness'); } finally { await pool.end(); }
    return url;
  }
  /** The server's cold-boot migration pass races its own self-healing schema bootstraps (migration 005 rolled
   * back on a duplicate pg_type in two of eight runs), so apply the same migration service here, alone, first. */
  async migrate(url: string): Promise<string[]> {
    const pool = new Pool({ connectionString: url,max: 2 }); const previous = process.env.RUN_MIGRATIONS; process.env.RUN_MIGRATIONS = 'true';
    try { return await new DatabaseBootstrapService(pool).applyMigrations(); }
    finally { if (previous === undefined) delete process.env.RUN_MIGRATIONS; else process.env.RUN_MIGRATIONS = previous; await pool.end(); }
  }
  /** The installer's first-administrator row, seeded the way installer-root-bootstrap seeds it (the HTTP route needs a setup token). */
  async seedAdmin(url: string): Promise<void> {
    const pool = new Pool({ connectionString: url,max: 1 });
    try {
      await ensureLocalUserSchema(pool);
      const user = await bootstrapFirstAdmin(pool as never,ADMIN); if (user?.userSub !== ADMIN_SUB) throw new Error('First administrator was not seeded');
    } finally { await pool.end(); }
  }
  stop(): void { if (this.started) { docker(['rm','--force',this.name]); this.started = false; } }
}

let logDescriptor: number | undefined;
function startServer(env: NodeJS.ProcessEnv, logPath: string): ChildProcess {
  logDescriptor = openSync(logPath,'a');
  const child = spawn(process.execPath,[join('node_modules','ts-node','dist','bin.js'),'--project','tsconfig.json','-r','tsconfig-paths/register','src/app/server.ts'],
    { cwd: process.cwd(),env,stdio: ['ignore',logDescriptor,logDescriptor],windowsHide: true });
  return child;
}
function stopServer(child: ChildProcess | undefined): void {
  if (child?.pid && child.exitCode === null) {
    if (process.platform === 'win32') { try { execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{ stdio: 'ignore' }); } catch { /* already gone */ } }
    else child.kill('SIGTERM');
  }
  if (logDescriptor !== undefined) { closeSync(logDescriptor); logDescriptor = undefined; }
}

let root: string, postgres: DisposablePostgres, server: ChildProcess | undefined, base: string, exported: { dir: string; commit: string };
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>, browser: Browser, context: BrowserContext, page: Page, api: APIRequestContext;
const logTail = () => { try { return readFileSync(join(root,'server.log'),'utf8').slice(-4000); } catch { return ''; } };

/** Same-origin JSON call through the browser context, so the local session cookie travels with it. */
async function post(path: string, body: unknown, headers: Record<string,string> = {}): Promise<any> {
  const response = await api.post(base+path,{ data: body,headers: { origin: base,...headers } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`${path} ${response.status()}: ${JSON.stringify(json).slice(0,240)}`);
  return json;
}
async function loadPackage(): Promise<boolean> {
  return (await post('/api/swarm/apps/load',{ path: join(exported.dir,PACKAGE,'oshal-app.yaml') })).app?.status === 'active';
}
/** Under enforce mode even a swarm admin discovers a protected package only after a grant; this is the operator's /access step. */
async function grantOperatorAdmin(): Promise<boolean> {
  const access = (path: string, body: unknown) => post('/api/authorization/'+path,body,{ 'x-oshal-access-request': '1' });
  const current = await access('effective',{ app: PACKAGE,...TARGET });
  if (current.tier === 'admin') return true;
  const preview = await access('preview',{ app: PACKAGE,...TARGET,action: 'grant',role: 'admin',
    reason: 'Lab follow proof: operator self-provision on the exported package',expectedRevision: current.revision });
  await access('apply',{ previewId: preview.previewId,idempotencyKey: randomUUID() });
  return (await access('effective',{ app: PACKAGE,...TARGET })).tier === 'admin';
}
async function catalogNodeSuites(): Promise<number> {
  const catalog = await (await api.get(base+'/api/test-lab/catalog')).json() as { scenarios: any[]; installedApps: { name: string }[] };
  if (!catalog.installedApps?.some(app => app.name === PACKAGE)) return 0;
  return catalog.scenarios.filter(item => item.installedTest?.appName === PACKAGE && item.installedTest.runner.kind === 'node-test' && item.installedTest.runnable).length;
}

async function bootServer(databaseUrl: string, workspace: string): Promise<void> {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  let callbackPort = await freePort(); while (callbackPort === port) callbackPort = await freePort(); // the Codex OAuth listener defaults to 1455, which the live api publishes
  // APP_PACKAGE_DYNAMIC_ROUTES is what the compose stack sets so a package's compiled routes mount in-process (ADR-085 P1).
  server = startServer({ ...process.env,PORT: String(port),LOCAL_AUTH: 'true',MOCK_OIDC: 'false',FORCE_LLM_PROVIDER: 'noop',RUN_MIGRATIONS: 'true',
    APP_PACKAGE_DYNAMIC_ROUTES: '1',DISABLE_ONBOARDING_GATE: 'true',DATABASE_URL: databaseUrl,REDIS_URL: 'redis://127.0.0.1:1',
    CHROMADB_URL: 'http://127.0.0.1:1',CHROMA_MCP_URL: 'http://127.0.0.1:1',OPENAI_CODEX_CALLBACK_PORT: String(callbackPort),
    SWARM_APPS_EXTRA_DIRS: '',CLINE_WORKSPACE_ROOT: workspace,HOSTNAME: RUNNER_CONTAINER,SESSION_SECRET: `lab-follow-${randomUUID()}`,
    OSHAL_OPERATOR_EMAILS: ADMIN.email,OSHAL_OPERATOR_SUBS: ADMIN_SUB,OSHAL_SUPERADMIN_SUBS: ADMIN_SUB },join(root,'server.log'));
  // /health answers before bootstrap is done; read the server's own log and send nothing until then.
  await until(async () => readFileSync(join(root,'server.log'),'utf8'),log => log.includes('Bootstrap complete'),240000,'Server bootstrap (from server.log)');
  await until(() => fetch(base+'/health').then(r => r.status),status => status === 200,60000,'Server /health');
}

async function signInAndActivate(): Promise<void> {
  owned = await launchIsolatedBrowser({ headless: true }); browser = owned.browser;
  context = await browser.newContext(); await context.route('**/*',route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  api = context.request;
  const login = await post('/api/local-auth/login',ADMIN); expect(login.ok,'local login').toBe(true);
  // First-boot autoload races on a cold database and retries only three times, so activate the
  // package explicitly the way an operator install does.
  await until(loadPackage,active => active,240000,`${PACKAGE} active through POST /api/swarm/apps/load`);
  await until(grantOperatorAdmin,granted => granted,120000,`Operator admin grant on ${PACKAGE}`);
  expect(await until(catalogNodeSuites,count => count >= 5,120000,`${PACKAGE} with five runnable Node suites in the catalog`)).toBe(5);
  page = await context.newPage(); page.setDefaultTimeout(30000);
}

beforeAll(async () => {
  docker(['inspect','--format','{{.Image}}',RUNNER_CONTAINER]); // fail loud: the runner image comes from this container
  // Under the repo's ignored temp/ so the package's compiled routes resolve `express` and the kernel
  // from the repo's node_modules, exactly as an installed package under /app/workspace-shared does.
  mkdirSync(FIXTURE_BASE,{ recursive: true });
  root = mkdtempSync(join(FIXTURE_BASE,'oshal-lab-follow-'));
  // The workspace's deployed-apps is where store installs live; it is both auto-discovered at boot
  // and accepted by POST /api/swarm/apps/load.
  const workspace = join(root,'workspace'); exported = exportPackage(join(workspace,'deployed-apps'));
  postgres = new DisposablePostgres(); const databaseUrl = await postgres.start();
  expect((await postgres.migrate(databaseUrl)).length,'the repository migrations must apply on the disposable database').toBeGreaterThan(100);
  await postgres.seedAdmin(databaseUrl);
  await bootServer(databaseUrl,workspace);
  await signInAndActivate();
},480000);

afterAll(async () => {
  try { await context?.close(); await owned?.close(); }
  finally {
    stopServer(server); postgres?.stop();
    if (root) {
      const child = relative(resolve(FIXTURE_BASE),resolve(root));
      if (!child.startsWith('oshal-lab-follow-') || child.includes('..')) throw new Error('Unsafe fixture cleanup');
      if (REPORT_DIR && existsSync(join(root,'server.log'))) { mkdirSync(REPORT_DIR,{ recursive: true }); copyFileSync(join(root,'server.log'),join(REPORT_DIR,'lab-follow-server.log')); }
      rmSync(root,{ recursive: true,force: true });
    }
  }
},120000);

type Sample = { at: string; rows: number; active: number; passed: number; batch: string };
async function sample(): Promise<Sample> {
  const history = (await page.locator('#runHistory').textContent()) ?? '', batches = (await page.locator('#scheduleHistory').textContent()) ?? '';
  const batch = /\bcompleted\b/.test(batches) ? 'completed' : /\bcancelled\b/.test(batches) ? 'cancelled' : /\binterrupted\b/.test(batches) ? 'interrupted' : /\brunning\b/.test(batches) ? 'running' : 'unknown';
  return { at: new Date().toISOString(),rows: await page.locator('[data-history-id]').count(),active: await page.locator('[data-cancel-id]').count(),
    passed: history.match(/ · passed/g)?.length ?? 0,batch };
}

it('shows all five Create suites finishing in the real Lab without a refresh click, then stops polling',async () => {
  const reads: string[] = []; const clicks: string[] = [];
  page.on('request',request => { const url = new URL(request.url()); if (url.pathname === '/api/test-lab/runs') reads.push(url.search); });
  await page.goto(base+'/api/test-lab/app');
  await expect.poll(() => page.locator('#runStatus').textContent(),{ timeout: 60000 }).toContain('Ready.');
  await page.locator('#historyApp').selectOption(PACKAGE);
  await expect.poll(() => page.locator('#packageBatchCounts').textContent(),{ timeout: 30000 }).toContain('5 ready /');
  expect(await page.locator('[data-history-id]').count()).toBe(0);
  await page.locator('#runPackageBatch').click(); clicks.push('Run package suites');
  await expect.poll(() => page.locator('#packageBatchStatus').textContent(),{ timeout: 60000 }).toContain('admitted');
  const admittedReads = reads.length;
  // No clicks from here on: the page must reach five terminal rows by itself.
  const samples: Sample[] = [];
  const final = await until(async () => { const value = await sample(); samples.push(value); return value; },
    value => value.batch !== 'running' && value.batch !== 'unknown' && value.active === 0,300000,'Terminal batch on the page');
  const batchText = await page.locator('#scheduleHistory').textContent();
  if (REPORT_DIR) { mkdirSync(REPORT_DIR,{ recursive: true }); writeFileSync(join(REPORT_DIR,'lab-follow-samples.json'),JSON.stringify({ samples,batchText },null,2)+'\n'); }
  expect(final.batch,batchText ?? '').toBe('completed');
  expect(final.rows).toBe(5);
  expect(final.passed).toBe(5);
  expect(reads.length-admittedReads,'history must refresh itself while the batch runs').toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(3000); const settled = reads.length;
  await page.waitForTimeout(5000); expect(reads.length,'polling must stop once the batch is terminal').toBe(settled);
  // Durable truth from the server, not the page.
  const schedules = (await (await api.get(base+'/api/test-lab/schedules')).json()).schedules as { id: string; appName: string; enabled: boolean }[];
  const schedule = schedules.find(item => item.appName === PACKAGE)!; expect(schedule.enabled).toBe(false);
  const batches = (await (await api.get(base+`/api/test-lab/schedules/${schedule.id}/history`)).json()).batches as { state: string; summary: { runs: { state: string }[] } }[];
  expect(batches).toHaveLength(1); expect(batches[0].state).toBe('completed');
  expect(batches[0].summary.runs.map(run => run.state)).toEqual(['passed','passed','passed','passed','passed']);
  expect(clicks).toEqual(['Run package suites']);
  if (REPORT_DIR) {
    mkdirSync(REPORT_DIR,{ recursive: true });
    await page.screenshot({ path: join(REPORT_DIR,'lab-follow-final.png'),fullPage: true });
    writeFileSync(join(REPORT_DIR,'lab-follow-report.json'),JSON.stringify({ base,storeCommit: exported.commit,runnerContainer: RUNNER_CONTAINER,
      admittedReads,readsTotal: reads.length,clicks,samples,batch: batches[0],serverLogTail: logTail() },null,2)+'\n');
  }
},420000);
