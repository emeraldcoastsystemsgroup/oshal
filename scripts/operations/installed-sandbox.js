#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation: a disposable installed-image sandbox for two-identity acceptance (backlog entries #1, #2, #23) that writes nothing to the live box. Run from the HOST only - `docker compose` run inside the api inherits COMPOSE_PROJECT_NAME and joins the core project. `up` builds the plan from the image's own compose file (the api boot command, service definitions and defaults the running image ships), refuses on any static isolation problem or below the stated RAM floor, starts PostgreSQL and Redis on an internal network, stages the requested store (git ref, default origin/main) and private (by path) package commits into the sandbox workspace volume, boots the api under authorization enforce, probes from inside it that no live name resolves and no live published port answers, registers the fake users through the real installer-proof/invite/accept/login flow, writes their sessions and tokens BY NAME to a mode-600 env file, checks each package is active at its version under enforce, then starts the named bot nodes. Secrets reach compose only through its process environment. `status` reports containers, health and a fresh isolation probe; `down` removes containers, volumes and networks by project label and prints a receipt that is red if anything is left. `--dry-run` prints the plan. Results are labelled installed-sandbox.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The probe now tests addresses, not only names. The first cut resolved live names and knocked on the live published ports through host.docker.internal, which every sandbox service pins to its own loopback, so that knock could never answer; a measurement on this engine showed that the address behind the alias, and a container on another bridge by its own address, both answer from a network with a host route. The probe therefore also reads the container's default routes, asks the resolver directly for the host aliases (which bypasses the pin) and knocks on the live published ports there, and knocks on every address and exposed TCP port of the running live containers, in parallel. It runs in the api before any identity exists and in each bot once it is healthy; `status` runs it in both. The api is reached through the gateway service, which `up` creates and starts with the api. With a forwarded credential the plan, the manifest and the report say that provider egress is on. Each /health request is bounded at 10 s: a gateway that accepted the connection and never answered made the wait endless, and a wait is not a failure, so nothing was torn down.
 *
 * Usage (host shell, from a core checkout whose node_modules resolve):
 *   node scripts/operations/installed-sandbox.js up [--dry-run] [--print-compose] [--name <suffix>] [--port 35459]
 *        [--image <tag>] [--package <name>[@<version>]]... [--store-repo <store clone>] [--store-ref origin/main]
 *        [--private-package <package dir>[@<version>]]... [--private-ref origin/main] [--bot <live bot service>]...
 *        [--user <label>]... [--llm-provider noop] [--llm-model <id>] [--forward-env <NAME>]... [--operator-env <.env>]
 *        [--set-env KEY=VALUE]... [--state-root <dir>] [--host-reserve-mb 1024] [--keep-on-failure]
 *   node scripts/operations/installed-sandbox.js status --name <project>
 *   node scripts/operations/installed-sandbox.js down --name <project> [--dry-run]
 * Exit codes: 0 ok, 1 failed, 2 usage, 3 RAM guard refused, 4 isolation refused, 5 teardown left something behind.
 */
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { loadComposeYaml } = require('../lib/compose-yaml');
const sandbox = require('../lib/installed-sandbox-plan');
const packages = require('../lib/installed-sandbox-packages');
const identities = require('../lib/installed-sandbox-identities');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TAG = `[${sandbox.EVIDENCE_LABEL}]`;
const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, ram: 3, isolation: 4, leftover: 5 });
const LIVE_COMPOSE = 'docker-compose.oshal-local.yml';
const IMAGE_COMPOSE_PATH = '/app/docker-compose.oshal-local.yml';
const PROJECT_PREFIX = 'oshal-sandbox-';
const TIMEOUTS = Object.freeze({ infraMs: 180000, apiMs: 420000, autoLoadMs: 420000, botMs: 420000, pollMs: 3000, healthRequestMs: 10000 });
const SINGLE = new Set(['--name', '--port', '--image', '--store-repo', '--store-ref', '--private-ref', '--llm-provider', '--llm-model', '--operator-env', '--state-root', '--host-reserve-mb']);
const MULTI = new Set(['--package', '--private-package', '--bot', '--user', '--forward-env', '--set-env']);
const FLAGS = new Set(['--dry-run', '--keep-on-failure', '--print-compose']);
/** One line per live container: its addresses, then the ports its image exposes. */
const LIVE_ADDRESS_FORMAT = '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}|{{range $port, $_ := .Config.ExposedPorts}}{{$port}} {{end}}';
/**
 * Runs inside a sandbox container. It resolves every name the way the application would, reads the
 * default routes, asks the resolver directly for the host aliases (the pin in the hosts file does
 * not apply there) and knocks on every target in parallel: the given addresses, and the live
 * published ports on the host aliases and on the addresses behind them.
 */
const PROBE_SCRIPT = [
  "const dns=require('dns').promises;const net=require('net');const fs=require('fs');const input=JSON.parse(process.env.OSHAL_SANDBOX_PROBE);",
  'const look=async(n)=>{try{return (await dns.lookup(n,{all:true})).map((a)=>a.address)}catch(e){return null}};',
  'const direct=async(n)=>{try{return await dns.resolve4(n)}catch(e){return []}};',
  "const knock=(host,port)=>new Promise((r)=>{const s=net.connect({host,port,timeout:1500});s.on('connect',()=>{s.destroy();r('open')});s.on('timeout',()=>{s.destroy();r('timeout')});s.on('error',(e)=>r(e.code||'error'))});",
  "const routes=()=>fs.readFileSync('/proc/net/route','utf8').split(String.fromCharCode(10)).slice(1).map((l)=>l.split(String.fromCharCode(9))).filter((c)=>c[1]==='00000000').map((c)=>c[2].match(/../g).reverse().map((h)=>parseInt(h,16)).join('.'));",
  '(async()=>{const resolved={};await Promise.all(input.names.map(async(n)=>{resolved[n]=await look(n)}));',
  'const hosts=new Set(input.hostAliases);for(const n of input.hostAliases){for(const ip of await direct(n))hosts.add(ip)}',
  'const targets=[...input.connects];for(const host of hosts){for(const port of input.hostPorts)targets.push({host,port})}',
  "const connects={};await Promise.all(targets.map(async(t)=>{connects[t.host+':'+t.port]=await knock(t.host,t.port)}));",
  'process.stdout.write(JSON.stringify({resolved,connects,defaultRoutes:routes()}))})();',
].join('');

