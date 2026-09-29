/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation: guards for scripts/operations/installed-sandbox.js. Compose generation is built from the REAL docker-compose.oshal-local.yml (the api, database and Redis it mirrors, the bot node it lifts, the installer LOCAL_AUTH posture under enforce, secrets as references only). Network isolation: the generated document has zero static problems, twenty planted violations - joining the live network, a bind mount, the docker socket, a live hostname, a literal secret, oshal.tier, a non-loopback or live port, container_name, host networking, compose control variables, restart, unpinned host aliases, the posture flags, the live project name, a live service key - are each refused, and the in-container probe verdict is red for a live name, a foreign alias address or an open live port. RAM refusal: the guard's floor arithmetic and fail-closed readings, and `up` refusing below the floor before any compose/run/create call. Teardown receipt: clean vs leftover, `down` refusing the live project with no docker call, a sweep that cannot remove a volume exiting 5, and against the REAL Docker engine a labelled volume and network removed with a clean receipt. Also: packages staged from real git repositories (version pin, catalog rules, dependency tiers, LF-exact archive), the dry run as a real child process (no secret value printed, nothing written), and the identity flow against a protocol stub of the local-auth and token routes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Guards for the two defects found by reading the first cut against what it boots and against this engine. (1) Routes by address: the api sat on a network with a host route, and the probe knocked only on names. New cases: the api and the bots on the internal network only, the gateway as the one publisher and the one edge member, nine more planted violations (an api or a bot on edge, an api publishing, an egress network with nothing forwarded, a database on egress, a gateway with environment, a volume, another entrypoint, or none at all), the verdict on default routes and address connects, the live-address parser, `status` handing the live container addresses to the probe and going red when one answers, the forwarder relaying a real HTTP exchange as a real child process, and against the REAL Docker engine the shipped probe script run from an internal network (clean) and from an ordinary bridge (a default route, and the other container answering on its address). (2) Generated secrets against the validators the image boots with: the real role provisioner accepts the two role passwords and refuses the first cut's base64url shape, and the real delegation issuer and verifier load the generated key pair. The generated document is also parsed by the real `docker compose config`, which starts nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { localSubForEmail as storeLocalSub } from '@/features/local-auth';
import { createDelegationTokenIssuer, createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { runtimeCredentials } from '../../scripts/governance/provision-app-role.mjs';
import { acquireFixtureSlot } from '../helpers/fixture-slots';

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

type Plan = { compose: any; topology: any; hazards: string[]; aliases: string[]; bots: string[]; budgetMb: number; secretRefs: string[]; workspaceVolume: string; origin: string; egress: boolean; probeServices: string[]; forwardNames: string[] };
const realSecrets = (built: Plan): Map<string, string> => plan.generateSandboxSecrets({ randomBytes: crypto.randomBytes, generateKeyPairSync: crypto.generateKeyPairSync }, built);
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
  it('mirrors the live api, database and Redis, and adds only the gateway', () => {
    const { compose } = build();
    expect(Object.keys(compose.services)).toEqual(['db', 'redis', 'api', 'gateway']);
    expect(compose.services.db.image).toBe(LIVE.services['oshal-db'].image);
    expect(compose.services.redis.image).toBe(LIVE.services['oshal-redis'].image);
    expect(compose.services.api.image).toBe(plan.resolveComposeDefaults(LIVE.services['oshal-api'].image).value);
    expect(compose.services.api.command).toBe(LIVE.services['oshal-api'].command);
    for (const [name, service] of Object.entries<any>(compose.services)) {
      expect(service.restart, name).toBe('no');
      expect(service.pull_policy, name).toBe('never');
      expect(service.container_name, name).toBeUndefined();
      expect(service.mem_limit, name).toMatch(/^\d+m$/);
    }
    expect(compose.networks.backend.internal).toBe(true);
  });

  it('keeps the api, the database and Redis on the internal network and publishes only through the gateway', () => {
    const built = build();
    const { services, networks } = built.compose;
    for (const name of ['db', 'redis', 'api']) {
      expect(Object.keys(services[name].networks), name).toEqual(['backend']);
      expect(services[name].ports, name).toBeUndefined();
    }
    expect(Object.keys(networks)).toEqual(['backend', 'edge']);
    expect(Object.keys(services.gateway.networks)).toEqual(['backend', 'edge']);
    expect(services.gateway.ports).toEqual(['127.0.0.1:35459:5000']);
    expect(services.gateway.image).toBe(services.api.image);
    expect(services.gateway.entrypoint).toEqual(['node', '-e', plan.forwarderScript('api', 5000, 5000)]);
    expect(services.gateway.entrypoint[2]).not.toContain('$');
    expect(services.gateway.environment).toBeUndefined();
    expect(services.gateway.volumes).toBeUndefined();
    expect(built.egress).toBe(false);
    expect(built.probeServices).toEqual(['api']);
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
    const values = realSecrets(built);
    const text = JSON.stringify(built.compose);
    expect(built.secretRefs.every((name) => values.has(name))).toBe(true);
    for (const value of values.values()) expect(text.includes(value)).toBe(false);
    expect(values.get('OSHAL_SANDBOX_DATABASE_URL')).toMatch(/^postgresql:\/\/oshal_app:[0-9a-f]{48}@db:5432\/oshal$/);
    expect(values.get('OSHAL_SANDBOX_BOT_DATABASE_URL')).toMatch(/^postgresql:\/\/oshal_bot:[0-9a-f]{48}@db:5432\/oshal$/);
    const ring = JSON.parse(values.get('OSHAL_SANDBOX_DELEGATION_PUBLIC_KEYS')!);
    const signature = crypto.sign(null, Buffer.from('probe'), values.get('OSHAL_SANDBOX_DELEGATION_PRIVATE_KEY')!);
    expect(crypto.verify(null, Buffer.from('probe'), ring['sandbox-spec01'], signature)).toBe(true);
  });

  it('generates secrets the validators the image boots with accept', () => {
    const built = build({ bots: ['career-bot'] });
    const values = realSecrets(built);
    const appUrl = values.get('OSHAL_SANDBOX_DATABASE_URL')!;
    // As the api boot command calls it: the app password read back out of DATABASE_URL, no bot password given.
    const asBooted = {
      bootstrapUrl: values.get('OSHAL_SANDBOX_BOOTSTRAP_DATABASE_URL'), appUrl, botUrl: values.get('OSHAL_SANDBOX_BOT_DATABASE_URL'),
      appPassword: new URL(appUrl).password as string | undefined, botPassword: undefined,
    };
    const accepted = runtimeCredentials(asBooted);
    expect(accepted.appPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(accepted.botPassword).toMatch(/^[0-9a-f]{48}$/);
    const firstCut = `postgresql://oshal_app:${crypto.randomBytes(24).toString('base64url')}@db:5432/oshal`;
    expect(() => runtimeCredentials({ ...asBooted, appUrl: firstCut, appPassword: undefined })).toThrow(/oshal_app password must be 48-128 hexadecimal characters/);
    const api = built.compose.services.api.environment;
    const bot = built.compose.services['career-bot'].environment;
    const filled = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(env).map(([key, value]) => [key, /^\$\{(OSHAL_SANDBOX_[A-Z0-9_]+)\}$/.test(value) ? values.get(value.slice(2, -1))! : value]));
    expect(() => createDelegationTokenIssuer({ env: filled(api) })).not.toThrow();
    expect(() => createDelegationTokenVerifier({ env: filled(bot) })).not.toThrow();
    expect(() => createDelegationTokenVerifier({ env: { ...filled(bot), OSHAL_DELEGATION_PUBLIC_KEYS: '{}' } })).toThrow(/count is invalid/);
  });

  it('is a document the real docker compose parses, with every reference filled from the process environment', () => {
    const built = build({ bots: ['career-bot'] });
    const values = realSecrets(built);
    const dir = tmp('compose');
    fs.writeFileSync(path.join(dir, 'compose.json'), JSON.stringify(built.compose));
    const env = { ...cli.scrubbedEnv(process.env), ...Object.fromEntries(values) };
    const parsed = spawnSync('docker', ['compose', '-p', built.compose.name, '-f', path.join(dir, 'compose.json'), '--project-directory', dir, 'config', '--format', 'json'], { encoding: 'utf8', env, cwd: dir, timeout: 60_000 });
    expect(parsed.status, parsed.stderr).toBe(0);
    const model = JSON.parse(parsed.stdout);
    expect(Object.keys(model.services).sort()).toEqual(['api', 'career-bot', 'db', 'gateway', 'redis']);
    expect(model.services.api.ports).toBeUndefined();
    expect(model.services.gateway.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1', published: '35459', target: 5000 })]);
    expect(model.networks.backend).toMatchObject({ internal: true, name: `${built.compose.name}_backend` });
    expect(Object.keys(model.services.api.networks)).toEqual(['backend']);
    expect(model.services.api.environment.DATABASE_URL).toBe(values.get('OSHAL_SANDBOX_DATABASE_URL'));
    expect(model.services.api.environment.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY).toBe(values.get('OSHAL_SANDBOX_DELEGATION_PRIVATE_KEY'));
    expect(model.services.gateway.entrypoint).toEqual(['node', '-e', plan.forwarderScript('api', 5000, 5000)]);
  }, 90_000);

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
    expect(built.compose.services.gateway.environment).toBeUndefined();
    expect(built.budgetMb).toBe(build().budgetMb + plan.MEMORY_LIMITS_MB.bot);
    expect(build().budgetMb).toBe(512 + 128 + 1400 + 96);
  });

  it('gives the api and the bots a host route only when a credential is forwarded, and says so', () => {
    const forwarded = build({ bots: ['career-bot'], forwardNames: ['FIXTURE_PROVIDER_KEY'] });
    expect(forwarded.egress).toBe(true);
    expect(Object.keys(forwarded.compose.networks)).toEqual(['backend', 'edge', 'egress']);
    expect(forwarded.compose.networks.egress.internal).toBeUndefined();
    expect(Object.keys(forwarded.compose.services.api.networks)).toEqual(['backend', 'egress']);
    expect(Object.keys(forwarded.compose.services['career-bot'].networks)).toEqual(['backend', 'egress']);
    for (const name of ['db', 'redis']) expect(Object.keys(forwarded.compose.services[name].networks), name).toEqual(['backend']);
    expect(Object.keys(forwarded.compose.services.gateway.networks)).toEqual(['backend', 'edge']);
    expect(forwarded.probeServices).toEqual(['api', 'career-bot']);
    const plain = build({ bots: ['career-bot'] });
    expect(plain.egress).toBe(false);
    expect(plain.compose.networks.egress).toBeUndefined();
    expect(Object.keys(plain.compose.services['career-bot'].networks)).toEqual(['backend']);
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
    ['join the live network', (c) => { c.networks.live = { external: true, name: 'oshal-local_oshal', labels }; c.services.api.networks.live = {}; }, /external networks are refused[\s\S]*api: joins "live", which is not a sandbox network/],
    ['database on the edge network', (c) => { c.services.db.networks.edge = {}; }, /db: only the gateway may join the edge network/],
    ['api on the edge network', (c) => { c.services.api.networks.edge = {}; }, /api: only the gateway may join the edge network/],
    ['bot on the edge network', (c) => { c.services['career-bot'].networks.edge = {}; }, /career-bot: only the gateway may join the edge network/],
    ['api publishes its own port', (c) => { c.services.api.ports = ['127.0.0.1:35460:5000']; }, /api: only the gateway may publish a port/],
    ['egress network with nothing forwarded', (c) => { c.networks.egress = { labels }; c.services.api.networks.egress = {}; }, /network egress: declared although no credential is forwarded[\s\S]*api: joins the egress network although no credential is forwarded/],
    ['api off the backend network', (c) => { c.services.api.networks = {}; }, /api: must join the internal backend network/],
    ['gateway carrying environment', (c) => { c.services.gateway.environment = { REDIS_URL: 'redis://redis:6379' }; }, /gateway: carries environment/],
    ['gateway mounting the workspace', (c) => { c.services.gateway.volumes = ['oshal_workspace:/app/workspace-shared:rw']; }, /gateway: mounts a volume/],
    ['gateway running something else', (c) => { c.services.gateway.entrypoint = ['node', 'dist/app/server.js']; }, /gateway: its entrypoint is not the forwarder/],
    ['no gateway', (c) => { delete c.services.gateway; }, /the sandbox has no gateway/],
    ['backend with egress', (c) => { c.networks.backend.internal = false; }, /must be internal/],
    ['bind mount of the shared tree', (c) => { c.services.api.volumes.push('./any-bot/server:/app/any-bot/server:ro'); }, /bind mounts are refused/],
    ['docker socket', (c) => { c.services.api.volumes.push('/var/run/docker.sock:/var/run/docker.sock'); }, /docker socket/],
    ['live workspace volume by name', (c) => { c.volumes.oshal_workspace.name = 'oshal-local_oshal_workspace'; }, /explicit name/],
    ['live Redis hostname', (c) => { c.services.api.environment.REDIS_URL = 'redis://oshal-redis:6379'; }, /live host "oshal-redis"/],
    ['literal secret', (c) => { c.services.api.environment.SESSION_SECRET = 'plain-value'; }, /holds a literal/],
    ['credential in a URL', (c) => { c.services.api.environment.ANALYTICS_URL = 'postgresql://oshal:oshal@db:5432/oshal'; }, /embeds a credential/],
    ['monitoring tier label', (c) => { c.services.api.labels['oshal.tier'] = 'core'; }, /oshal\.tier/],
    ['non-loopback publish', (c) => { c.services.gateway.ports = ['0.0.0.0:35459:5000']; }, /not bound to 127\.0\.0\.1/],
    ['live port', (c) => { c.services.gateway.ports = ['127.0.0.1:35457:5000']; }, /collides with a live published port/],
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

  it('refuses a database on the egress network even when a credential is forwarded', () => {
    const built = build({ bots: ['career-bot'], forwardNames: ['FIXTURE_PROVIDER_KEY'] });
    const compose = JSON.parse(JSON.stringify(built.compose));
    compose.services.redis.networks.egress = {};
    compose.services.gateway.networks.egress = {};
    expect(plan.isolationProblems(compose, built)).toEqual([
      'redis: only the api and the bots may join the egress network',
      'gateway: only the api and the bots may join the egress network',
    ]);
  });

  it('judges the in-container probe', () => {
    const expectation = { hazards: ['oshal-redis', 'host.docker.internal'], aliases: ['career-bot'], sandboxIps: ['172.30.0.4'], egress: false };
    const clean = { resolved: { 'oshal-redis': null, 'host.docker.internal': ['127.0.0.1'], 'career-bot': ['172.30.0.4'] }, connects: { 'host.docker.internal:56380': 'ECONNREFUSED', '172.18.0.5:6379': 'ENETUNREACH' }, defaultRoutes: [] as string[] };
    expect(plan.evaluateIsolationProbe(clean, expectation)).toEqual([]);
    expect(plan.evaluateIsolationProbe({ ...clean, resolved: { ...clean.resolved, 'oshal-redis': ['172.18.0.5'] } }, expectation).join()).toMatch(/live name oshal-redis resolves/);
    expect(plan.evaluateIsolationProbe({ ...clean, resolved: { ...clean.resolved, 'career-bot': ['172.18.0.9'] } }, expectation).join()).toMatch(/resolves outside the sandbox/);
    expect(plan.evaluateIsolationProbe({ ...clean, connects: { 'host.docker.internal:56380': 'open' } }, expectation).join()).toMatch(/accepted a connection/);
    expect(plan.evaluateIsolationProbe({ resolved: {}, connects: {}, defaultRoutes: [] }, expectation).join()).toMatch(/did not report oshal-redis/);
  });

  it('judges routes by address: a default route, and a live container answering on its own address', () => {
    const expectation = { hazards: [] as string[], aliases: [] as string[], sandboxIps: [] as string[], egress: false };
    const routed = { resolved: {}, connects: { '172.18.0.5:6379': 'ENETUNREACH' }, defaultRoutes: ['172.22.0.1'] };
    expect(plan.evaluateIsolationProbe(routed, expectation)).toEqual(['has a default route (172.22.0.1) although it must sit on the internal network only']);
    expect(plan.evaluateIsolationProbe(routed, { ...expectation, egress: true })).toEqual([]);
    const answered = { ...routed, connects: { '172.18.0.5:6379': 'open', '192.168.65.254:56380': 'open', '172.18.0.9:5000': 'timeout' } };
    expect(plan.evaluateIsolationProbe(answered, { ...expectation, egress: true })).toEqual([
      '172.18.0.5:6379 accepted a connection from the sandbox', '192.168.65.254:56380 accepted a connection from the sandbox',
    ]);
    expect(plan.evaluateIsolationProbe({ resolved: {}, connects: {} }, expectation)).toEqual(['probe did not report its default routes']);
  });

  it('turns the running live containers into address targets', () => {
    const rows = ['172.18.0.5 |6379/tcp ', '172.18.0.9 172.19.0.3 |1455/tcp 5000/tcp 5353/udp ', ' |5000/tcp ', '172.18.0.5 |6379/tcp '];
    expect(plan.parseLiveAddresses(rows)).toEqual([
      { host: '172.18.0.5', port: 6379 }, { host: '172.18.0.9', port: 1455 }, { host: '172.18.0.9', port: 5000 },
      { host: '172.19.0.3', port: 1455 }, { host: '172.19.0.3', port: 5000 },
    ]);
    expect(plan.parseLiveAddresses([])).toEqual([]);
  });
});

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** fetch, retried while the listener is still starting. An exchange that is never answered fails, so teardown still runs. */
async function fetchWhenUp(url: string, init: RequestInit, budgetMs = 60_000): Promise<Response> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('the gateway forwarder as a real child process', () => {
  it('relays an HTTP exchange unchanged: the caller\'s Host and Origin in, the session cookie out', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'oshal_local=fixture; Path=/; HttpOnly' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const listen = await freePort();
    const script = plan.forwarderScript('127.0.0.1', (upstream.address() as net.AddressInfo).port, listen, '127.0.0.1');
    const child: ChildProcess = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    try {
      const origin = `http://127.0.0.1:${listen}`;
      const res = await fetchWhenUp(`${origin}/api/local-auth/bootstrap`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }, 20_000);
      expect(res.status).toBe(201);
      expect(res.headers.getSetCookie()).toEqual(['oshal_local=fixture; Path=/; HttpOnly']);
      expect(await res.json()).toEqual({ ok: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ host: `127.0.0.1:${listen}`, origin });
    } finally {
      child.kill();
      upstream.close();
    }
  }, 30_000);
});

