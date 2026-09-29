/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation: guards for scripts/operations/installed-sandbox.js. Compose generation is built from the REAL docker-compose.oshal-local.yml (the api, database and Redis it mirrors, the bot node it lifts, the installer LOCAL_AUTH posture under enforce, secrets as references only). Network isolation: the generated document has zero static problems, twenty planted violations - joining the live network, a bind mount, the docker socket, a live hostname, a literal secret, oshal.tier, a non-loopback or live port, container_name, host networking, compose control variables, restart, unpinned host aliases, the posture flags, the live project name, a live service key - are each refused, and the in-container probe verdict is red for a live name, a foreign alias address or an open live port. RAM refusal: the guard's floor arithmetic and fail-closed readings, and `up` refusing below the floor before any compose/run/create call. Teardown receipt: clean vs leftover, `down` refusing the live project with no docker call, a sweep that cannot remove a volume exiting 5, and against the REAL Docker engine a labelled volume and network removed with a clean receipt. Also: packages staged from real git repositories (version pin, catalog rules, dependency tiers, LF-exact archive), the dry run as a real child process (no secret value printed, nothing written), and the identity flow against a protocol stub of the local-auth and token routes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { localSubForEmail as storeLocalSub } from '@/features/local-auth';

const requireCjs = createRequire(import.meta.url);
const plan = requireCjs('../../scripts/lib/installed-sandbox-plan.js');
const pkgs = requireCjs('../../scripts/lib/installed-sandbox-packages.js');
const ids = requireCjs('../../scripts/lib/installed-sandbox-identities.js');
const cli = requireCjs('../../scripts/operations/installed-sandbox.js');
const { loadComposeYaml } = requireCjs('../../scripts/lib/compose-yaml.js');

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'operations', 'installed-sandbox.js');
const LIVE = loadComposeYaml(fs.readFileSync(path.join(ROOT, 'docker-compose.oshal-local.yml'), 'utf8'));
const ADMIN_EMAIL = 'admin@sandbox.oshal.example.com';
const ADMIN = { email: ADMIN_EMAIL, sub: ids.localSubForEmail(ADMIN_EMAIL) };
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