class UsageError extends Error {}
class IsolationError extends Error {
  /** @param {string[]} problems Isolation problems. */
  constructor(problems) { super(`isolation refused: ${problems.length} problem(s)`); this.problems = problems; }
}

/** @description Parse argv into raw single/multi/flag buckets. @param {string[]} argv Arguments after the script. @returns {object} Raw options. */
function parseRaw(argv) {
  const [command, ...rest] = argv;
  const raw = { command, single: {}, multi: {}, flags: new Set() };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (FLAGS.has(arg)) { raw.flags.add(arg); continue; }
    if (!SINGLE.has(arg) && !MULTI.has(arg)) throw new UsageError(`unknown argument ${arg}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    index += 1;
    if (MULTI.has(arg)) (raw.multi[arg] = raw.multi[arg] || []).push(value);
    else if (arg in raw.single) throw new UsageError(`${arg} given twice`);
    else raw.single[arg] = value;
  }
  if (!['up', 'down', 'status'].includes(command)) throw new UsageError('the command must be up, down or status');
  return raw;
}

/** @description Numeric option or undefined. @param {string|undefined} text Value. @param {string} flag Flag. @returns {number|undefined} Number. */
function numberOption(text, flag) {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new UsageError(`${flag} needs a whole number`);
  return Number(text);
}

/**
 * @description Parse and validate the command line.
 * @param {string[]} argv Arguments after the script name. @returns {object} Options.
 */
function parseArgs(argv) {
  const raw = parseRaw(argv);
  const setEnv = {};
  for (const pair of raw.multi['--set-env'] || []) {
    const at = pair.indexOf('=');
    if (at <= 0 || !/^[A-Z][A-Z0-9_]*$/.test(pair.slice(0, at))) throw new UsageError(`--set-env needs KEY=VALUE (got ${pair.split('=')[0]})`);
    setEnv[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const forwardNames = raw.multi['--forward-env'] || [];
  for (const name of forwardNames) if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new UsageError(`invalid --forward-env name ${name}`);
  if (raw.command !== 'up' && !raw.single['--name']) throw new UsageError(`${raw.command} needs --name <project>`);
  return {
    command: raw.command, dryRun: raw.flags.has('--dry-run'), keepOnFailure: raw.flags.has('--keep-on-failure'), printCompose: raw.flags.has('--print-compose'),
    name: raw.single['--name'], port: numberOption(raw.single['--port'], '--port'), image: raw.single['--image'],
    storeRepo: raw.single['--store-repo'], storeRef: raw.single['--store-ref'] || 'origin/main', privateRef: raw.single['--private-ref'] || 'origin/main',
    packages: raw.multi['--package'] || [], privatePackages: raw.multi['--private-package'] || [], bots: raw.multi['--bot'] || [],
    users: raw.multi['--user'] || [], forwardNames, setEnv, llmProvider: raw.single['--llm-provider'] || 'noop', llmModel: raw.single['--llm-model'],
    operatorEnv: raw.single['--operator-env'], stateRoot: raw.single['--state-root'], hostReserveMb: numberOption(raw.single['--host-reserve-mb'], '--host-reserve-mb'),
  };
}

/** @description The environment a child docker/git process gets: never the caller's COMPOSE_* or sandbox values. @param {object} env Parent env. @returns {object} Scrubbed env. */
function scrubbedEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^COMPOSE_/i.test(key) && !key.startsWith('OSHAL_SANDBOX_')));
}

/** @description Run a command synchronously. @param {object} deps Deps. @param {string} command Binary. @param {string[]} args Args. @param {object} [options] { env, timeoutMs, cwd }. @returns {{status: number, stdout: string, stderr: string}} Result. */
function run(deps, command, args, options = {}) {
  const result = deps.spawnSync(command, args, {
    encoding: 'utf8', env: options.env || scrubbedEnv(deps.env), timeout: options.timeoutMs || 120000, maxBuffer: 64 * 1024 * 1024,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  return { status: result.error ? -1 : result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || (result.error && result.error.message) || '') };
}

/** @description First non-empty line. @param {string} text Text. @returns {string} Line. */
function firstLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'no output';
}

/** @description Non-empty trimmed lines. @param {string} text Text. @returns {string[]} Lines. */
function lines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** @description Run and require exit 0. @param {object} deps Deps. @param {string} command Binary. @param {string[]} args Args. @param {object} [options] Options. @returns {string} Stdout. */
function mustRun(deps, command, args, options) {
  const result = run(deps, command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${firstLine(result.stderr)}`);
  return result.stdout;
}

/** @description Docker objects labelled with a compose project. @param {object} deps Deps. @param {string} project Project. @returns {{containers: string[], volumes: string[], networks: string[]}} Inventory. */
function inventory(deps, project) {
  const filter = `label=com.docker.compose.project=${project}`;
  return {
    containers: lines(mustRun(deps, 'docker', ['ps', '-a', '--filter', filter, '--format', '{{.Names}}'])),
    volumes: lines(mustRun(deps, 'docker', ['volume', 'ls', '--filter', filter, '--format', '{{.Name}}'])),
    networks: lines(mustRun(deps, 'docker', ['network', 'ls', '--filter', filter, '--format', '{{.Name}}'])),
  };
}

/** @description The one container of a sandbox service. @param {object} deps Deps. @param {string} project Project. @param {string} service Service key. @returns {string} Container name. */
function containerFor(deps, project, service) {
  const names = lines(mustRun(deps, 'docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.Names}}']));
  if (names.length !== 1) throw new Error(`expected one ${service} container in ${project}, found ${names.length}`);
  return names[0];
}

/** @description State paths for a project. @param {object} opts Options. @param {object} deps Deps. @param {string} project Project. @returns {object} State. */
function stateFor(opts, deps, project) {
  const root = path.resolve(opts.stateRoot || deps.env.OSHAL_INSTALLED_SANDBOX_ROOT || path.join(deps.tmpdir(), 'oshal-installed-sandbox'));
  const dir = path.join(root, project);
  return { project, root, dir, composeFile: path.join(dir, 'compose.json'), manifestFile: path.join(dir, 'sandbox.json'), credentialsFile: path.join(dir, 'credentials.env') };
}

