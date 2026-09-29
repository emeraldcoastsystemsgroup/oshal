/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation: the pure half of scripts/operations/installed-sandbox.js (backlog entries #1, #2 and #23 need two-identity acceptance on the installed image without writing append-only audit rows on the live box). It reads the live stack's own compose document for names, images, the api boot command and the environment defaults, and builds a disposable compose project from them: its own PostgreSQL, Redis and api, optional named bot nodes, an INTERNAL backend network plus an edge network for the one published loopback port, named volumes only (no bind mount, no docker socket), no container_name, no oshal.tier label, restart "no", a memory limit on every service, the Docker Desktop host aliases pinned to the container's own loopback, and every secret written only as an ${OSHAL_SANDBOX_*} reference so the file on disk never holds a value. A 2026-09-27 sandbox that shared the stack network dispatched two sandbox tickets to live bots by name (COLLABORATE, refused with 401); isolationProblems() is the static refusal for every shape that could route there again, evaluateIsolationProbe() the verdict on the in-container DNS/connect probe, evaluateRamGuard() the stated free-memory floor, and buildTeardownReceipt() the red/green teardown record.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The api no longer sits on a network with a host route. Measured on this engine (Docker 29.6.2): from a container on an ordinary bridge, a container on ANOTHER bridge answered on its own address, and a port published on the host loopback answered on the address host.docker.internal stands for, while from an internal network every such connect failed with ENETUNREACH. Pinning the host aliases changed the name, not the address, so the first cut's api (on the edge network for its published port) could have reached the live Redis and bots by address and its probe could not see it. Now the api, the database, Redis and the bots sit on the internal backend network only; a `gateway` service - the same image running a TCP forwarder to api:5000, with no environment and no volume - is the one container on the edge network and the only one that publishes a port. A forwarded provider credential puts the api and the bots on a third network, egress, which does have a host route, and the probe verdict then refuses while any live address answers. isolationProblems() refuses each new shape (an api or bot on edge, a second publisher, an egress network with nothing forwarded, a gateway carrying environment or a volume), evaluateIsolationProbe() reads default routes and address connects, and parseLiveAddresses() turns the running live containers into connect targets. Second fix: the two runtime role passwords are 48 hexadecimal characters, which is what scripts/governance/provision-app-role.mjs accepts; the base64url passwords of the first cut made the api boot command exit at "app-role provision FAILED".
 */
'use strict';

const EVIDENCE_LABEL = 'installed-sandbox';
const PROJECT_PREFIX = 'oshal-sandbox-';
const PROJECT_PATTERN = /^oshal-sandbox-[a-z0-9][a-z0-9-]{2,39}$/;
const SANDBOX_LABEL = 'oshal.sandbox';
const SANDBOX_PROJECT_LABEL = 'oshal.sandbox.project';
const REF_PREFIX = 'OSHAL_SANDBOX_';
const REF_PATTERN = /^\$\{OSHAL_SANDBOX_[A-Z0-9_]+\}$/;
/** The three live services every sandbox mirrors; their definitions are read, never copied blindly. */
const LIVE_SERVICE = Object.freeze({ api: 'oshal-api', db: 'oshal-db', redis: 'oshal-redis' });
/** Per-service memory ceilings (MB). Their sum is the sandbox budget the RAM guard holds free. */
const MEMORY_LIMITS_MB = Object.freeze({ db: 512, redis: 128, api: 1400, bot: 640, gateway: 96 });
const DEFAULT_HOST_RESERVE_MB = 1024;
const DEFAULT_PORT = 35459;
/** The port the api listens on inside its container, and the gateway forwards to. */
const API_PORT = 5000;
/** The one service on the edge network: it publishes the loopback port and forwards to the api. */
const GATEWAY = 'gateway';
/** backend is internal; edge carries the published port; egress exists only with a forwarded credential. */
const SANDBOX_NETWORKS = Object.freeze(['backend', 'edge', 'egress']);
const LOCAL_AUTH_ISSUER = 'urn:oshal:local-auth';
/** Docker Desktop resolves these to the host, where the live stack publishes its ports. */
const HOST_ALIASES = Object.freeze(['host.docker.internal', 'gateway.docker.internal']);
const LOOPBACK = '127.0.0.1';
const WORKSPACE_MOUNT = '/app/workspace-shared';
const SECRET_KEY = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|API_KEY|ENCRYPTION_KEY|MASTER_KEY|CREDENTIAL|WEBHOOK|DATABASE_URL|_DSN|_KEY$|_KEYS$)/;
const CONTROL_KEY = /^(COMPOSE_|DOCKER_)|_COMPOSE_FILE$/;
const URL_WITH_PASSWORD = /:\/\/[^/\s:@]+:[^/\s@]+@/;

/** Kernel schedules, feeds and money rails that reach outside the sandbox stay off. */
const OUTBOUND_OFF = Object.freeze({
  ENABLE_AGENT_SCHEDULER: 'false', ENABLE_WORLD_INTELLIGENCE: 'false', ENABLE_PERSONAL_INTELLIGENCE: 'false',
  WORLD_CLASSIFY_DISABLED: 'true', WORLD_DEEPDIVE_ENABLED: 'false', WORLD_EVENTS_ENABLED: 'false',
  WORLD_FIREHOSE_ENABLED: 'false', WORLD_FLOW_ENABLED: 'false', WORLD_GOV_ENABLED: 'false',
  VIDEO_PUMP_ENABLED: 'false', TRADING_HALT: 'true', TRADING_LIVE_ENABLED: 'false',
  TRADING_AUTOPILOT_LIVE: 'false', TRADING_STREAM_ENABLED: 'false', KALSHI_LIVE_ENABLED: 'false',
  SELF_HEAL_AUTO_APPLY: 'false', OSHAL_DEV_CONSOLE_ENABLED: 'false', A2A_GATEWAY_ENABLED: 'false',
  ENABLE_GUEST_MODE: 'false', REJECT_LOOP_TICKETS: 'true', NOTIFY_TRANSPORT: '',
});