type Plan = { compose: any; topology: any; hazards: string[]; aliases: string[]; bots: string[]; budgetMb: number; secretRefs: string[]; workspaceVolume: string; origin: string };
const build = (overrides: Record<string, unknown> = {}): Plan => plan.buildSandboxPlan({
  liveDoc: LIVE, project: 'oshal-sandbox-spec01', admin: ADMIN, delegationKid: 'sandbox-spec01', ...overrides,
});
const tmp = (label: string): string => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `isb-${label}-`)); scratch.push(dir); return dir; };
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A store repository with a catalog, one package (1.2.3, a shell script) and its audit record; origin/main points at HEAD. */
function storeFixture(): string {
  const dir = tmp('store');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@oshal.example.com');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'config', 'core.autocrlf', 'true');
  fs.mkdirSync(path.join(dir, 'fixture-app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audits'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture-app', 'oshal-app.yaml'), 'name: fixture-app\nversion: 1.2.3\ndisplayName: Fixture App\n');
  fs.writeFileSync(path.join(dir, 'fixture-app', 'run.sh'), 'echo one\necho two\n');
  fs.writeFileSync(path.join(dir, 'audits', 'fixture-app.json'), `${JSON.stringify({ status: 'pending' }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'marketplace.json'), JSON.stringify({ apps: [{ name: 'fixture-app', version: '1.2.3', source: { type: 'git-subdir', path: 'fixture-app' }, audit: { record: 'audits/fixture-app.json', sourceSha: '0'.repeat(40) } }] }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('compose generation from the live compose file', () => {
  it('mirrors the live api, database and Redis and nothing else', () => {
    const { compose } = build();
    expect(Object.keys(compose.services)).toEqual(['db', 'redis', 'api']);
    expect(compose.services.db.image).toBe(LIVE.services['oshal-db'].image);
    expect(compose.services.redis.image).toBe(LIVE.services['oshal-redis'].image);
    expect(compose.services.api.image).toBe(plan.resolveComposeDefaults(LIVE.services['oshal-api'].image).value);
    expect(compose.services.api.command).toBe(LIVE.services['oshal-api'].command);
    expect(compose.services.api.ports).toEqual(['127.0.0.1:35459:5000']);
    for (const [name, service] of Object.entries<any>(compose.services)) {
      expect(service.restart, name).toBe('no');
      expect(service.pull_policy, name).toBe('never');
      expect(service.container_name, name).toBeUndefined();
      expect(service.mem_limit, name).toMatch(/^\d+m$/);
    }
    expect(compose.networks.backend.internal).toBe(true);
  });

  it('boots the installer LOCAL_AUTH shape under enforce and drops every inherited live endpoint', () => {
    const env = build().compose.services.api.environment;
    expect(env).toMatchObject({
      LOCAL_AUTH: 'true', MOCK_OIDC: 'false', OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce', REDIS_URL: 'redis://redis:6379',
      OSHAL_INSTALL_OWNER_SUB: ADMIN.sub, OSHAL_INSTALL_OWNER_ISSUER: 'urn:oshal:local-auth', OSHAL_OPERATOR_EMAILS: ADMIN_EMAIL,
      LOCAL_AUTH_PUBLIC_URL: 'http://127.0.0.1:35459', FORCE_LLM_PROVIDER: 'noop', OSHAL_NO_AI: 'true', SWARM_REGISTRY: 'kernel',
    });
    for (const key of ['CHROMADB_URL', 'ARANGO_URL', 'VAULT_ADDR', 'TSDB_URL', 'OLLAMA_HOST', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'VAULT_TOKEN']) expect(env[key], key).toBeUndefined();
    expect(env.SHARED_WORKSPACE_ROOT).toBe(LIVE['x-bot-env'].SHARED_WORKSPACE_ROOT);
    expect(build({ llmProvider: 'openai' }).compose.services.api.environment.OSHAL_NO_AI ?? '').not.toBe('true');
  });

  it('writes secrets only as references and generates every value those references name', () => {
    const built = build({ bots: ['career-bot'] });
    const values: Map<string, string> = plan.generateSandboxSecrets({ randomBytes: crypto.randomBytes, generateKeyPairSync: crypto.generateKeyPairSync }, built);
    const text = JSON.stringify(built.compose);
    expect(built.secretRefs.every((name) => values.has(name))).toBe(true);
    for (const value of values.values()) expect(text.includes(value)).toBe(false);
    expect(values.get('OSHAL_SANDBOX_DATABASE_URL')).toMatch(/^postgresql:\/\/oshal_app:[A-Za-z0-9_-]+@db:5432\/oshal$/);
    expect(values.get('OSHAL_SANDBOX_BOT_DATABASE_URL')).toMatch(/^postgresql:\/\/oshal_bot:[A-Za-z0-9_-]+@db:5432\/oshal$/);
    const ring = JSON.parse(values.get('OSHAL_SANDBOX_DELEGATION_PUBLIC_KEYS')!);
    const signature = crypto.sign(null, Buffer.from('probe'), values.get('OSHAL_SANDBOX_DELEGATION_PRIVATE_KEY')!);
    expect(crypto.verify(null, Buffer.from('probe'), ring['sandbox-spec01'], signature)).toBe(true);
  });

  it('lifts a named bot node without its host mounts and forwards operator credentials by name only', () => {
    const built = build({ bots: ['career-bot'], forwardNames: ['FIXTURE_PROVIDER_KEY'] });
    const bot = built.compose.services['career-bot'];
    const live = LIVE.services['career-bot'];
    expect(bot.environment).toMatchObject({ AGENT_ID: live.environment.AGENT_ID, BOT_NAME: live.environment.BOT_NAME, BOT_RUNTIME: 'bot-node', SWARM_CONTROLLER_URL: 'http://api:5000', DATABASE_URL: '${OSHAL_SANDBOX_BOT_DATABASE_URL}' });
    expect(bot.volumes.every((mount: string) => /^[a-z][a-z0-9_-]*:\//.test(mount))).toBe(true);
    expect(live.volumes.some((mount: string) => mount.startsWith('./'))).toBe(true);
    expect(bot.networks.backend.aliases).toEqual(['career-bot', live.container_name]);
    expect(bot.environment.FIXTURE_PROVIDER_KEY).toBe('${OSHAL_SANDBOX_FWD_FIXTURE_PROVIDER_KEY}');
    expect(built.compose.services.api.environment.FIXTURE_PROVIDER_KEY).toBe('${OSHAL_SANDBOX_FWD_FIXTURE_PROVIDER_KEY}');
    expect(Object.keys(bot.networks)).toEqual(['backend', 'edge']);
    expect(Object.keys(build({ bots: ['career-bot'] }).compose.services['career-bot'].networks)).toEqual(['backend']);
    expect(built.budgetMb).toBe(build().budgetMb + plan.MEMORY_LIMITS_MB.bot);
  });

  it('refuses a non-bot service, a live published port and a non-sandbox project', () => {
    expect(() => build({ bots: ['oshal-db'] })).toThrow(/no live bot service/);
    expect(() => build({ bots: ['no-such-bot'] })).toThrow(/no live bot service/);
    expect(() => build({ port: 35457 })).toThrow(/published by the live stack/);
    expect(() => build({ project: 'oshal-local' })).toThrow(/sandbox project must match/);
  });

  it('evaluates compose defaults with an empty environment', () => {
    expect(plan.resolveComposeDefaults('${A:-${B:-deep}}')).toEqual({ value: 'deep', complete: true });
    expect(plan.resolveComposeDefaults('x-${A}')).toEqual({ value: 'x-', complete: false });
    expect(plan.resolveComposeDefaults('$${A}')).toEqual({ value: '${A}', complete: true });
  });
});

describe('network isolation', () => {
  const clone = (): Plan => { const built = build({ bots: ['career-bot'] }); return { ...built, compose: JSON.parse(JSON.stringify(built.compose)) }; };
  const labels = { 'oshal.sandbox': 'installed-sandbox', 'oshal.sandbox.project': 'oshal-sandbox-spec01' };
  const mutations: Array<[string, (c: any) => void, RegExp]> = [
    ['join the live network', (c) => { c.networks.live = { external: true, name: 'oshal-local_oshal', labels }; c.services.api.networks.live = {}; }, /external networks are refused/],
    ['database on the egress network', (c) => { c.services.db.networks.edge = {}; }, /internal backend network only/],
    ['backend with egress', (c) => { c.networks.backend.internal = false; }, /must be internal/],
    ['bind mount of the shared tree', (c) => { c.services.api.volumes.push('./any-bot/server:/app/any-bot/server:ro'); }, /bind mounts are refused/],
    ['docker socket', (c) => { c.services.api.volumes.push('/var/run/docker.sock:/var/run/docker.sock'); }, /docker socket/],
    ['live workspace volume by name', (c) => { c.volumes.oshal_workspace.name = 'oshal-local_oshal_workspace'; }, /explicit name/],
    ['live Redis hostname', (c) => { c.services.api.environment.REDIS_URL = 'redis://oshal-redis:6379'; }, /live host "oshal-redis"/],
    ['literal secret', (c) => { c.services.api.environment.SESSION_SECRET = 'plain-value'; }, /holds a literal/],
    ['credential in a URL', (c) => { c.services.api.environment.ANALYTICS_URL = 'postgresql://oshal:oshal@db:5432/oshal'; }, /embeds a credential/],
    ['monitoring tier label', (c) => { c.services.api.labels['oshal.tier'] = 'core'; }, /oshal\.tier/],
    ['non-loopback publish', (c) => { c.services.api.ports = ['0.0.0.0:35459:5000']; }, /not bound to 127\.0\.0\.1/],
    ['live port', (c) => { c.services.api.ports = ['127.0.0.1:35457:5000']; }, /collides with a live published port/],
    ['container name', (c) => { c.services.api.container_name = 'oshal-local-api'; }, /container_name is set/],
    ['host networking', (c) => { c.services.redis.network_mode = 'host'; }, /network_mode/],
    ['compose control variable', (c) => { c.services.api.environment.COMPOSE_PROJECT_NAME = 'oshal-local'; }, /control variable/],
    ['restart policy', (c) => { c.services.db.restart = 'unless-stopped'; }, /restart must be "no"/],
    ['unpinned host alias', (c) => { c.services['career-bot'].extra_hosts = []; }, /host\.docker\.internal is not pinned/],
    ['posture: mock sign-in and legacy authorization', (c) => { c.services.api.environment.MOCK_OIDC = 'true'; c.services.api.environment.OSHAL_APPLICATION_AUTHORIZATION_MODE = 'legacy'; }, /MOCK_OIDC must be false/],
    ['live project name', (c) => { c.name = 'oshal-local'; }, /not a sandbox project/],
    ['live service key', (c) => { c.services['oshal-redis'] = c.services.redis; delete c.services.redis; }, /reuses a live service key/],
  ];

  it('generates a document with zero static problems', () => {
    const built = build({ bots: ['career-bot'], forwardNames: ['FIXTURE_PROVIDER_KEY'] });
    expect(plan.isolationProblems(built.compose, built)).toEqual([]);
    expect(built.hazards).toEqual(expect.arrayContaining(['oshal-redis', 'oshal-db', LIVE.services['oshal-redis'].container_name, 'host.docker.internal']));
    expect(built.hazards).not.toContain('career-bot');
  });

  it.each(mutations)('refuses: %s', (_label, mutate, expected) => {
    const built = clone();
    mutate(built.compose);
    expect(plan.isolationProblems(built.compose, built).join('\n')).toMatch(expected);
  });

  it('judges the in-container probe', () => {
    const expectation = { hazards: ['oshal-redis', 'host.docker.internal'], aliases: ['career-bot'], sandboxIps: ['172.30.0.4'] };
    const clean = { resolved: { 'oshal-redis': null, 'host.docker.internal': ['127.0.0.1'], 'career-bot': ['172.30.0.4'] }, connects: { 'host.docker.internal:56380': 'ECONNREFUSED' } };
    expect(plan.evaluateIsolationProbe(clean, expectation)).toEqual([]);
    expect(plan.evaluateIsolationProbe({ ...clean, resolved: { ...clean.resolved, 'oshal-redis': ['172.18.0.5'] } }, expectation).join()).toMatch(/live name oshal-redis resolves/);
    expect(plan.evaluateIsolationProbe({ ...clean, resolved: { ...clean.resolved, 'career-bot': ['172.18.0.9'] } }, expectation).join()).toMatch(/resolves outside the sandbox/);
    expect(plan.evaluateIsolationProbe({ ...clean, connects: { 'host.docker.internal:56380': 'open' } }, expectation).join()).toMatch(/accepted a connection/);
    expect(plan.evaluateIsolationProbe({ resolved: {}, connects: {} }, expectation).join()).toMatch(/did not report oshal-redis/);
  });
});

/** Dependency double for the CLI: a recording docker seam, a fixed host free figure, no network. */
function recordingDeps(respond: (args: string[]) => { status: number; stdout: string; stderr?: string }, freeMb = 8192) {
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stateRoot = tmp('state');
  const deps = {
    spawnSync: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stderr: '', ...respond(args) }; },
    spawn: () => { throw new Error('spawn is not expected here'); },
    fetch: async () => { throw new Error('fetch is not expected here'); },
    fs, env: { PATH: process.env.PATH ?? '' }, freemem: () => freeMb * 1048576, tmpdir: () => stateRoot, clock: Date.now,
    now: () => new Date(), sleep: async () => undefined, randomBytes: crypto.randomBytes, generateKeyPairSync: crypto.generateKeyPairSync,
    portFree: async () => true, out: (line: string) => out.push(line), err: (line: string) => err.push(line),
  };
  return { deps, calls, out, err, stateRoot };
}

describe('RAM guard', () => {
  it('holds the stated floor and fails closed on an unreadable figure', () => {
    const base = { hostFreeMb: 4000, engineTotalMb: 6000, engineUsedMb: 1000, budgetMb: 2040, hostReserveMb: 1024 };
    expect(plan.evaluateRamGuard(base)).toMatchObject({ ok: true, floorMb: 3064, engineHeadroomMb: 5000 });
    const low = plan.evaluateRamGuard({ ...base, hostFreeMb: 900 });
    expect(low.ok).toBe(false);
    expect(low.reasons.join()).toMatch(/host free memory 900 MB is below the floor 3064 MB \(sandbox 2040 MB \+ reserve 1024 MB\)/);
    expect(plan.evaluateRamGuard({ ...base, engineUsedMb: 5000 }).reasons.join()).toMatch(/engine headroom 1000 MB .* below the sandbox budget 2040 MB/);
    expect(plan.evaluateRamGuard({ ...base, engineTotalMb: NaN })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/could not be read/)] });
    expect(plan.parseDockerMemUsage('512MiB / 5.787GiB\n1.5GiB / 5.787GiB\n1000kB / 1GB')).toBeCloseTo(2048 + 1000 / 1048.576, 3);
    expect(plan.parseDockerMemUsage('')).toBe(0);
    expect(plan.parseDockerMemUsage('garbage')).toBeNaN();
  });

  it('up refuses below the floor before any compose, run or create call', async () => {
    const harness = recordingDeps((args) => {
      if (args[0] === 'info') return { status: 0, stdout: String(6 * 1024 ** 3) };
      if (args[0] === 'stats') return { status: 0, stdout: '1.0GiB / 6GiB\n' };
      return { status: 0, stdout: '' };
    }, 700);
    const code = await cli.main(['up', '--name', 'spec-ram'], harness.deps);
    expect(code).toBe(cli.EXIT.ram);
    expect(harness.out.join('\n')).toMatch(/RAM now: host free 700 MB.*REFUSE/);
    expect(harness.calls.map((call) => call[1])).toEqual(['info', 'stats']);
    expect(fs.existsSync(path.join(harness.stateRoot, 'oshal-installed-sandbox', 'oshal-sandbox-spec-ram'))).toBe(false);
  });
});

describe('teardown receipt', () => {
  it('is clean only when nothing is left and the credentials directory is gone', () => {
    const before = { containers: ['p-api-1'], volumes: ['p_db-data'], networks: ['p_backend'] };
    const empty = { containers: [], volumes: [], networks: [] };
    const clean = plan.buildTeardownReceipt({ project: 'p', before, after: empty, stateDirRemoved: true });
    expect(clean).toMatchObject({ ok: true, evidenceLabel: 'installed-sandbox', removed: before });
    expect(plan.formatTeardownReceipt(clean)[0]).toMatch(/CLEAN/);
    const left = plan.buildTeardownReceipt({ project: 'p', before, after: { ...empty, volumes: ['p_db-data'] }, stateDirRemoved: true });
    expect(left).toMatchObject({ ok: false, leftover: { volumes: ['p_db-data'] } });
    expect(plan.formatTeardownReceipt(left).join('\n')).toMatch(/RED[\s\S]*leftover volumes: p_db-data/);
    expect(plan.buildTeardownReceipt({ project: 'p', before, after: empty, stateDirRemoved: false }).ok).toBe(false);
  });

  it('down can only ever address a sandbox project', async () => {
    const refused = recordingDeps(() => ({ status: 0, stdout: '' }));
    expect(await cli.main(['down', '--name', 'Bad Name!'], refused.deps)).toBe(cli.EXIT.failed);
    expect(refused.err.join()).toMatch(/sandbox project must match/);
    expect(refused.calls).toEqual([]);
    const live = recordingDeps(() => ({ status: 0, stdout: '' }));
    expect(await cli.main(['down', '--name', LIVE.name], live.deps)).toBe(cli.EXIT.ok);
    const filters = live.calls.flatMap((call) => call.filter((arg) => arg.startsWith('label=com.docker.compose.project=')));
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((filter) => filter === `label=com.docker.compose.project=oshal-sandbox-${LIVE.name}`)).toBe(true);
  });

  it('down is red (exit 5) when the sweep cannot remove a volume', async () => {
    const harness = recordingDeps((args) => (args[0] === 'volume' && args[1] === 'ls' ? { status: 0, stdout: 'oshal-sandbox-spec02_db-data\n' } : { status: 0, stdout: '' }));
    expect(await cli.main(['down', '--name', 'spec02'], harness.deps)).toBe(cli.EXIT.leftover);
    expect(harness.calls.some((call) => call.join(' ') === 'docker volume rm -f oshal-sandbox-spec02_db-data')).toBe(true);
    expect(harness.err.join('\n')).toMatch(/leftover volumes: oshal-sandbox-spec02_db-data/);
  });

  it('removes a labelled volume and network from the real Docker engine with a clean receipt', async () => {
    const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
    if (version.status !== 0) throw new Error(`this guard needs the Docker engine: ${version.stderr}`);
    const project = `oshal-sandbox-spec${crypto.randomBytes(3).toString('hex')}`;
    const label = ['--label', `com.docker.compose.project=${project}`, '--label', `oshal.sandbox.project=${project}`];
    expect(spawnSync('docker', ['volume', 'create', ...label, `${project}_db-data`]).status).toBe(0);
    expect(spawnSync('docker', ['network', 'create', '--internal', ...label, `${project}_backend`]).status).toBe(0);
    const stateRoot = tmp('real-state');
    fs.mkdirSync(path.join(stateRoot, project));
    fs.writeFileSync(path.join(stateRoot, project, 'credentials.env'), 'OSHAL_SANDBOX_ADMIN_PAT=fixture\n');
    const out: string[] = [];
    const deps = { ...cli.realDeps(), out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
    expect(await cli.main(['down', '--name', project, '--state-root', stateRoot], deps)).toBe(cli.EXIT.ok);
    expect(out.join('\n')).toMatch(new RegExp(`CLEAN[\\s\\S]*removed volumes: ${project}_db-data[\\s\\S]*removed networks: ${project}_backend`));
    const left = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).stdout.trim();
    expect(left).toBe('');
    expect(fs.existsSync(path.join(stateRoot, project))).toBe(false);
  }, 60_000);
});

describe('packages staged from real git repositories', () => {
  it('pins the requested version at the store ref and refuses a mismatch or an unknown package', () => {
    const store = storeFixture();
    const run = pkgs.createGit(spawnSync);
    const item = pkgs.stageStorePackage(run, { storeDir: store, ref: 'origin/main' }, pkgs.parsePackageSpec('fixture-app@1.2.3'));
    expect(item).toMatchObject({ kind: 'store', name: 'fixture-app', version: '1.2.3', sha: git(store, 'rev-parse', 'HEAD'), auditStatus: 'pending' });
    expect(item.tree).toBe(`${item.sha}:fixture-app`);
    expect(() => pkgs.stageStorePackage(run, { storeDir: store, ref: 'origin/main' }, pkgs.parsePackageSpec('fixture-app@9.9.9'))).toThrow(/is 1\.2\.3 at that ref, not the requested 9\.9\.9/);
    expect(() => pkgs.stageStorePackage(run, { storeDir: store, ref: 'origin/main' }, pkgs.parsePackageSpec('absent-app'))).toThrow(/exactly one package/);
    expect(() => pkgs.stageStorePackage(run, { storeDir: store, ref: 'origin/nope' }, pkgs.parsePackageSpec('fixture-app'))).toThrow(/does not name a commit/);
    const record = pkgs.buildInstallRecord(item, { required: {}, optional: {} }, '2026-09-29T00:00:00.000Z');
    expect(record).toMatchObject({ name: 'fixture-app', sha: item.sha, ref: 'origin/main', installedBy: 'installed-sandbox', audit: { verified: false, status: 'pending' } });
  });

  it('names a private package by its manifest, never by core', () => {
    const repo = tmp('private');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'fixture@oshal.example.com');
    git(repo, 'config', 'user.name', 'fixture');
    fs.mkdirSync(path.join(repo, 'apps', 'fixture-private-app'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps', 'fixture-private-app', 'oshal-app.yaml'), 'name: fixture-private-app\nversion: 0.4.0\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const item = pkgs.stagePrivatePackage(pkgs.createGit(spawnSync), pkgs.parsePrivateSpec(`${path.join(repo, 'apps', 'fixture-private-app')}@0.4.0`), 'main');
    expect(item).toMatchObject({ kind: 'private', name: 'fixture-private-app', version: '0.4.0', auditStatus: 'not-cataloged' });
    expect(item.tree).toMatch(/^[0-9a-f]{40}:apps\/fixture-private-app$/);
  });

  it('resolves dependency tiers fail-closed', () => {
    const tiers = (required: string[], optional: string[] = []) => ({ required: { apps: required }, optional: { apps: optional } });
    const staged = [{ name: 'a-app', dependencies: tiers(['b-app', 'core-app'], ['c-app']) }, { name: 'b-app', dependencies: tiers([]) }];
    const resolution = pkgs.resolveStagedDependencies(staged, (name: string) => name === 'core-app');
    expect(resolution.get('a-app')).toEqual({ required: { 'b-app': 'installed', 'core-app': 'core' }, optional: { 'c-app': 'not-selected' } });
    expect(() => pkgs.resolveStagedDependencies([staged[0]], () => false)).toThrow(/requires "b-app"/);
  });

  it('archives LF-exact bytes even from a CRLF-converting repository', () => {
    const store = storeFixture();
    const item = pkgs.stageStorePackage(pkgs.createGit(spawnSync), { storeDir: store, ref: 'origin/main' }, pkgs.parsePackageSpec('fixture-app'));
    const tar = spawnSync('git', pkgs.archiveArgs(item), { maxBuffer: 1 << 24 }).stdout as Buffer;
    const files = new Map<string, string>();
    for (let offset = 0; offset + 512 <= tar.length;) {
      const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.subarray(offset + 124, offset + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
      files.set(name, tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(files.get('deployed-apps/fixture-app/run.sh')).toBe('echo one\necho two\n');
    const converted = spawnSync('git', ['-C', store, 'archive', '--format=tar', item.tree], { maxBuffer: 1 << 24 }).stdout as Buffer;
    expect(converted.includes(Buffer.from('echo one\r\n'))).toBe(true);
  });
});

describe('the dry run as a real child process', () => {
  it('prints the plan and names without printing a secret or writing state', () => {
    const store = storeFixture();
    const stateRoot = tmp('dry-state');
    const sentinel = `sentinel-${crypto.randomBytes(8).toString('hex')}`;
    const envFile = path.join(tmp('dry-env'), 'operator.env');
    fs.writeFileSync(envFile, `OTHER=1\nFIXTURE_PROVIDER_KEY="${sentinel}"\n`);
    const args = [SCRIPT, 'up', '--dry-run', '--name', 'spec-dry', '--store-repo', store, '--package', 'fixture-app@1.2.3',
      '--bot', 'career-bot', '--forward-env', 'FIXTURE_PROVIDER_KEY', '--operator-env', envFile, '--state-root', stateRoot];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\[installed-sandbox\] DRY RUN/);
    expect(result.stdout).toMatch(/project oshal-sandbox-spec-dry/);
    expect(result.stdout).toMatch(/package fixture-app@1\.2\.3 store [0-9a-f]{12} \(origin\/main\)/);
    expect(result.stdout).toMatch(/FIXTURE_PROVIDER_KEY \(present: yes\)/);
    expect(result.stdout).toMatch(/OSHAL_SANDBOX_ALPHA_PAT/);
    expect(result.stdout).toMatch(/RAM guard: sandbox budget 2680 MB/);
    expect(`${result.stdout}${result.stderr}`.includes(sentinel)).toBe(false);
    expect(fs.readdirSync(stateRoot)).toEqual([]);
    const mismatch = spawnSync(process.execPath, [SCRIPT, 'up', '--dry-run', '--store-repo', store, '--package', 'fixture-app@9.9.9', '--state-root', stateRoot], { encoding: 'utf8', timeout: 90_000 });
    expect(mismatch.status).toBe(cli.EXIT.failed);
    expect(mismatch.stderr).toMatch(/not the requested 9\.9\.9/);
  }, 120_000);
});

/** A protocol stub of the local-auth and token routes: origin-checked bootstrap, one-use invites, cookies, PATs. */
async function startStub(options: { reuseStatus?: number; whoamiSub?: (sub: string) => string } = {}) {
  const sessions = new Map<string, string>();
  const tokens = new Map<string, string>();
  const invites = new Map<string, { email: string; used: boolean }>();
  const passwords = new Map<string, string>();
  let rootClaimed = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', origin);
      const send = (status: number, json: unknown, sub?: string) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (sub) { const value = crypto.randomBytes(12).toString('hex'); sessions.set(value, sub); headers['set-cookie'] = `oshal_local=${value}; Path=/; HttpOnly`; }
        res.writeHead(status, headers); res.end(JSON.stringify(json));
      };
      const who = sessions.get(/oshal_local=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'POST /api/local-auth/bootstrap') {
        if (req.headers.origin !== origin) return send(403, { error: 'origin' });
        if (rootClaimed || body.setupToken !== 'fixture-setup-code') return send(409, { error: 'claimed' });
        rootClaimed = true; passwords.set(body.email, body.password);
        return send(201, { ok: true, sub: storeLocalSub(body.email), rootClaimed: true }, storeLocalSub(body.email));
      }
      if (route === 'POST /api/local-auth/users') {
        if (!who) return send(401, { error: 'sign in' });
        const token = `oshal_inv_${crypto.randomBytes(8).toString('hex')}`; invites.set(token, { email: body.email, used: false });
        return send(201, { invitePath: `/accept-invite?token=${token}`, emailSent: false });
      }
      if (route === 'GET /api/local-auth/invite-info') { const invite = invites.get(url.searchParams.get('token') ?? ''); return invite ? send(200, { email: invite.email }) : send(404, {}); }
      if (route === 'POST /api/local-auth/accept') {
        const invite = invites.get(body.token);
        if (!invite || invite.used) return send(options.reuseStatus ?? 410, { error: 'spent' });
        invite.used = true; passwords.set(invite.email, body.password); return send(200, { ok: true }, storeLocalSub(invite.email));
      }
      if (route === 'POST /api/local-auth/login') return passwords.get(body.email) === body.password ? send(200, { ok: true }, storeLocalSub(body.email)) : send(401, { error: 'no' });
      if (route === 'GET /api/auth/user') return who ? send(200, { authenticated: true, user: { sub: who, email: [...passwords.keys()].find((email) => storeLocalSub(email) === who) } }) : send(200, { authenticated: false });
      if (route === 'POST /api/cli-tokens') { if (!who) return send(401, {}); const token = `oshal_pat_${crypto.randomBytes(24).toString('hex')}`; tokens.set(token, who); return send(201, { token }); }
      if (route === 'GET /api/cli-tokens/whoami') { const sub = tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, '')); return sub ? send(200, { sub: options.whoamiSub ? options.whoamiSub(sub) : sub }) : send(401, {}); }
      return send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe('identities through the local-auth and token doors (protocol stub)', () => {
  const register = async (stubOptions = {}) => {
    const { server, origin } = await startStub(stubOptions);
    const log: string[] = [];
    const users = ids.sandboxUsers([], crypto.randomBytes);
    try {
      const result = await ids.registerIdentities({ call: ids.createClient(origin, fetch), users, issueSetupCode: async () => 'fixture-setup-code', patLabel: 'spec', log: (line: string) => log.push(line) });
      return { result, log, users };
    } finally { server.close(); }
  };

  it('registers the root and two invited members, each with a session and a token that act as them', async () => {
    const { result, log, users } = await register();
    expect(users.map((user: { label: string }) => user.label)).toEqual(['admin', 'alpha', 'bravo']);
    expect(users.every((user: { email: string; sub: string }) => user.sub === storeLocalSub(user.email))).toBe(true);
    expect(result.credentials.size).toBe(15);
    expect(result.credentials.get('OSHAL_SANDBOX_BRAVO_PAT')).toMatch(ids.PAT_PATTERN);
    expect(result.credentials.get('OSHAL_SANDBOX_ALPHA_SESSION')).toMatch(/^oshal_local=/);
    const secrets = [...result.credentials.entries()].filter(([name]) => /_(PASSWORD|SESSION|PAT)$/.test(name)).map(([, value]) => value);
    for (const value of secrets) expect(`${log.join('\n')}${JSON.stringify(result.identities)}`.includes(value)).toBe(false);
    const file = path.join(tmp('creds'), 'credentials.env');
    expect(ids.writeCredentialsFile(file, result.credentials)).toHaveLength(15);
    expect(ids.readCredentialsFile(file).get('OSHAL_SANDBOX_ADMIN_SUB')).toBe(users[0].sub);
  });

  it('refuses when a spent invitation is accepted again or a token acts as someone else', async () => {
    await expect(register({ reuseStatus: 200 })).rejects.toThrow(/answered 200, not 410/);
    await expect(register({ whoamiSub: () => 'local-0000000000000000' })).rejects.toThrow(/did not act as/);
  });
});

describe('command line', () => {
  it('rejects unknown flags, missing names and malformed values', () => {
    expect(() => cli.parseArgs(['up', '--bogus'])).toThrow(/unknown argument/);
    expect(() => cli.parseArgs(['down'])).toThrow(/needs --name/);
    expect(() => cli.parseArgs(['up', '--set-env', 'lower=1'])).toThrow(/KEY=VALUE/);
    expect(() => cli.parseArgs(['up', '--forward-env', 'bad-name'])).toThrow(/invalid --forward-env/);
    expect(cli.parseArgs(['up', '--package', 'a-app@1.0.0', '--package', 'b-app', '--port', '35460'])).toMatchObject({ packages: ['a-app@1.0.0', 'b-app'], port: 35460, storeRef: 'origin/main' });
  });

  it('never hands docker the caller\'s compose control variables or sandbox values', () => {
    expect(cli.scrubbedEnv({ PATH: 'p', COMPOSE_PROJECT_NAME: 'oshal-local', COMPOSE_FILE: 'x', OSHAL_SANDBOX_PG_PASSWORD: 'v' })).toEqual({ PATH: 'p' });
  });
});