/**
 * @description `docker compose` for the sandbox project with the given reference values. It runs in
 * the state directory, never in a checkout whose `.env` holds the operator's live settings.
 * @param {object} deps Deps. @param {object} state State. @param {string[]} args Compose args.
 * @param {Map<string,string>} values Reference values. @param {number} timeoutMs Timeout. @returns {string} Stdout.
 */
function composeRun(deps, state, args, values, timeoutMs) {
  const env = { ...scrubbedEnv(deps.env), ...Object.fromEntries(values) };
  return mustRun(deps, 'docker', ['compose', '-p', state.project, '-f', state.composeFile, '--project-directory', state.dir, ...args], { env, timeoutMs, cwd: state.dir });
}

/** @description Normalize --name to a sandbox project (refuses anything else, e.g. the live project). @param {string} name Name or suffix. @returns {string} Project. */
function projectName(name) {
  return sandbox.validateProjectName(String(name).startsWith(PROJECT_PREFIX) ? name : `${PROJECT_PREFIX}${name}`);
}

/**
 * @description Read only the named keys from the operator .env; a missing or empty name refuses.
 * Values are returned under their sandbox reference names and are never printed.
 * @param {object} fsImpl fs. @param {string} file Env file. @param {string[]} names Names to forward.
 * @returns {Map<string,string>} OSHAL_SANDBOX_FWD_<NAME> -> value.
 */
function readEnvFileValues(fsImpl, file, names) {
  if (!fsImpl.existsSync(file)) throw new UsageError(`no operator env file at ${file} (pass --operator-env)`);
  const found = new Map();
  for (const line of fsImpl.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !names.includes(match[1])) continue;
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    found.set(match[1], value);
  }
  const missing = names.filter((name) => !found.get(name));
  if (missing.length) throw new UsageError(`not set in ${file}: ${missing.join(', ')}`);
  return new Map(names.map((name) => [`OSHAL_SANDBOX_FWD_${name}`, found.get(name)]));
}

/** @description Store clone to resolve store packages in. @param {object} opts Options. @param {object} deps Deps. @returns {string} Directory. */
function resolveStoreDir(opts, deps) {
  const candidate = path.resolve(opts.storeRepo || deps.env.OSHAL_STORE_DIR || path.join(REPO_ROOT, '..', 'oshal-applications'));
  if (!deps.fs.existsSync(path.join(candidate, '.git'))) throw new UsageError(`no store clone at ${candidate} (pass --store-repo <clone of the store repository>)`);
  return candidate;
}

/** @description Stage every requested package at its commit and resolve dependency tiers. @param {object} opts Options. @param {object} deps Deps. @returns {{staged: object[], resolution: Map}} Packages. */
function stagePackages(opts, deps) {
  const git = packages.createGit(deps.spawnSync);
  const staged = [];
  if (opts.packages.length) {
    const storeDir = resolveStoreDir(opts, deps);
    for (const text of opts.packages) staged.push(packages.stageStorePackage(git, { storeDir, ref: opts.storeRef }, packages.parsePackageSpec(text)));
  }
  for (const text of opts.privatePackages) staged.push(packages.stagePrivatePackage(git, packages.parsePrivateSpec(text), opts.privateRef));
  const isCoreApp = (name) => deps.fs.existsSync(path.join(REPO_ROOT, 'swarm-apps', `${name}.yaml`));
  return { staged, resolution: packages.resolveStagedDependencies(staged, isCoreApp) };
}

/** @description Build the plan from a compose document. @param {object} opts Options. @param {object} ctx { liveDoc, project, users }. @returns {object} Plan. */
function buildPlan(opts, ctx) {
  return sandbox.buildSandboxPlan({
    liveDoc: ctx.liveDoc, project: ctx.project, port: opts.port, image: opts.image || opts.envImage, bots: opts.bots,
    admin: { email: ctx.users[0].email, sub: ctx.users[0].sub }, llmProvider: opts.llmProvider, llmModel: opts.llmModel,
    forwardNames: opts.forwardNames, setEnv: opts.setEnv, delegationKid: `sandbox-${ctx.project.slice(PROJECT_PREFIX.length)}`,
    hostReserveMb: opts.hostReserveMb,
  });
}

/** @description Refuse a plan with any static isolation problem. @param {object} plan Plan. @returns {object} The plan. */
function assertIsolated(plan) {
  const problems = sandbox.isolationProblems(plan.compose, plan);
  if (problems.length) throw new IsolationError(problems);
  return plan;
}

/** @description Everything `up` needs before touching Docker. @param {object} opts Options. @param {object} deps Deps. @returns {object} Prepared context. */
function prepareUp(opts, deps) {
  const liveDoc = loadComposeYaml(deps.fs.readFileSync(path.join(REPO_ROOT, LIVE_COMPOSE), 'utf8'));
  const project = opts.name ? projectName(opts.name) : sandbox.mintProjectName(deps.randomBytes);
  const users = identities.sandboxUsers(opts.users, deps.randomBytes);
  const { staged, resolution } = stagePackages(opts, deps);
  const operatorEnv = opts.operatorEnv || deps.env.OSHAL_OPERATOR_ENV_FILE || path.join(REPO_ROOT, '.env');
  const forwarded = opts.forwardNames.length ? readEnvFileValues(deps.fs, operatorEnv, opts.forwardNames) : new Map();
  const withImage = { ...opts, envImage: deps.env.OSHAL_BOT_IMAGE };
  const plan = assertIsolated(buildPlan(withImage, { liveDoc, project, users }));
  return { opts: withImage, project, users, staged, resolution, forwarded, operatorEnv, plan, state: stateFor(opts, deps, project) };
}