/**
 * @description Find the brace that closes the `{` at `open`, counting nested `${...}` defaults.
 * @param {string} text Compose value. @param {number} open Index of the opening brace.
 * @returns {number} Index of the closing brace, or -1 when unbalanced.
 */
function matchingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/**
 * @description Evaluate a compose value with an EMPTY environment: `${X:-d}` and `${X-d}` become
 * their default (recursively), `$$` a literal `$`. A bare `${X}`, `$X` or `${X:?e}` marks the value
 * incomplete, because its real value lives only in the operator's .env - which the sandbox never reads
 * except for names forwarded explicitly.
 * @param {string} text Raw value from the live compose file.
 * @returns {{value: string, complete: boolean}} Resolved text and whether every reference had a default.
 */
function resolveComposeDefaults(text) {
  let value = '';
  let complete = true;
  for (let index = 0; index < text.length;) {
    const next = text[index + 1];
    if (text[index] !== '$') { value += text[index]; index += 1; continue; }
    if (next === '$') { value += '$'; index += 2; continue; }
    if (next === '{') {
      const end = matchingBrace(text, index + 1);
      if (end < 0) return { value: text, complete: false };
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([\s\S]*))?$/.exec(text.slice(index + 2, end));
      if (match && match[2]) {
        const inner = resolveComposeDefaults(match[3]);
        value += inner.value;
        complete = complete && inner.complete;
      } else complete = false;
      index = end + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1));
    if (name) { complete = false; index += 1 + name[0].length; continue; }
    value += '$';
    index += 1;
  }
  return { value, complete };
}

/** @description Escape a literal for a compose file (compose interpolates `$`). @param {string} value Literal. @returns {string} Escaped text. */
function escapeCompose(value) {
  return String(value).replace(/\$/g, '$$$$');
}

/** @description Reference a secret the compose process receives by name. @param {string} name Suffix after OSHAL_SANDBOX_. @returns {string} `${OSHAL_SANDBOX_<name>}`. */
function secretRef(name) {
  return `\${${REF_PREFIX}${name}}`;
}

/** @description Whether an environment key carries a credential or credential-bearing URL. @param {string} key Env key. @returns {boolean} True for secret-shaped keys. */
function isSecretKey(key) {
  return SECRET_KEY.test(key);
}

/**
 * @description Whether a value names one of the given hosts as a whole DNS token (so `oshal-db` never
 * matches inside `oshal-local-db` or `oshal-dbx`).
 * @param {string} value Environment value. @param {string[]} names Host names.
 * @returns {string|null} The first host named, or null.
 */