/** The shipped probe script run by a throwaway container of the sandbox image on one network. */
function probeFrom(image: string, network: string, labels: string[], input: unknown): any {
  const env = { ...cli.scrubbedEnv(process.env), OSHAL_SANDBOX_PROBE: JSON.stringify(input) };
  const result = spawnSync('docker', ['run', '--rm', '--network', network, '--memory', '96m', ...labels, '-e', 'OSHAL_SANDBOX_PROBE',
    '--entrypoint', 'node', image, '-e', cli.PROBE_SCRIPT], { encoding: 'utf8', env, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`probe on ${network} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('the probe on the real Docker engine', () => {
  it('finds no route from an internal network, and a default route and an answering address from an ordinary one', async () => {
    const image = plan.resolveComposeDefaults(LIVE.services['oshal-api'].image).value;
    const have = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' });
    if (have.status !== 0) throw new Error(`this guard needs the image the sandbox runs (${image}): ${have.stderr}`);
    const project = `oshal-sandbox-probe${crypto.randomBytes(3).toString('hex')}`;
    const labels = ['--label', `com.docker.compose.project=${project}`, '--label', `oshal.sandbox.project=${project}`];
    const must = (...args: string[]): string => {
      const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
      if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const slot = await acquireFixtureSlot('installed-sandbox:probe');
    const out: string[] = [];
    let teardown = -1;
    try {
      must('network', 'create', '--internal', ...labels, `${project}_backend`);
      must('network', 'create', ...labels, `${project}_egress`);
      must('run', '-d', '--name', `${project}-outside`, '--network', `${project}_egress`, '--memory', '96m', ...labels,
        '--entrypoint', 'node', image, '-e', "require('net').createServer((s)=>s.end()).listen(8080)");
      const address = must('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', `${project}-outside`);
      const input = { names: [`${project}-outside`], connects: [{ host: address, port: 8080 }], hostAliases: [], hostPorts: [] };
      const expectation = { hazards: [`${project}-outside`], aliases: [], sandboxIps: [], egress: false };
      const inside = probeFrom(image, `${project}_backend`, labels, input);
      expect(inside.defaultRoutes).toEqual([]);
      expect(inside.connects[`${address}:8080`]).not.toBe('open');
      expect(plan.evaluateIsolationProbe(inside, expectation)).toEqual([]);
      const routed = probeFrom(image, `${project}_egress`, labels, input);
      expect(routed.defaultRoutes).toHaveLength(1);
      expect(plan.evaluateIsolationProbe(routed, expectation).join('\n')).toMatch(new RegExp(
        `live name ${project}-outside resolves from the sandbox[\\s\\S]*has a default route[\\s\\S]*${address.replace(/\./g, '\\.')}:8080 accepted a connection`));
    } finally {
      const deps = { ...cli.realDeps(), out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
      teardown = await cli.main(['down', '--name', project, '--state-root', tmp('probe-state')], deps);
      slot.release();
    }
    expect(out.join('\n')).toMatch(new RegExp(`CLEAN[\\s\\S]*removed containers: ${project}-outside[\\s\\S]*removed networks: ${project}_`));
    expect(teardown).toBe(cli.EXIT.ok);
  }, 240_000);
});

/** Answers every request with the Host it was sent and the routing table of its own container. */
const STAND_IN_API = "process.on('SIGTERM',()=>process.exit(0));require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');"
  + "res.end(JSON.stringify({host:req.headers.host,routes:require('fs').readFileSync('/proc/net/route','utf8')}))}).listen(5000)";

/** The generated gateway, networks and hardening, with a stand-in for the api (no database, no Redis). */
function standInDocument(built: Plan): Record<string, unknown> {
  const { command: _command, environment: _environment, volumes: _volumes, depends_on: _dependsOn, ...api } = built.compose.services.api;
  return {
    name: built.compose.name, networks: built.compose.networks,
    services: { api: { ...api, entrypoint: ['node', '-e', STAND_IN_API], mem_limit: '96m' }, gateway: built.compose.services.gateway },
  };
}

describe('the gateway on the real Docker engine, through the real docker compose', () => {
  it('serves a stand-in api that sits on the internal network only, and down removes the whole project', async () => {
    const project = `oshal-sandbox-gw${crypto.randomBytes(3).toString('hex')}`;
    const built = build({ project, port: await freePort() });
    const stateRoot = tmp('gateway-state');
    const dir = path.join(stateRoot, project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.json'), JSON.stringify(standInDocument(built)));
    const slot = await acquireFixtureSlot('installed-sandbox:gateway');
    const out: string[] = [];
    let teardown = -1;
    let answer: { host?: string; routes?: string } = {};
    try {
      const up = spawnSync('docker', ['compose', '-p', project, '-f', path.join(dir, 'compose.json'), '--project-directory', dir, 'up', '-d'],
        { encoding: 'utf8', env: cli.scrubbedEnv(process.env), cwd: dir, timeout: 180_000 });
      expect(up.status, up.stderr).toBe(0);
      answer = await (await fetchWhenUp(`${built.origin}/health`, { headers: { accept: 'application/json' } })).json();
    } finally {
      const deps = { ...cli.realDeps(), out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
      teardown = await cli.main(['down', '--name', project, '--state-root', stateRoot], deps);
      slot.release();
    }
    expect(answer.host).toBe(new URL(built.origin).host);
    const routes = String(answer.routes).split('\n').slice(1).filter(Boolean).map((line) => line.split('\t')[1]);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).not.toContain('00000000');
    expect(out.join('\n')).toMatch(new RegExp(`CLEAN[\\s\\S]*removed containers: .*${project}-api-1[\\s\\S]*removed networks: .*${project}_backend`));
    expect(teardown).toBe(cli.EXIT.ok);
    expect(fs.existsSync(dir)).toBe(false);
  }, 300_000);
});

/** Dependency double for the CLI: a recording docker seam, a fixed host free figure, no network. */
function recordingDeps(respond: (args: string[], options?: { env?: Record<string, string> }) => { status: number; stdout: string; stderr?: string }, freeMb = 8192) {
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stateRoot = tmp('state');
  const deps = {
    spawnSync: (cmd: string, args: string[], options?: { env?: Record<string, string> }) => { calls.push([cmd, ...args]); return { stderr: '', ...respond(args, options) }; },
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

/** A docker seam for `status`: a running sandbox with one bot beside one running live container. */
function statusHarness(probeResult: (container: string) => unknown) {
  const project = 'oshal-sandbox-spec-status';
  const probes: Array<{ container: string; input: any }> = [];
  const harness = recordingDeps((args, options) => {
    const text = args.join(' ');
    if (args[0] === 'exec') {
      probes.push({ container: args[3], input: JSON.parse(options!.env!.OSHAL_SANDBOX_PROBE) });
      return { status: 0, stdout: JSON.stringify(probeResult(args[3])) };
    }
    if (args[0] === 'inspect') return { status: 0, stdout: text.includes('ExposedPorts') ? '172.18.0.5 |6379/tcp \n' : '172.30.0.4 172.30.0.5 \n' };
    if (text.includes(`project=${LIVE.name}`)) return { status: 0, stdout: 'live-only-container\n' };
    const service = /com\.docker\.compose\.service=(\S+)/.exec(text);
    if (service) return { status: 0, stdout: `${project}-${service[1]}-1\n` };
    if (args[1] === '-a') return { status: 0, stdout: `${project}-api-1|running|Up\n${project}-career-bot-1|running|Up\n` };
    return { status: 0, stdout: `${project}-api-1\n${project}-career-bot-1\n` };
  });
  const built = build({ project, bots: ['career-bot'] });
  const dir = path.join(harness.stateRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sandbox.json'), JSON.stringify({
    project, url: built.origin, hazards: built.hazards, aliases: built.aliases, liveProject: LIVE.name, egress: built.egress,
    probeServices: built.probeServices, publishedLivePorts: built.topology.publishedPorts,
  }));
  const health: Array<RequestInit | undefined> = [];
  const deps = { ...harness.deps, fetch: async (_url: string, init?: RequestInit) => { health.push(init); return { status: 200 }; } };
  return { harness, probes, health, project, run: () => cli.main(['status', '--name', project, '--state-root', harness.stateRoot], deps) };
}

describe('status probes by address', () => {
  const clean = { resolved: {}, connects: { '172.18.0.5:6379': 'ENETUNREACH' }, defaultRoutes: [] };

  it('hands every running live container\'s address and the live published ports to the probe, in the api and in each bot', async () => {
    const status = statusHarness(() => ({ ...clean, resolved: Object.fromEntries([...build({ bots: ['career-bot'] }).hazards, 'live-only-container'].map((name) => [name, null])) }));
    expect(await status.run(), status.harness.err.join('\n')).toBe(cli.EXIT.ok);
    expect(status.probes.map((probe) => probe.container)).toEqual([`${status.project}-api-1`, `${status.project}-career-bot-1`]);
    expect(status.health.map((init) => init?.signal instanceof AbortSignal)).toEqual([true]);
    for (const probe of status.probes) {
      expect(probe.input.connects).toEqual([{ host: '172.18.0.5', port: 6379 }]);
      expect(probe.input.hostPorts).toEqual(plan.readLiveTopology(LIVE).publishedPorts);
      expect(probe.input.hostAliases).toEqual(['host.docker.internal', 'gateway.docker.internal']);
      expect(probe.input.names).toContain('live-only-container');
    }
    expect(status.harness.out.join('\n')).toMatch(/isolation probe from api, career-bot: \d+ live names unresolved, 2 knocks refused \(1 live container addresses, the live published ports on the host\), no default route/);
  });

  it('is red when a live address answers from a bot, and names the bot and the address', async () => {
    const hazards = Object.fromEntries([...build({ bots: ['career-bot'] }).hazards, 'live-only-container'].map((name) => [name, null]));
    const status = statusHarness((container) => ({ ...clean, resolved: hazards, connects: { '172.18.0.5:6379': container.includes('career-bot') ? 'open' : 'ENETUNREACH' } }));
    expect(await status.run()).toBe(cli.EXIT.failed);
    expect(status.harness.err.join('\n')).toMatch(/career-bot: 172\.18\.0\.5:6379 accepted a connection from the sandbox/);
    expect(status.harness.err.join('\n')).not.toMatch(/api: 172/);
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
    expect(result.stdout).toMatch(/RAM guard: sandbox budget 2776 MB \+ host reserve 1024 MB = floor 3800 MB host free/);
    expect(result.stdout).toMatch(/network backend \(internal: no egress, no host route\): db, redis, api, gateway, career-bot/);
    expect(result.stdout).toMatch(/network edge \(the loopback publish; the gateway forwards to api:5000 and holds nothing else\): gateway\n/);
    expect(result.stdout).toMatch(/network egress \(PROVIDER EGRESS ON - it has a host route; up refuses while any live address answers\): api, career-bot\n/);
    expect(result.stdout).toMatch(/service gateway: .* publish 127\.0\.0\.1:35459:5000; volumes none; env 0 keys/);
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

  it('refuses a door that takes the request and never answers, instead of waiting', async () => {
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`;
    try {
      const call = ids.createClient(origin, fetch, 400)('GET', '/api/auth/user');
      call.catch(() => undefined);
      const stillWaiting = new Promise((_, reject) => { setTimeout(() => reject(new Error('the call was still waiting after 3 s')), 3_000); });
      await expect(Promise.race([call, stillWaiting])).rejects.toThrow(/GET \/api\/auth\/user was not answered within 400 ms/);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
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