/** @description Memory readings for the guard. @param {object} deps Deps. @returns {object} { hostFreeMb, engineTotalMb, engineUsedMb }. */
function readMemory(deps) {
  const info = run(deps, 'docker', ['info', '--format', '{{.MemTotal}}'], { timeoutMs: 30000 });
  const stats = run(deps, 'docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}'], { timeoutMs: 60000 });
  const total = Number(info.stdout.trim());
  return {
    hostFreeMb: deps.freemem() / 1048576,
    engineTotalMb: info.status === 0 && total > 0 ? total / 1048576 : NaN,
    engineUsedMb: stats.status === 0 ? sandbox.parseDockerMemUsage(stats.stdout) : NaN,
  };
}

/** @description Evaluate the stated RAM floor now. @param {object} plan Plan. @param {object} deps Deps. @returns {object} Verdict plus reading. */
function ramVerdict(plan, deps) {
  const reading = readMemory(deps);
  return { reading, ...sandbox.evaluateRamGuard({ ...reading, budgetMb: plan.budgetMb, hostReserveMb: plan.hostReserveMb }) };
}

/** @description Printable RAM lines. @param {object} plan Plan. @param {object} verdict Verdict. @returns {string[]} Lines. */
function ramLines(plan, verdict) {
  const mb = (value) => (Number.isFinite(value) ? `${Math.round(value)} MB` : 'unavailable');
  return [
    `RAM guard: sandbox budget ${plan.budgetMb} MB + host reserve ${plan.hostReserveMb} MB = floor ${plan.budgetMb + plan.hostReserveMb} MB host free; engine headroom must be >= ${plan.budgetMb} MB`,
    `RAM now: host free ${mb(verdict.reading.hostFreeMb)}, engine total ${mb(verdict.reading.engineTotalMb)}, engine in use ${mb(verdict.reading.engineUsedMb)} -> ${verdict.ok ? 'PASS' : 'REFUSE'}`,
    ...verdict.reasons.map((reason) => `  ${reason}`),
  ];
}

/** @description Network/service summary lines for a plan. @param {object} plan Plan. @returns {string[]} Lines. */
function topologyLines(plan) {
  const on = (network) => Object.entries(plan.compose.services).filter(([, service]) => Object.keys(service.networks || {}).includes(network)).map(([name]) => name);
  const out = [
    `network backend (internal: no egress, no host route): ${on('backend').join(', ')}`,
    `network edge (the loopback publish; the gateway forwards to api:${sandbox.API_PORT} and holds nothing else): ${on('edge').join(', ')}`,
    plan.egress
      ? `network egress (PROVIDER EGRESS ON - it has a host route; up refuses while any live address answers): ${on('egress').join(', ')}`
      : 'network egress: none (no credential is forwarded)',
  ];
  for (const [name, service] of Object.entries(plan.compose.services)) {
    const aliases = (service.networks.backend && service.networks.backend.aliases) || [];
    out.push(`service ${name}: ${service.image} mem ${service.mem_limit}${service.ports ? ` publish ${service.ports.join(',')}` : ''}${aliases.length ? ` answers ${aliases.join(',')} in-sandbox` : ''}; volumes ${(service.volumes || []).map((mount) => mount.split(':')[0]).join(',') || 'none'}; env ${Object.keys(service.environment || {}).length} keys`);
  }
  return out;
}

/** @description Dry-run report lines (names only, never a value). @param {object} prepared Prepared context. @returns {string[]} Lines. */
function planLines(prepared) {
  const { plan, users, staged, resolution, forwarded } = prepared;
  const credentialNames = users.flatMap((user) => identities.CREDENTIAL_FIELDS.map((field) => identities.credentialName(user.label, field)));
  return [
    `project ${plan.project} (label ${sandbox.SANDBOX_LABEL}=${sandbox.EVIDENCE_LABEL}); image ${plan.image}; url ${plan.origin}`,
    ...topologyLines(plan),
    `isolation: 0 static problems; ${plan.hazards.length} live names must never resolve; no live address may answer from ${plan.probeServices.join(', ')}; in-sandbox aliases ${plan.aliases.join(', ')}`,
    `secrets by name (generated at up, given to docker compose only through its process environment): ${plan.secretRefs.filter((name) => !name.startsWith('OSHAL_SANDBOX_FWD_')).join(', ')}`,
    `forwarded by name from ${prepared.operatorEnv}: ${plan.forwardNames.length ? plan.forwardNames.map((name) => `${name} (present: ${forwarded.has(`OSHAL_SANDBOX_FWD_${name}`) ? 'yes' : 'no'})`).join(', ') : 'none'}`,
    ...users.map((user) => `user ${user.label} ${user.email} sub ${user.sub}${user.root ? ' (root, installer proof)' : ' (invited by the root)'}`),
    `credentials after up: ${prepared.state.credentialsFile} with ${credentialNames.join(', ')}`,
    ...(staged.length ? staged.map((item) => `package ${item.name}@${item.version} ${item.kind} ${item.sha.slice(0, 12)} (${item.ref}); deps ${JSON.stringify(resolution.get(item.name))}`) : ['packages: none requested']),
    `authorization: enforce (OSHAL_APPLICATION_AUTHORIZATION_MODE), LOCAL_AUTH=true, MOCK_OIDC=false, model rail ${prepared.opts.llmProvider}`,
  ];
}

/** @description Print a dry run and exit 0. @param {object} prepared Prepared context. @param {object} deps Deps. @returns {number} Exit code. */
function printDryRun(prepared, deps) {
  deps.out('DRY RUN - nothing is started, written or removed. `up` reads the api command and service definitions from the image\'s own compose file; this dry run read the checkout\'s copy.');
  for (const line of planLines(prepared)) deps.out(line);
  for (const line of ramLines(prepared.plan, ramVerdict(prepared.plan, deps))) deps.out(line);
  if (prepared.opts.printCompose) deps.out(`compose document:\n${JSON.stringify(prepared.plan.compose, null, 2)}`);
  return EXIT.ok;
}