function namedHost(value, names) {
  const text = String(value);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_-])`, 'i').test(text)) return name;
  }
  return null;
}

/** @description Whether a value is a path on the operator's host filesystem. @param {string} value Env value. @returns {boolean} True for host paths. */
function namesHostPath(value) {
  return /\/run\/desktop\/mnt\/host\//i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^~\//.test(value);
}

/**
 * @description Host ports the live stack publishes, with their compose defaults resolved.
 * @param {object} services Live services map. @returns {number[]} Sorted unique host ports.
 */
function publishedHostPorts(services) {
  const ports = new Set();
  for (const service of Object.values(services)) {
    for (const entry of service.ports || []) {
      if (entry && typeof entry === 'object') { if (entry.published) ports.add(Number(entry.published)); continue; }
      const parts = resolveComposeDefaults(String(entry)).value.split('/')[0].split(':');
      const host = parts.length >= 3 ? parts[parts.length - 2] : parts.length === 2 ? parts[0] : '';
      if (/^\d+$/.test(host)) ports.add(Number(host));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** @description Convert a compose environment block (map or KEY=VALUE list) to a map. @param {object|string[]} env Block. @returns {Record<string, unknown>} Map form. */
function envMap(env) {
  if (!Array.isArray(env)) return env && typeof env === 'object' ? env : {};
  return Object.fromEntries(env.map((line) => { const at = String(line).indexOf('='); return at < 0 ? [line, undefined] : [line.slice(0, at), line.slice(at + 1)]; }));
}

/**
 * @description Read the live stack's identity from its own compose document: project, every
 * service key, container and network name (the names a sandbox must never route to), the host ports
 * it publishes, and the definitions of the api, database and Redis the sandbox mirrors.
 * @param {object} liveDoc Parsed docker-compose.oshal-local.yml (through scripts/lib/compose-yaml.js).
 * @returns {object} Topology record.
 */
function readLiveTopology(liveDoc) {
  const services = liveDoc && liveDoc.services;
  if (!services || typeof services !== 'object') throw new Error('live compose document has no services');
  for (const key of Object.values(LIVE_SERVICE)) if (!services[key]) throw new Error(`live compose document has no ${key} service`);
  const projectName = String(liveDoc.name || '');
  if (!projectName) throw new Error('live compose document has no project name');
  const networks = liveDoc.networks || {};
  const networkNames = Object.keys(networks).map((key) => (networks[key] && networks[key].name) || `${projectName}_${key}`);
  const volumeKeys = Object.keys(liveDoc.volumes || {});
  const serviceKeys = Object.keys(services);
  const containerNames = serviceKeys.map((key) => services[key].container_name).filter(Boolean);
  return {
    projectName, services, serviceKeys, containerNames, networkNames, volumeKeys,
    publishedPorts: publishedHostPorts(services),
    apiImage: resolveComposeDefaults(String(services[LIVE_SERVICE.api].image || '')).value,
  };
}

/** @description Validate a sandbox project name (never the live project). @param {string} name Candidate. @returns {string} The name. */
function validateProjectName(name) {
  if (!PROJECT_PATTERN.test(String(name || ''))) throw new Error(`sandbox project must match ${PROJECT_PATTERN} (got "${name}")`);
  return String(name);
}

/** @description Mint a unique sandbox project name. @param {(n: number) => Buffer} randomBytes Entropy source. @returns {string} Project name. */
function mintProjectName(randomBytes) {
  return `${PROJECT_PREFIX}${randomBytes(4).toString('hex')}`;
}

/**
 * @description Environment inherited from a live service: every literal knob and compose default
 * the box boots with, minus secrets, compose/docker control keys, host paths and any value naming a
 * live host. The sandbox overlays its own posture on top.
 * @param {object} liveEnv The live service's merged environment. @param {string[]} hazards Live host names.
 * @returns {Record<string, string>} Compose-escaped environment.
 */
function deriveInheritedEnv(liveEnv, hazards) {
  const env = {};
  for (const [key, raw] of Object.entries(envMap(liveEnv))) {
    if (raw !== null && typeof raw === 'object') continue;
    const { value, complete } = resolveComposeDefaults(String(raw === undefined || raw === null ? '' : raw));
    if (!complete || isSecretKey(key) || CONTROL_KEY.test(key) || URL_WITH_PASSWORD.test(value)) continue;
    if (namesHostPath(value) || namedHost(value, hazards)) continue;
    env[key] = escapeCompose(value);
  }
  return env;
}

/**
 * @description One named bot node from the live compose file: its own identity environment, its
 * named-volume mounts (bind mounts, auth volumes and the docker socket are dropped), its boot command
 * and the DNS names the api dispatches to (service key and container name), which the sandbox answers
 * on its own internal network only.
 * @param {object} topology From readLiveTopology. @param {string} key Live service key, e.g. career-bot.
 * @returns {object} Bot descriptor.
 */
function extractBotService(topology, key) {
  const service = topology.services[key];
  if (!service || Object.values(LIVE_SERVICE).includes(key)) throw new Error(`no live bot service named "${key}"`);
  if (envMap(service.environment).BOT_RUNTIME !== 'bot-node') throw new Error(`live service "${key}" is not a bot node (BOT_RUNTIME)`);
  const volumes = (service.volumes || []).map(String).filter((entry) => isNamedVolumeMount(entry, topology));
  return {
    key, liveEnv: service.environment, command: service.command, volumes,
    aliases: [key, service.container_name].filter(Boolean),
  };
}

/** @description Whether a mount is `<named volume>:<path>` for a volume the live file declares. @param {string} entry Mount. @param {object} topology Topology. @returns {boolean} True for named volumes. */
function isNamedVolumeMount(entry, topology) {
  const source = entry.split(':')[0];
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source) && topology.volumeKeys.includes(source);
}

/** @description Validate the published loopback port. @param {number} port Candidate. @param {object} topology Topology. @returns {number} Port. */
function validatePort(port, topology) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`port must be an integer in 1024-65535 (got ${port})`);
  if (topology.publishedPorts.includes(value)) throw new Error(`port ${value} is published by the live stack`);
  return value;
}

/** @description Labels every sandbox object carries. @param {string} project Sandbox project. @returns {Record<string,string>} Labels. */
function sandboxLabels(project) {
  return { [SANDBOX_LABEL]: EVIDENCE_LABEL, [SANDBOX_PROJECT_LABEL]: project };
}

/** @description Memory limit string. @param {number} mb Megabytes. @returns {string} Compose mem_limit. */
function memLimit(mb) {
  return `${mb}m`;
}

/** @description Common hardening shared by every sandbox service. @param {string} project Project. @param {number} mb Memory. @returns {object} Service fragment. */
function hardening(project, mb) {
  return {
    labels: sandboxLabels(project), restart: 'no', pull_policy: 'never', mem_limit: memLimit(mb),
    extra_hosts: HOST_ALIASES.map((host) => `${host}:${LOOPBACK}`),
  };
}

/** @description The live database/Redis definitions reduced to what a disposable copy needs. @param {object} topology Topology. @param {string} project Project. @returns {{db: object, redis: object}} Services. */
function infraServices(topology, project) {
  const liveDb = topology.services[LIVE_SERVICE.db];
  const liveRedis = topology.services[LIVE_SERVICE.redis];
  const dbEnv = envMap(liveDb.environment);
  return {
    db: {
      image: String(liveDb.image), command: liveDb.command, healthcheck: liveDb.healthcheck,
      environment: { POSTGRES_DB: String(dbEnv.POSTGRES_DB), POSTGRES_USER: String(dbEnv.POSTGRES_USER), PGDATA: String(dbEnv.PGDATA), POSTGRES_PASSWORD: secretRef('PG_PASSWORD') },
      volumes: ['db-data:/var/lib/postgresql/data'], networks: { backend: {} }, ...hardening(project, MEMORY_LIMITS_MB.db),
    },
    redis: {
      image: String(liveRedis.image), command: ['redis-server', '--appendonly', 'no', '--save', ''], healthcheck: liveRedis.healthcheck,
      networks: { backend: {} }, ...hardening(project, MEMORY_LIMITS_MB.redis),
    },
  };
}

/**
 * @description Posture every sandbox runtime shares: its own Redis, the sandbox controller, the
 * sandbox service secret, the chosen model rail and the forwarded credentials (by reference only).
 * @param {object} options Plan options. @returns {Record<string,string>} Environment fragment.
 */
function sharedPosture(options) {
  const provider = options.llmProvider || 'noop';
  const env = {
    REDIS_URL: 'redis://redis:6379', SWARM_CONTROLLER_URL: 'http://api:5000', SWARM_REGISTRY: 'kernel',
    SWARM_SERVICE_SECRET: secretRef('SWARM_SERVICE_SECRET'), FORCE_LLM_PROVIDER: provider, LLM_PROVIDER: provider,
    RUNNING_IN_DOCKER: 'true', ...OUTBOUND_OFF,
  };
  if (options.llmModel) Object.assign(env, { FORCE_LLM_MODEL: options.llmModel, LLM_MODEL: options.llmModel });
  for (const name of options.forwardNames || []) env[name] = secretRef(`FWD_${name}`);
  return env;
}

/**
 * @description The sandbox api's own posture, the installer's LOCAL_AUTH shape (ADR-117, root claimed
 * through the one-use installer proof) under authorization ENFORCE.
 * @param {object} options Plan options. @param {string} origin Browser origin. @returns {Record<string,string>} Environment.
 */
function apiPosture(options, origin) {
  const env = {
    ...sharedPosture(options), BOT_RUNTIME: 'swarm',
    DATABASE_URL: secretRef('DATABASE_URL'), BOOTSTRAP_DATABASE_URL: secretRef('BOOTSTRAP_DATABASE_URL'), BOT_DATABASE_URL: secretRef('BOT_DATABASE_URL'),
    OSHAL_APP_ROLE_BOOTSTRAP: 'true', RUN_MIGRATIONS: 'true', OSHAL_DB_GUC_STRICT: 'deny', RAG_ENGINE: 'pgvector',
    LOCAL_AUTH: 'true', MOCK_OIDC: 'false', SESSION_SECRET: secretRef('SESSION_SECRET'), LOCAL_AUTH_PUBLIC_URL: origin, APP_URL: origin,
    OSHAL_INSTALL_OWNER_SUB: options.admin.sub, OSHAL_INSTALL_OWNER_ISSUER: LOCAL_AUTH_ISSUER, OSHAL_OPERATOR_EMAILS: options.admin.email,
    UI_PROFILE: 'oshal-framework', DISABLE_ONBOARDING_GATE: 'true', OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce',
    APP_PACKAGE_DYNAMIC_ROUTES: '1', APP_PACKAGE_MIGRATIONS: '1', OSHAL_PACKAGE_AUDIT_MODE: 'compatible', OSHAL_CONCIERGE_COVERAGE_MODE: 'enforce',
    ENCRYPTION_KEY: secretRef('ENCRYPTION_KEY'), JWT_SECRET: secretRef('JWT_SECRET'), ENABLE_QUEUE_MANAGER: 'true',
    OSHAL_DELEGATION_PUBLIC_KEYS: '', OSHAL_DELEGATION_SIGNING_KID: options.delegationKid,
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: secretRef('DELEGATION_PRIVATE_KEY'),
  };
  if ((options.llmProvider || 'noop') === 'noop') env.OSHAL_NO_AI = 'true';
  return env;
}

/** @description A bot node's own posture. @param {object} options Plan options. @returns {Record<string,string>} Environment. */
function botPosture(options) {
  return {
    ...sharedPosture(options), BOT_RUNTIME: 'bot-node', DATABASE_URL: secretRef('BOT_DATABASE_URL'), DB_MAX_CONNECTIONS: '3',
    OSHAL_DELEGATION_PUBLIC_KEYS: secretRef('DELEGATION_PUBLIC_KEYS'), OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: '',
  };
}

/** @description Literal operator overrides (`--set-env`), escaped for compose. @param {Record<string,string>} setEnv Overrides. @returns {Record<string,string>} Escaped map. */
function literalOverrides(setEnv) {
  return Object.fromEntries(Object.entries(setEnv || {}).map(([key, value]) => [key, escapeCompose(value)]));
}

/** @description The sandbox api service. @param {object} ctx Build context. @returns {object} Service. */
function apiService(ctx) {
  const { topology, options, project, hazards } = ctx;
  const live = topology.services[LIVE_SERVICE.api];
  return {
    image: ctx.image, command: options.apiCommand || live.command,
    environment: { ...deriveInheritedEnv(live.environment, hazards), ...apiPosture(options, ctx.origin), ...literalOverrides(options.setEnv) },
    volumes: (live.volumes || []).map(String).filter((entry) => isNamedVolumeMount(entry, topology)),
    networks: { backend: { aliases: ctx.apiAliases }, ...(ctx.egress ? { egress: {} } : {}) },
    depends_on: { db: { condition: 'service_healthy' }, redis: { condition: 'service_healthy' } },
    ...hardening(project, MEMORY_LIMITS_MB.api),
  };
}

/** @description One sandbox bot service. @param {object} ctx Build context. @param {object} bot From extractBotService. @returns {object} Service. */
function botService(ctx, bot) {
  return {
    image: ctx.image, command: bot.command, expose: [String(API_PORT)],
    environment: { ...deriveInheritedEnv(bot.liveEnv, ctx.hazards), ...botPosture(ctx.options) },
    volumes: bot.volumes,
    networks: { backend: { aliases: bot.aliases }, ...(ctx.egress ? { egress: {} } : {}) },
    depends_on: { api: { condition: 'service_healthy' } },
    ...hardening(ctx.project, MEMORY_LIMITS_MB.bot),
  };
}

/**
 * @description Source of the gateway's TCP forwarder. It relays bytes both ways and closes both
 * sockets together, so HTTP, server-sent events and upgrades pass unchanged and the api sees the
 * caller's own Host and Origin. It exits on SIGTERM, which a process running as PID 1 otherwise
 * ignores until the stop timeout. It holds no `$`, which compose would read as a reference.
 * @param {string} host Upstream host. @param {number} port Upstream port. @param {number} listenPort Port to listen on.
 * @param {string} [listenHost] Address to bind; every interface of the container when omitted.
 * @returns {string} JavaScript for `node -e`.
 */
function forwarderScript(host, port, listenPort, listenHost) {
  const bind = listenHost === undefined ? String(Number(listenPort)) : `${Number(listenPort)},${JSON.stringify(String(listenHost))}`;
  return [
    "const net=require('net');for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));",
    `net.createServer((client)=>{const upstream=net.connect(${Number(port)},${JSON.stringify(String(host))});`,
    'const close=()=>{client.destroy();upstream.destroy()};',
    "client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);",
    `client.pipe(upstream);upstream.pipe(client)}).listen(${bind});`,
  ].join('');
}

/** @description The gateway's entrypoint: node running the forwarder to the api. @returns {string[]} Entrypoint. */
function gatewayEntrypoint() {
  return ['node', '-e', escapeCompose(forwarderScript('api', API_PORT, API_PORT))];
}

/**
 * @description The gateway: the one container with a host route. It publishes the loopback port
 * and forwards to the api on the internal network; it carries no environment and no volume.
 * @param {object} ctx Build context. @returns {object} Service.
 */
function gatewayService(ctx) {
  return {
    image: ctx.image, entrypoint: gatewayEntrypoint(),
    ports: [`${LOOPBACK}:${ctx.port}:${API_PORT}`],
    networks: { backend: {}, edge: {} },
    depends_on: { api: { condition: 'service_started' } },
    ...hardening(ctx.project, MEMORY_LIMITS_MB.gateway),
  };
}

/** @description Named volumes the services mount, declared with sandbox labels (never external, never renamed). @param {object} services Services. @param {string} project Project. @returns {object} Volumes block. */
function declaredVolumes(services, project) {
  const names = new Set();
  for (const service of Object.values(services)) for (const entry of service.volumes || []) names.add(String(entry).split(':')[0]);
  return Object.fromEntries([...names].sort().map((name) => [name, { labels: sandboxLabels(project) }]));
}

/**
 * @description Names the sandbox answers on its own backend network (the live api's and each bot's
 * service key and container name), and the live names it must never resolve (every other live
 * service, container and network, plus the host aliases).
 * @param {object} topology Topology. @param {object[]} bots Bot descriptors.
 * @returns {{apiAliases: string[], aliases: string[], hazards: string[]}} Name sets.
 */
function nameSets(topology, bots) {
  const liveApi = topology.services[LIVE_SERVICE.api];
  const apiAliases = [LIVE_SERVICE.api, liveApi.container_name].filter(Boolean);
  const aliases = [...apiAliases, ...bots.flatMap((bot) => bot.aliases)];
  const live = [...topology.serviceKeys, ...topology.containerNames, ...topology.networkNames];
  const hazards = [...new Set(live.filter((name) => !aliases.includes(name))), ...HOST_ALIASES];
  return { apiAliases, aliases, hazards };
}

/**
 * @description Build the whole sandbox plan: compose document, name sets, secret and forwarded
 * reference names, memory budget and the admin identity the installer settings name.
 * @param {object} options { liveDoc, project, port, image, bots, admin:{email,sub}, llmProvider, llmModel,
 *   forwardNames, setEnv, apiCommand, delegationKid, hostReserveMb }.
 * @returns {object} Plan.
 */
function buildSandboxPlan(options) {
  const topology = readLiveTopology(options.liveDoc);
  const project = validateProjectName(options.project);
  const port = validatePort(options.port === undefined ? DEFAULT_PORT : options.port, topology);
  const origin = `http://${LOOPBACK}:${port}`;
  const bots = (options.bots || []).map((key) => extractBotService(topology, key));
  if (bots.some((bot) => bot.key === GATEWAY)) throw new Error(`a bot service may not be named "${GATEWAY}"`);
  const names = nameSets(topology, bots);
  const egress = (options.forwardNames || []).length > 0;
  const ctx = { topology, options, project, port, origin, egress, image: options.image || topology.apiImage, hazards: names.hazards, apiAliases: names.apiAliases };
  const services = { ...infraServices(topology, project), api: apiService(ctx), [GATEWAY]: gatewayService(ctx) };
  for (const bot of bots) services[bot.key] = botService(ctx, bot);
  const labels = sandboxLabels(project);
  const compose = {
    name: project, services, volumes: declaredVolumes(services, project),
    networks: { backend: { internal: true, labels }, edge: { labels }, ...(egress ? { egress: { labels } } : {}) },
  };
  const fixedMb = MEMORY_LIMITS_MB.db + MEMORY_LIMITS_MB.redis + MEMORY_LIMITS_MB.api + MEMORY_LIMITS_MB.gateway;
  const botKeys = bots.map((bot) => bot.key);
  return {
    evidenceLabel: EVIDENCE_LABEL, project, port, origin, image: ctx.image, compose, topology, bots: botKeys,
    aliases: names.aliases, hazards: names.hazards, secretRefs: referencedNames(compose), egress, probeServices: ['api', ...botKeys],
    forwardNames: [...(options.forwardNames || [])], budgetMb: fixedMb + bots.length * MEMORY_LIMITS_MB.bot,
    hostReserveMb: options.hostReserveMb ?? DEFAULT_HOST_RESERVE_MB,
    workspaceVolume: `${project}_${workspaceVolumeKey(services.api)}`,
  };
}