/** @description Refuse when the project exists, the port is taken or an image is missing. @param {object} prepared Prepared. @param {object} deps Deps. @returns {Promise<object>} Image identity. */
async function preflight(prepared, deps) {
  const existing = inventory(deps, prepared.project);
  if (existing.containers.length + existing.volumes.length + existing.networks.length > 0) throw new Error(`${prepared.project} already has docker objects; run down first`);
  if (!(await deps.portFree(prepared.plan.port))) throw new Error(`${sandbox.LOOPBACK}:${prepared.plan.port} is in use`);
  for (const service of Object.values(prepared.plan.compose.services)) mustRun(deps, 'docker', ['image', 'inspect', '--format', '{{.Id}}', service.image]);
  const [id, revision] = mustRun(deps, 'docker', ['image', 'inspect', '--format', '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}', prepared.plan.image]).trim().split('|');
  return { tag: prepared.plan.image, id, revision };
}

/** @description Rebuild the plan from the image's own compose file (what the running image ships). @param {object} prepared Prepared. @param {object} deps Deps. @returns {object} Plan. */
function planFromImage(prepared, deps) {
  const text = mustRun(deps, 'docker', ['run', '--rm', '--network', 'none', '--memory', '128m', '--label', `com.docker.compose.project=${prepared.project}`,
    '--entrypoint', 'cat', prepared.plan.image, IMAGE_COMPOSE_PATH], { timeoutMs: 120000 });
  return assertIsolated(buildPlan(prepared.opts, { liveDoc: loadComposeYaml(text), project: prepared.project, users: prepared.users }));
}

/** @description The manifest written beside the compose file (no values). @param {object} ctx Up context. @param {object} [extra] Result fields. @returns {object} Manifest. */
function manifestOf(ctx, extra = {}) {
  const { plan } = ctx;
  return {
    evidenceLabel: sandbox.EVIDENCE_LABEL, project: plan.project, url: plan.origin, image: ctx.image, createdAt: ctx.createdAt,
    services: Object.keys(plan.compose.services), bots: plan.bots, aliases: plan.aliases, hazards: plan.hazards,
    egress: plan.egress, probeServices: plan.probeServices,
    publishedLivePorts: plan.topology.publishedPorts, liveProject: plan.topology.projectName, secretRefs: plan.secretRefs,
    forwarded: plan.forwardNames, users: ctx.users.map(({ label, email, sub, root }) => ({ label, email, sub, root })),
    credentialsFile: ctx.state.credentialsFile, budgetMb: plan.budgetMb, hostReserveMb: plan.hostReserveMb,
    packages: ctx.staged.map(({ kind, name, version, sha, ref, repo }) => ({ kind, name, version, sha, ref, repo })), ...extra,
  };
}

/** @description Write compose.json and sandbox.json. @param {object} ctx Up context. @param {object} deps Deps. @returns {void} */
function writeState(ctx, deps) {
  deps.fs.mkdirSync(ctx.state.dir, { recursive: true });
  deps.fs.writeFileSync(ctx.state.composeFile, `${JSON.stringify(ctx.plan.compose, null, 2)}\n`);
  deps.fs.writeFileSync(ctx.state.manifestFile, `${JSON.stringify(manifestOf(ctx), null, 2)}\n`);
}

/** @description Wait for services' container health (or running when no healthcheck). @param {object} deps Deps. @param {string} project Project. @param {string[]} services Keys. @param {number} timeoutMs Timeout. @returns {Promise<void>} Resolves when healthy. */
async function waitHealthy(deps, project, services, timeoutMs) {
  const deadline = deps.clock() + timeoutMs;
  for (const service of services) {
    const name = containerFor(deps, project, service);
    for (;;) {
      const [status, health] = run(deps, 'docker', ['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', name]).stdout.trim().split('|');
      if (health === 'healthy' || (status === 'running' && !health)) break;
      if (['exited', 'dead'].includes(status) || health === 'unhealthy') throw new Error(`${service} is ${health || status}`);
      if (deps.clock() > deadline) throw new Error(`${service} not healthy within ${timeoutMs / 1000}s (${status}/${health || 'no healthcheck'})`);
      await deps.sleep(TIMEOUTS.pollMs);
    }
    deps.out(`${service} healthy`);
  }
}

/** @description Wait for the api's /health over the published loopback port. @param {object} deps Deps. @param {string} origin Origin. @returns {Promise<void>} Resolves on 200. */
async function waitHttpHealth(deps, origin) {
  const deadline = deps.clock() + TIMEOUTS.apiMs;
  let last = 'no answer yet';
  for (;;) {
    try {
      const res = await deps.fetch(`${origin}/health`, { signal: AbortSignal.timeout(TIMEOUTS.healthRequestMs) });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error.cause && error.cause.code ? error.cause.code : error.message;
    }
    if (deps.clock() > deadline) throw new Error(`api /health did not answer 200 within ${TIMEOUTS.apiMs / 1000}s (${last})`);
    await deps.sleep(TIMEOUTS.pollMs);
  }
}

/** @description Wait for the loader's "auto-load complete" line and read its counts. @param {object} deps Deps. @param {string} project Project. @returns {Promise<object>} { loadedCount, failedCount }. */
async function waitAutoLoad(deps, project) {
  const name = containerFor(deps, project, 'api');
  const deadline = deps.clock() + TIMEOUTS.autoLoadMs;
  for (;;) {
    const logs = run(deps, 'docker', ['logs', name], { timeoutMs: 60000 });
    const line = lines(`${logs.stdout}\n${logs.stderr}`).find((entry) => entry.includes('Swarm app auto-load complete'));
    if (line) {
      try { const parsed = JSON.parse(line.slice(line.indexOf('{'))); return { loadedCount: parsed.loadedCount, failedCount: parsed.failedCount }; } catch { return { loadedCount: null, failedCount: null }; }
    }
    if (deps.clock() > deadline) throw new Error(`the api did not finish auto-loading within ${TIMEOUTS.autoLoadMs / 1000}s`);
    await deps.sleep(TIMEOUTS.pollMs);
  }
}

/** @description Stream every staged package into the workspace volume. @param {object} ctx Up context. @param {object} deps Deps. @returns {Promise<void>} Resolves when all are staged. */
async function stageIntoVolume(ctx, deps) {
  const installedAt = deps.now().toISOString();
  const target = { image: ctx.plan.image, volume: ctx.plan.workspaceVolume, project: ctx.plan.project, labelKey: sandbox.SANDBOX_PROJECT_LABEL };
  for (const item of ctx.staged) {
    const record = packages.buildInstallRecord(item, ctx.resolution.get(item.name), installedAt);
    await packages.streamPackageIntoVolume({ spawn: deps.spawn, env: scrubbedEnv(deps.env) }, item, record, target);
    deps.out(`staged ${item.name}@${item.version} (${item.kind} ${item.sha.slice(0, 12)}) into ${ctx.plan.workspaceVolume}`);
  }
}

/** @description Container addresses of every sandbox container. @param {object} deps Deps. @param {string} project Project. @returns {string[]} IPs. */
function sandboxAddresses(deps, project) {
  const names = lines(mustRun(deps, 'docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']));
  if (!names.length) return [];
  return mustRun(deps, 'docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', ...names]).split(/\s+/).filter(Boolean);
}

/** @description The running live containers: their names, and their addresses as connect targets. @param {object} deps Deps. @param {string} liveProject Live compose project. @returns {{names: string[], targets: object[]}} Live containers. */
function liveContainers(deps, liveProject) {
  const names = lines(run(deps, 'docker', ['ps', '--filter', `label=com.docker.compose.project=${liveProject}`, '--format', '{{.Names}}']).stdout);
  if (!names.length) return { names, targets: [] };
  return { names, targets: sandbox.parseLiveAddresses(lines(mustRun(deps, 'docker', ['inspect', '--format', LIVE_ADDRESS_FORMAT, ...names]))) };
}

/**
 * @description Probe from inside each given sandbox service: no live name (from the plan and from
 * the running live project) may resolve, aliases only to sandbox addresses, no live container
 * address and no live published port may answer, and without provider egress no default route.
 * @param {object} deps Deps. @param {object} manifest Plan or sandbox.json fields (project, hazards, aliases, liveProject, publishedLivePorts, egress).
 * @param {string[]} services Sandbox service keys to probe from.
 * @returns {object} Probe summary; throws IsolationError on any problem.
 */
function probeIsolation(deps, manifest, services) {
  const live = liveContainers(deps, manifest.liveProject);
  const hazards = [...new Set([...manifest.hazards, ...live.names.filter((name) => !manifest.aliases.includes(name))])];
  const input = { names: [...hazards, ...manifest.aliases], connects: live.targets, hostAliases: sandbox.HOST_ALIASES, hostPorts: manifest.publishedLivePorts };
  const env = { ...scrubbedEnv(deps.env), OSHAL_SANDBOX_PROBE: JSON.stringify(input) };
  const expect = { hazards, aliases: manifest.aliases, sandboxIps: sandboxAddresses(deps, manifest.project), egress: manifest.egress === true };
  const problems = [];
  let knocks = 0;
  for (const service of services) {
    const container = containerFor(deps, manifest.project, service);
    const result = JSON.parse(mustRun(deps, 'docker', ['exec', '-e', 'OSHAL_SANDBOX_PROBE', container, 'node', '-e', PROBE_SCRIPT], { env, timeoutMs: 180000 }));
    knocks += Object.keys(result.connects || {}).length;
    problems.push(...sandbox.evaluateIsolationProbe(result, expect).map((problem) => `${service}: ${problem}`));
  }
  if (problems.length) throw new IsolationError(problems);
  return { probedFrom: services, liveNamesUnresolved: hazards.length, liveRunningContainers: live.names.length, liveAddressTargets: live.targets.length, knocksRefused: knocks, providerEgress: expect.egress };
}

/** @description One printable line for a clean probe. @param {object} probe From probeIsolation. @returns {string} Line. */
function probeLine(probe) {
  return `isolation probe from ${probe.probedFrom.join(', ')}: ${probe.liveNamesUnresolved} live names unresolved, ${probe.knocksRefused} knocks refused `
    + `(${probe.liveAddressTargets} live container addresses, the live published ports on the host), ${probe.providerEgress ? 'provider egress ON' : 'no default route'}`;
}

/** @description Register the fake users and write their credentials file. @param {object} ctx Up context. @param {object} deps Deps. @returns {Promise<object>} { identities, credentialNames, credentials }. */
async function registerUsers(ctx, deps) {
  const api = containerFor(deps, ctx.plan.project, 'api');
  const issueSetupCode = async () => {
    const out = mustRun(deps, 'docker', ['exec', api, 'node', 'scripts/oshal-setup-root.mjs', '--origin', ctx.plan.origin], { timeoutMs: 120000 });
    const match = /^Installer setup code: (\S+)$/m.exec(out);
    if (!match) throw new Error('the installer proof was not issued');
    return match[1];
  };
  const call = identities.createClient(ctx.plan.origin, deps.fetch);
  const result = await identities.registerIdentities({ call, users: ctx.users, issueSetupCode, patLabel: `${sandbox.EVIDENCE_LABEL} ${ctx.plan.project}`, log: deps.out });
  const credentials = new Map([
    ['OSHAL_SANDBOX_EVIDENCE_LABEL', sandbox.EVIDENCE_LABEL], ['OSHAL_SANDBOX_PROJECT', ctx.plan.project], ['OSHAL_SANDBOX_BASE_URL', ctx.plan.origin],
    ...result.credentials,
  ]);
  return { identities: result.identities, credentialNames: identities.writeCredentialsFile(ctx.state.credentialsFile, credentials), credentials };
}

/**
 * @description Each staged package must be active at its staged version, and a member's view of it
 * must come from the enforce policy (`/api/authorization/me` never answers "legacy").
 * @param {object} ctx Up context. @param {object} deps Deps. @param {object} registered From registerUsers.
 * @returns {Promise<string[]>} Verified name@version (status) lines.
 */