/** @description The api volume key mounted at the shared workspace. @param {object} api Api service. @returns {string} Volume key. */
function workspaceVolumeKey(api) {
  const entry = (api.volumes || []).find((mount) => String(mount).split(':')[1] === WORKSPACE_MOUNT);
  if (!entry) throw new Error(`the live api mounts no named volume at ${WORKSPACE_MOUNT}`);
  return String(entry).split(':')[0];
}

/** @description Every ${OSHAL_SANDBOX_*} name a compose document references. @param {object} compose Document. @returns {string[]} Sorted names. */
function referencedNames(compose) {
  const names = new Set();
  const text = JSON.stringify(compose);
  for (const match of text.matchAll(/(?<!\$)\$\{(OSHAL_SANDBOX_[A-Z0-9_]+)\}/g)) names.add(match[1]);
  return [...names].sort();
}

/**
 * @description Generate the sandbox's own disposable secrets (never an operator value): database
 * passwords and URLs for the three roles, session/service/encryption/JWT secrets and a fresh Ed25519
 * delegation key pair, keyed by the reference names the compose file uses. The two runtime role
 * passwords are 48 hexadecimal characters: the role provisioner the api boot command runs accepts
 * nothing else outside the development defaults.
 * @param {object} deps { randomBytes, generateKeyPairSync }. @param {object} plan From buildSandboxPlan.
 * @returns {Map<string,string>} Reference name -> value.
 */