async function verifyPackages(ctx, deps, registered) {
  if (!ctx.staged.length) return [];
  const call = identities.createClient(ctx.plan.origin, deps.fetch);
  const rootPat = registered.credentials.get(identities.credentialName(identities.ROOT_LABEL, 'PAT'));
  const member = ctx.users.find((user) => !user.root);
  const memberSession = member && registered.credentials.get(identities.credentialName(member.label, 'SESSION'));
  const listed = await call('GET', '/api/swarm/apps?status=active', { bearer: rootPat });
  if (listed.status !== 200 || !Array.isArray(listed.json && listed.json.apps)) throw new Error(`listing active apps answered HTTP ${listed.status}`);
  const active = new Map(listed.json.apps.map((app) => [app.name, String(app.version || '')]));
  const out = [];
  for (const item of ctx.staged) {
    if (active.get(item.name) !== item.version) throw new Error(`${item.name} is not active at ${item.version} (active: ${active.get(item.name) || 'no'})`);
    const me = memberSession ? await call('GET', `/api/authorization/me?app=${encodeURIComponent(item.name)}`, { cookie: memberSession }) : null;
    const status = me && me.json && me.json.status;
    if (me && (me.status !== 200 || status === 'legacy')) throw new Error(`${item.name}: authorization is not enforced for a member (HTTP ${me.status}, status ${status})`);
    out.push(`${item.name}@${item.version} active; ${member ? member.label : 'member'} view under enforce: status ${status || 'n/a'}, tier ${(me && me.json && me.json.tier) || 'n/a'}`);
  }
  return out;
}

/** @description Start the containers, stage, boot, probe, register, verify and start bots. @param {object} ctx Up context. @param {object} deps Deps. @returns {Promise<object>} Result fields. */
async function startSandbox(ctx, deps) {
  const { state, plan, values } = ctx;
  composeRun(deps, state, ['up', '-d', 'db', 'redis'], values, TIMEOUTS.infraMs);
  await waitHealthy(deps, plan.project, ['db', 'redis'], TIMEOUTS.infraMs);
  composeRun(deps, state, ['up', '--no-start', 'api', sandbox.GATEWAY, ...plan.bots], values, TIMEOUTS.infraMs);
  await stageIntoVolume(ctx, deps);
  composeRun(deps, state, ['start', 'api', sandbox.GATEWAY], values, TIMEOUTS.infraMs);
  await waitHttpHealth(deps, plan.origin);
  const autoLoad = await waitAutoLoad(deps, plan.project);
  deps.out(`api up behind the gateway; auto-load loaded ${autoLoad.loadedCount}, failed ${autoLoad.failedCount}`);
  const isolation = [probeIsolation(deps, manifestOf(ctx), ['api'])];
  deps.out(probeLine(isolation[0]));
  const registered = await registerUsers(ctx, deps);
  const installed = await verifyPackages(ctx, deps, registered);
  for (const line of installed) deps.out(line);
  if (plan.bots.length) {
    composeRun(deps, state, ['start', ...plan.bots], values, TIMEOUTS.infraMs);
    await waitHealthy(deps, plan.project, plan.bots, TIMEOUTS.botMs);
    isolation.push(probeIsolation(deps, manifestOf(ctx), plan.bots));
    deps.out(probeLine(isolation[1]));
  }
  return { autoLoad, isolation, identities: registered.identities, credentialNames: registered.credentialNames, installed };
}

/** @description Print the finished sandbox. @param {object} ctx Up context. @param {object} result Result. @param {object} deps Deps. @returns {void} */
function reportUp(ctx, result, deps) {
  deps.fs.writeFileSync(ctx.state.manifestFile, `${JSON.stringify(manifestOf(ctx, result), null, 2)}\n`);
  deps.out(`UP ${ctx.plan.project} at ${ctx.plan.origin} (image ${ctx.image.tag} ${String(ctx.image.id).slice(7, 19)} revision ${ctx.image.revision || 'unlabelled'})`);
  for (const identity of result.identities) deps.out(`identity ${identity.label} ${identity.sub}${identity.root ? ' (root)' : ''}: ${identity.credentialNames.join(', ')}`);
  deps.out(`credentials by name in ${ctx.state.credentialsFile}; manifest ${ctx.state.manifestFile}`);
  deps.out(`tear down with: node scripts/operations/installed-sandbox.js down --name ${ctx.plan.project}`);
}

/**
 * @description `up`: plan, guard, start and verify a sandbox; tear it down again on any failure unless
 * --keep-on-failure.
 * @param {object} opts Options. @param {object} deps Deps. @returns {Promise<number>} Exit code.
 */
async function runUp(opts, deps) {
  const prepared = prepareUp(opts, deps);
  if (opts.dryRun) return printDryRun(prepared, deps);
  const verdict = ramVerdict(prepared.plan, deps);
  for (const line of ramLines(prepared.plan, verdict)) deps.out(line);
  if (!verdict.ok) return EXIT.ram;
  const image = await preflight(prepared, deps);
  const plan = planFromImage(prepared, deps);
  const values = new Map([...sandbox.generateSandboxSecrets({ randomBytes: deps.randomBytes, generateKeyPairSync: deps.generateKeyPairSync }, plan), ...prepared.forwarded]);
  const ctx = { ...prepared, plan, image, values, createdAt: deps.now().toISOString() };
  writeState(ctx, deps);
  try {
    reportUp(ctx, await startSandbox(ctx, deps), deps);
    return EXIT.ok;
  } catch (error) {
    deps.err(`up failed: ${error.message}`);
    for (const problem of error.problems || []) deps.err(`  ${problem}`);
    if (opts.keepOnFailure) { deps.err(`kept for diagnosis; remove with: down --name ${plan.project}`); return error instanceof IsolationError ? EXIT.isolation : EXIT.failed; }
    const teardown = await runDown({ ...opts, name: plan.project, dryRun: false }, deps);
    return error instanceof IsolationError ? EXIT.isolation : teardown === EXIT.ok ? EXIT.failed : teardown;
  }
}

/** @description Remove whatever compose left behind, by label. @param {object} deps Deps. @param {object} left Inventory. @returns {void} */
function sweep(deps, left) {
  if (left.containers.length) run(deps, 'docker', ['rm', '-f', '-v', ...left.containers], { timeoutMs: 120000 });
  for (const volume of left.volumes) run(deps, 'docker', ['volume', 'rm', '-f', volume]);
  for (const network of left.networks) run(deps, 'docker', ['network', 'rm', network]);
}