function generateSandboxSecrets(deps, plan) {
  const token = (bytes) => deps.randomBytes(bytes).toString('base64url');
  const rolePassword = () => deps.randomBytes(24).toString('hex');
  const dbEnv = plan.compose.services.db.environment;
  const liveApi = envMap(plan.topology.services[LIVE_SERVICE.api].environment);
  const roleOf = (key) => new URL(resolveComposeDefaults(String(liveApi[key] || '')).value).username;
  const dsn = (user, password) => `postgresql://${user}:${password}@db:5432/${dbEnv.POSTGRES_DB}`;
  const superPassword = token(24);
  const { privateKey, publicKey } = deps.generateKeyPairSync('ed25519');
  const kid = plan.compose.services.api.environment.OSHAL_DELEGATION_SIGNING_KID;
  const values = new Map([
    ['PG_PASSWORD', superPassword],
    ['BOOTSTRAP_DATABASE_URL', dsn(dbEnv.POSTGRES_USER, superPassword)],
    ['DATABASE_URL', dsn(roleOf('DATABASE_URL'), rolePassword())],
    ['BOT_DATABASE_URL', dsn(roleOf('BOT_DATABASE_URL'), rolePassword())],
    ['SESSION_SECRET', token(48)], ['SWARM_SERVICE_SECRET', token(48)], ['JWT_SECRET', token(48)],
    ['ENCRYPTION_KEY', deps.randomBytes(32).toString('base64')],
    ['DELEGATION_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['DELEGATION_PUBLIC_KEYS', JSON.stringify({ [kid]: publicKey.export({ type: 'spki', format: 'pem' }) })],
  ]);
  return new Map([...values].map(([name, value]) => [`${REF_PREFIX}${name}`, String(value)]));
}

/** @description Why a service may not join a network, or null. @param {string} name Service key. @param {string} network Network key. @param {object} plan Plan. @returns {string|null} Reason. */
function networkRefusal(name, network, plan) {
  if (!SANDBOX_NETWORKS.includes(network)) return `joins "${network}", which is not a sandbox network`;
  if (network === 'edge' && name !== GATEWAY) return 'only the gateway may join the edge network (it has a host route)';
  if (network !== 'egress') return null;
  if (!(plan.forwardNames || []).length) return 'joins the egress network although no credential is forwarded';
  return name === 'api' || (plan.bots || []).includes(name) ? null : 'only the api and the bots may join the egress network';
}

/** @description Problems with the networks one service joins. @param {string} name Service key. @param {object} service Service. @param {object} compose Document. @param {object} plan Plan. @returns {string[]} Problems. */
function networkProblems(name, service, compose, plan) {
  const problems = [];
  if (service.network_mode) problems.push(`${name}: network_mode "${service.network_mode}" bypasses the sandbox networks`);
  if (service.container_name) problems.push(`${name}: container_name is set (names must come from the sandbox project)`);
  const networks = Array.isArray(service.networks) ? service.networks : Object.keys(service.networks || {});
  if (!networks.includes('backend')) problems.push(`${name}: must join the internal backend network`);
  for (const network of networks) {
    const refusal = networkRefusal(name, network, plan);
    if (!compose.networks || !compose.networks[network]) problems.push(`${name}: joins undeclared network "${network}"`);
    if (refusal) problems.push(`${name}: ${refusal}`);
  }
  return problems;
}

/** @description Problems with one service's volumes and published ports. @param {string} name Service key. @param {object} service Service. @param {object} compose Document. @param {object} topology Topology. @returns {string[]} Problems. */
function wiringProblems(name, service, compose, topology) {
  const problems = [];
  for (const mount of service.volumes || []) {
    const text = typeof mount === 'string' ? mount : JSON.stringify(mount);
    if (/docker\.sock/.test(text)) problems.push(`${name}: mounts the docker socket`);
    const source = typeof mount === 'string' ? mount.split(':')[0] : mount.source;
    if (!compose.volumes || !compose.volumes[source]) problems.push(`${name}: mount "${text}" is not a declared sandbox volume (bind mounts are refused)`);
  }
  for (const port of service.ports || []) {
    const text = String(typeof port === 'object' ? `${port.host_ip || ''}:${port.published}:${port.target}` : port);
    const parts = text.split(':');
    if (name !== GATEWAY) problems.push(`${name}: only the gateway may publish a port (${text})`);
    if (parts[0] !== LOOPBACK) problems.push(`${name}: port ${text} is not bound to ${LOOPBACK}`);
    if (topology.publishedPorts.includes(Number(parts[1]))) problems.push(`${name}: port ${text} collides with a live published port`);
  }
  return problems;
}

/**
 * @description The gateway has a host route, so it may be nothing but the forwarder: the exact
 * entrypoint, no command, no environment, no volume.
 * @param {object} gateway The gateway service, if any. @returns {string[]} Problems.
 */
function gatewayProblems(gateway) {
  if (!gateway) return [`${GATEWAY}: the sandbox has no gateway (nothing else may publish the api)`];
  const problems = [];
  if (JSON.stringify(gateway.entrypoint) !== JSON.stringify(gatewayEntrypoint())) problems.push(`${GATEWAY}: its entrypoint is not the forwarder`);
  if (gateway.command !== undefined) problems.push(`${GATEWAY}: carries a command`);
  if (Object.keys(envMap(gateway.environment)).length) problems.push(`${GATEWAY}: carries environment (it has a host route and may hold nothing)`);
  if ((gateway.volumes || []).length) problems.push(`${GATEWAY}: mounts a volume (it has a host route and may hold nothing)`);
  return problems;
}

/** @description Problems with one service's labels, restart, memory and host aliases. @param {string} name Service key. @param {object} service Service. @param {string} project Project. @returns {string[]} Problems. */
function hardeningProblems(name, service, project) {
  const problems = [];
  const labels = service.labels || {};
  if (labels[SANDBOX_PROJECT_LABEL] !== project) problems.push(`${name}: missing the ${SANDBOX_PROJECT_LABEL} label`);
  if (Object.keys(labels).some((label) => label === 'oshal.tier')) problems.push(`${name}: carries oshal.tier (live Prometheus would discover it)`);
  if (service.restart !== 'no') problems.push(`${name}: restart must be "no" (got ${service.restart})`);
  if (!service.mem_limit) problems.push(`${name}: has no mem_limit`);
  if (service.pull_policy !== 'never') problems.push(`${name}: pull_policy must be "never" (the running images only)`);
  const pinned = new Set((service.extra_hosts || []).map(String));
  for (const host of HOST_ALIASES) if (!pinned.has(`${host}:${LOOPBACK}`)) problems.push(`${name}: ${host} is not pinned to ${LOOPBACK}`);
  return problems;
}

/** @description Problems with one service's environment. @param {string} name Service key. @param {object} service Service. @param {string[]} hazards Live host names. @returns {string[]} Problems. */
function environmentProblems(name, service, hazards) {
  const problems = [];
  for (const [key, raw] of Object.entries(envMap(service.environment))) {
    const value = String(raw === undefined || raw === null ? '' : raw);
    if (CONTROL_KEY.test(key)) problems.push(`${name}: ${key} is a compose/docker control variable`);
    if (isSecretKey(key) && value !== '' && !REF_PATTERN.test(value)) problems.push(`${name}: ${key} holds a literal (secrets travel by reference only)`);
    if (URL_WITH_PASSWORD.test(value)) problems.push(`${name}: ${key} embeds a credential in a URL`);
    const host = namedHost(value, hazards);
    if (host) problems.push(`${name}: ${key} names the live host "${host}"`);
    if (namesHostPath(value)) problems.push(`${name}: ${key} names a host filesystem path`);
  }
  return problems;
}

/** @description The api must run the installer's LOCAL_AUTH shape under authorization enforce. @param {object} api Api service. @returns {string[]} Problems. */
function postureProblems(api) {
  const env = envMap(api && api.environment);
  const expected = { LOCAL_AUTH: 'true', MOCK_OIDC: 'false', OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce', BOT_RUNTIME: 'swarm' };
  return Object.entries(expected).filter(([key, value]) => env[key] !== value).map(([key, value]) => `api: ${key} must be ${value} (got ${env[key]})`);
}

/** @description Problems with the declared networks and volumes. @param {object} compose Document. @param {object} plan Plan (forwardNames). @returns {string[]} Problems. */
function declarationProblems(compose, plan) {
  const problems = [];
  for (const [kind, block] of [['network', compose.networks || {}], ['volume', compose.volumes || {}]]) {
    for (const [key, spec] of Object.entries(block)) {
      if (spec && spec.external) problems.push(`${kind} ${key}: external ${kind}s are refused`);
      if (spec && spec.name) problems.push(`${kind} ${key}: an explicit name escapes the project prefix`);
      if (!spec || !spec.labels || spec.labels[SANDBOX_PROJECT_LABEL] !== compose.name) problems.push(`${kind} ${key}: missing the ${SANDBOX_PROJECT_LABEL} label`);
    }
  }
  if (!compose.networks || !compose.networks.backend || compose.networks.backend.internal !== true) problems.push('network backend: must be internal (no egress, no host route)');
  if (compose.networks && compose.networks.egress && !(plan.forwardNames || []).length) problems.push('network egress: declared although no credential is forwarded');
  return problems;
}

/**
 * @description Every static reason this compose document could reach, share or leak into the live
 * stack. Empty means the document is isolated by construction; the CLI refuses to start otherwise.
 * @param {object} compose Document from buildSandboxPlan. @param {object} plan Plan (topology, hazards).
 * @returns {string[]} Problems, one per violation.
 */
function isolationProblems(compose, plan) {
  const problems = [];
  if (!PROJECT_PATTERN.test(String(compose.name)) || compose.name === plan.topology.projectName) problems.push(`project "${compose.name}" is not a sandbox project`);
  problems.push(...declarationProblems(compose, plan));
  for (const [name, service] of Object.entries(compose.services || {})) {
    if (plan.topology.serviceKeys.includes(name) && !plan.bots.includes(name)) problems.push(`${name}: reuses a live service key`);
    problems.push(...networkProblems(name, service, compose, plan));
    problems.push(...wiringProblems(name, service, compose, plan.topology));
    problems.push(...hardeningProblems(name, service, compose.name));
    problems.push(...environmentProblems(name, service, plan.hazards));
  }
  problems.push(...gatewayProblems(compose.services && compose.services[GATEWAY]));
  problems.push(...postureProblems(compose.services && compose.services.api));
  return problems;
}

/**
 * @description Connect targets for the probe from the running live containers: each address of each
 * container, on each TCP port its image exposes. Names never resolve from a sandbox network, so the
 * address is what a route would be reached by.
 * @param {string[]} rows `docker inspect` lines of the form "<ip> <ip> |<port>/tcp <port>/udp ".
 * @returns {{host: string, port: number}[]} Unique targets.
 */
function parseLiveAddresses(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const [addresses = '', ports = ''] = String(row).split('|');
    const hosts = addresses.split(/\s+/).filter((item) => /^\d{1,3}(\.\d{1,3}){3}$/.test(item));
    const tcp = ports.split(/\s+/).map((item) => /^(\d+)\/tcp$/.exec(item)).filter(Boolean).map((match) => Number(match[1]));
    for (const host of hosts) for (const port of tcp) seen.set(`${host}:${port}`, { host, port });
  }
  return [...seen.values()];
}

/** @description Problems with the routes and connects one container reported. @param {object} result Probe result. @param {boolean} egress Whether provider egress was requested. @returns {string[]} Problems. */
function routeProblems(result, egress) {
  const problems = [];
  const routes = result && result.defaultRoutes;
  if (!Array.isArray(routes)) problems.push('probe did not report its default routes');
  else if (!egress && routes.length) problems.push(`has a default route (${routes.join(',')}) although it must sit on the internal network only`);
  for (const [target, state] of Object.entries((result && result.connects) || {})) if (state === 'open') problems.push(`${target} accepted a connection from the sandbox`);
  return problems;
}

/**
 * @description Verdict on the in-container probe: every live-only name must fail to resolve, a
 * sandbox alias may resolve only to a sandbox container, the host aliases only to loopback, no live
 * container address and no live published port may accept a connection, and without provider egress
 * the container may have no default route at all.
 * @param {object} result { resolved: {name: string[]|null}, connects: {"host:port": state}, defaultRoutes: string[] }.
 * @param {object} expect { hazards: string[], aliases: string[], sandboxIps: string[], egress: boolean }.
 * @returns {string[]} Problems.
 */
function evaluateIsolationProbe(result, expect) {
  const problems = [];
  const resolved = (result && result.resolved) || {};
  for (const name of expect.hazards) {
    const ips = resolved[name];
    if (!(name in resolved)) problems.push(`probe did not report ${name}`);
    else if (HOST_ALIASES.includes(name)) { if (ips && ips.some((ip) => ip !== LOOPBACK)) problems.push(`${name} resolves off loopback (${ips.join(',')})`); }
    else if (ips && ips.length) problems.push(`live name ${name} resolves from the sandbox (${ips.join(',')})`);
  }
  for (const name of expect.aliases) {
    const ips = resolved[name] || [];
    const foreign = ips.filter((ip) => !expect.sandboxIps.includes(ip));
    if (foreign.length) problems.push(`sandbox alias ${name} resolves outside the sandbox (${foreign.join(',')})`);
  }
  return [...problems, ...routeProblems(result, expect.egress === true)];
}

/**
 * @description The stated RAM floor: the host keeps the sandbox budget plus a reserve free, and the
 * Docker engine has the budget as headroom. Any unreadable figure refuses (fail closed).
 * @param {object} reading { hostFreeMb, engineTotalMb, engineUsedMb, budgetMb, hostReserveMb }.
 * @returns {{ok: boolean, floorMb: number, engineHeadroomMb: number, reasons: string[]}} Verdict.
 */
function evaluateRamGuard(reading) {
  const { hostFreeMb, engineTotalMb, engineUsedMb, budgetMb, hostReserveMb } = reading;
  const floorMb = budgetMb + hostReserveMb;
  const reasons = [];
  const known = [hostFreeMb, engineTotalMb, engineUsedMb, budgetMb, hostReserveMb].every(Number.isFinite);
  if (!known) return { ok: false, floorMb, engineHeadroomMb: NaN, reasons: ['memory could not be read (host free, engine total or engine usage) - refusing'] };
  const engineHeadroomMb = engineTotalMb - engineUsedMb;
  if (hostFreeMb < floorMb) reasons.push(`host free memory ${Math.round(hostFreeMb)} MB is below the floor ${floorMb} MB (sandbox ${budgetMb} MB + reserve ${hostReserveMb} MB)`);
  if (engineHeadroomMb < budgetMb) reasons.push(`Docker engine headroom ${Math.round(engineHeadroomMb)} MB (total ${Math.round(engineTotalMb)} - in use ${Math.round(engineUsedMb)}) is below the sandbox budget ${budgetMb} MB`);
  return { ok: reasons.length === 0, floorMb, engineHeadroomMb, reasons };
}

/**
 * @description Sum `docker stats --format {{.MemUsage}}` lines ("123.4MiB / 5.787GiB") in MB.
 * @param {string} text Command output. @returns {number} Megabytes in use (NaN when a line is unparseable).
 */
function parseDockerMemUsage(text) {
  const factor = { B: 1 / 1048576, KIB: 1 / 1024, MIB: 1, GIB: 1024, TIB: 1048576, KB: 1000 / 1048576, MB: 1e6 / 1048576, GB: 1e9 / 1048576 };
  let total = 0;
  for (const line of String(text).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^([\d.]+)\s*([KMGT]?i?B)\s*\//i.exec(line);
    if (!match || !(match[2].toUpperCase() in factor)) return NaN;
    total += Number(match[1]) * factor[match[2].toUpperCase()];
  }
  return total;
}

/**
 * @description Teardown receipt: what the project owned before, what is gone and what is left. Any
 * leftover object (or a surviving state directory holding the sandbox credentials) is red.
 * @param {object} input { project, before: {containers, volumes, networks}, after: {...}, stateDirRemoved }.
 * @returns {object} Receipt with ok, removed, leftover.
 */
function buildTeardownReceipt(input) {
  const kinds = ['containers', 'volumes', 'networks'];
  const removed = {};
  const leftover = {};
  for (const kind of kinds) {
    const after = new Set((input.after && input.after[kind]) || []);
    removed[kind] = ((input.before && input.before[kind]) || []).filter((name) => !after.has(name));
    leftover[kind] = [...after];
  }
  const clean = kinds.every((kind) => leftover[kind].length === 0);
  return { evidenceLabel: EVIDENCE_LABEL, project: input.project, ok: clean && input.stateDirRemoved === true, removed, leftover, stateDirRemoved: input.stateDirRemoved === true };
}

/** @description Receipt as printable lines. @param {object} receipt From buildTeardownReceipt. @returns {string[]} Lines. */
function formatTeardownReceipt(receipt) {
  const list = (items) => (items.length ? items.join(', ') : 'none');
  const lines = [`teardown receipt ${receipt.project}: ${receipt.ok ? 'CLEAN' : 'RED - something was left over'}`];
  for (const kind of ['containers', 'volumes', 'networks']) {
    lines.push(`  removed ${kind}: ${list(receipt.removed[kind])}`);
    lines.push(`  leftover ${kind}: ${list(receipt.leftover[kind])}`);
  }
  lines.push(`  state directory (credentials) removed: ${receipt.stateDirRemoved ? 'yes' : 'NO'}`);
  return lines;
}

module.exports = {
  EVIDENCE_LABEL, PROJECT_PATTERN, SANDBOX_LABEL, SANDBOX_PROJECT_LABEL, LIVE_SERVICE, MEMORY_LIMITS_MB, DEFAULT_HOST_RESERVE_MB,
  DEFAULT_PORT, API_PORT, GATEWAY, LOCAL_AUTH_ISSUER, HOST_ALIASES, LOOPBACK, WORKSPACE_MOUNT,
  resolveComposeDefaults, readLiveTopology, validateProjectName, mintProjectName, deriveInheritedEnv, extractBotService,
  forwarderScript, buildSandboxPlan, generateSandboxSecrets, referencedNames, isolationProblems, parseLiveAddresses,
  evaluateIsolationProbe, evaluateRamGuard, parseDockerMemUsage, buildTeardownReceipt, formatTeardownReceipt, isSecretKey, namedHost,
};