/** @description Remove the state directory (it holds the credentials) only when it is exactly <root>/<project>. @param {object} state State. @param {object} deps Deps. @returns {boolean} True when it no longer exists. */
function removeStateDir(state, deps) {
  if (path.dirname(state.dir) !== state.root || path.basename(state.dir) !== state.project) return false;
  deps.fs.rmSync(state.dir, { recursive: true, force: true });
  return !deps.fs.existsSync(state.dir);
}

/**
 * @description `down`: compose down with volumes, a label sweep, the state directory, and a receipt
 * that is red if anything survives. Refuses any project that is not a sandbox project.
 * @param {object} opts Options. @param {object} deps Deps. @returns {Promise<number>} Exit code.
 */
async function runDown(opts, deps) {
  const project = projectName(opts.name);
  const state = stateFor(opts, deps, project);
  const before = inventory(deps, project);
  if (opts.dryRun) {
    deps.out(`DRY RUN down ${project}: would remove containers ${before.containers.join(', ') || 'none'}; volumes ${before.volumes.join(', ') || 'none'}; networks ${before.networks.join(', ') || 'none'}; state ${state.dir}`);
    return EXIT.ok;
  }
  if (deps.fs.existsSync(state.composeFile)) {
    const blanks = new Map(sandbox.referencedNames(JSON.parse(deps.fs.readFileSync(state.composeFile, 'utf8'))).map((name) => [name, '']));
    const result = run(deps, 'docker', ['compose', '-p', project, '-f', state.composeFile, '--project-directory', state.dir, 'down', '--volumes', '--remove-orphans', '--timeout', '20'],
      { env: { ...scrubbedEnv(deps.env), ...Object.fromEntries(blanks) }, timeoutMs: 180000, cwd: state.dir });
    if (result.status !== 0) deps.err(`compose down: ${firstLine(result.stderr)} (continuing with the label sweep)`);
  }
  sweep(deps, inventory(deps, project));
  const receipt = sandbox.buildTeardownReceipt({ project, before, after: inventory(deps, project), stateDirRemoved: removeStateDir(state, deps) });
  for (const line of sandbox.formatTeardownReceipt(receipt)) (receipt.ok ? deps.out : deps.err)(line);
  return receipt.ok ? EXIT.ok : EXIT.leftover;
}

/** @description Container state lines for status. @param {object} deps Deps. @param {string} project Project. @returns {{lines: string[], allRunning: boolean, any: boolean}} Summary. */
function containerStates(deps, project) {
  const rows = lines(mustRun(deps, 'docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}|{{.State}}|{{.Status}}']));
  return { lines: rows.map((row) => row.split('|').join('  ')), allRunning: rows.length > 0 && rows.every((row) => row.split('|')[1] === 'running'), any: rows.length > 0 };
}

/**
 * @description `status`: containers, api health, a fresh isolation probe and the credential names.
 * @param {object} opts Options. @param {object} deps Deps. @returns {Promise<number>} Exit code.
 */
async function runStatus(opts, deps) {
  const project = projectName(opts.name);
  const state = stateFor(opts, deps, project);
  const manifest = deps.fs.existsSync(state.manifestFile) ? JSON.parse(deps.fs.readFileSync(state.manifestFile, 'utf8')) : null;
  const containers = containerStates(deps, project);
  if (!containers.any) { deps.err(`no sandbox named ${project}`); return EXIT.failed; }
  for (const line of containers.lines) deps.out(`container ${line}`);
  if (!manifest) { deps.err(`no manifest at ${state.manifestFile}; containers exist without state - tear down with down --name ${project}`); return EXIT.failed; }
  let healthy = false;
  try { healthy = (await deps.fetch(`${manifest.url}/health`, { signal: AbortSignal.timeout(TIMEOUTS.healthRequestMs) })).status === 200; } catch (error) { deps.err(`api /health: ${error.message}`); }
  deps.out(`api ${manifest.url} /health ${healthy ? '200' : 'not answering'}`);
  let isolated = false;
  try { const probe = probeIsolation(deps, manifest, manifest.probeServices || ['api']); isolated = true; deps.out(probeLine(probe)); } catch (error) {
    deps.err(`isolation: ${error.message}`);
    for (const problem of error.problems || []) deps.err(`  ${problem}`);
  }
  for (const identity of manifest.identities || []) deps.out(`identity ${identity.label} ${identity.sub}: ${identity.credentialNames.join(', ')}`);
  for (const item of manifest.packages || []) deps.out(`package ${item.name}@${item.version} (${item.kind} ${String(item.sha).slice(0, 12)})`);
  return containers.allRunning && healthy && isolated ? EXIT.ok : EXIT.failed;
}

/** @description Whether a loopback port can be bound. @param {number} port Port. @returns {Promise<boolean>} True when free. */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, sandbox.LOOPBACK, () => server.close(() => resolve(true)));
  });
}

/** @description The real process dependencies. @returns {object} Deps. */
function realDeps() {
  return {
    spawnSync: childProcess.spawnSync, spawn: childProcess.spawn, fetch: globalThis.fetch, fs, env: process.env,
    freemem: os.freemem, tmpdir: os.tmpdir, clock: Date.now, now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomBytes: crypto.randomBytes, generateKeyPairSync: crypto.generateKeyPairSync, portFree,
    out: (line) => process.stdout.write(`${TAG} ${line}\n`), err: (line) => process.stderr.write(`${TAG} ${line}\n`),
  };
}

/**
 * @description Entry point.
 * @param {string[]} argv Arguments after the script. @param {object} [deps] Dependencies (tests inject doubles).
 * @returns {Promise<number>} Exit code.
 */
async function main(argv, deps = realDeps()) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { deps.err(error.message); return EXIT.usage; }
  try {
    if (opts.command === 'up') return await runUp(opts, deps);
    if (opts.command === 'down') return await runDown(opts, deps);
    return await runStatus(opts, deps);
  } catch (error) {
    deps.err(error.message);
    for (const problem of error.problems || []) deps.err(`  ${problem}`);
    if (error instanceof UsageError) return EXIT.usage;
    return error instanceof IsolationError ? EXIT.isolation : EXIT.failed;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { EXIT, PROBE_SCRIPT, parseArgs, readEnvFileValues, scrubbedEnv, main, runUp, runDown, runStatus, realDeps };
