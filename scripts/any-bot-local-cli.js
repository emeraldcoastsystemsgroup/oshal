#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added cross-platform local any-bot installer and launcher for macOS, Windows, and Linux
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added app-port conflict detection and dependency readiness checks before local startup
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added Google Search MCP to the local dependency launcher and env generation flow
 */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const MODULE_NAME = 'any-bot-local-cli';
const DEFAULT_BASE_DIR = path.join(os.homedir(), '.oshal-any-bot-local');
const DEFAULT_PORT = 3456;
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_POSTGRES_PORT = 55432;
const DEFAULT_REDIS_PORT = 56379;
const DEFAULT_CHROMADB_PORT = 58000;
const DEFAULT_GOOGLE_SEARCH_MCP_PORT = 58080;
const COMPOSE_PROJECT_NAME = 'oshal-any-bot-local';
const HEALTH_TIMEOUT_MS = 30000;

/** @description Entrypoint for the cross-platform local any-bot launcher CLI. */
async function main() {
  const startedAt = Date.now();

  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help || parsed.command === 'help') {
      printUsage();
      return;
    }

    const config = buildRuntimeConfig(parsed.options);
    logEvent('info', 'Starting local any-bot command', {
      command: parsed.command,
      baseDir: config.baseDir,
      dryRun: parsed.options.dryRun,
    });

    await dispatchCommand(parsed.command, config, parsed.options);

    logEvent('info', 'Local any-bot command completed', {
      command: parsed.command,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logEvent('error', 'Local any-bot command failed', {
      durationMs: Date.now() - startedAt,
      error: serializeError(error),
    });
    process.exit(1);
  }
}

/** @description Parses command-line arguments into a command name and option map. */
function parseArguments(args) {
  const options = {
    dryRun: false,
    detached: false,
    skipDeps: false,
    noBrowser: false,
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--help' || token === '-h') {
      return { command: 'help', options, help: true };
    }

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const optionName = token.slice(2);
    if (['dry-run', 'detached', 'skip-deps', 'no-browser'].includes(optionName)) {
      options[toCamelCase(optionName)] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for option --${optionName}`);
    }

    options[toCamelCase(optionName)] = value;
    index += 1;
  }

  return {
    command: positional[0] || 'help',
    options,
    help: false,
  };
}

/** @description Dispatches the parsed command to the appropriate handler. */
async function dispatchCommand(command, config, options) {
  if (command === 'init') {
    await handleInit(config, options);
    return;
  }

  if (command === 'start') {
    await handleStart(config, options);
    return;
  }

  if (command === 'stop') {
    await handleStop(config, options);
    return;
  }

  if (command === 'status') {
    await handleStatus(config, options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

/** @description Creates the resolved runtime configuration for local any-bot execution. */
function buildRuntimeConfig(options) {
  const baseDir = path.resolve(options.baseDir || DEFAULT_BASE_DIR);
  const appPort = parsePositiveInteger(options.port, DEFAULT_PORT);
  const callbackPort = parsePositiveInteger(options.openaiCallbackPort, DEFAULT_CALLBACK_PORT);
  const postgresPort = parsePositiveInteger(options.postgresPort, DEFAULT_POSTGRES_PORT);
  const redisPort = parsePositiveInteger(options.redisPort, DEFAULT_REDIS_PORT);
  const chromadbPort = parsePositiveInteger(options.chromadbPort, DEFAULT_CHROMADB_PORT);
  const googleSearchMcpPort = parsePositiveInteger(options.googleSearchMcpPort, DEFAULT_GOOGLE_SEARCH_MCP_PORT);
  const packageRoot = path.resolve(__dirname, '..');

  const config = {
    baseDir,
    packageRoot,
    composeFile: path.resolve(__dirname, 'any-bot-local-deps.compose.yaml'),
    envFile: path.join(baseDir, 'any-bot-local.env'),
    logDir: path.join(baseDir, 'logs'),
    outputDir: path.join(baseDir, 'output'),
    runDir: path.join(baseDir, 'run'),
    serverLogFile: path.join(baseDir, 'logs', 'any-bot-local.stdout.log'),
    serverErrorFile: path.join(baseDir, 'logs', 'any-bot-local.stderr.log'),
    serverPidFile: path.join(baseDir, 'run', 'any-bot-local.pid.json'),
    sharedWorkspaceDir: path.join(baseDir, 'workspace-shared'),
    workspaceDir: path.join(baseDir, 'workspace'),
    serverEntryPoint: path.join(packageRoot, 'dist', 'app', 'server.js'),
    appPort,
    callbackPort,
    postgresPort,
    redisPort,
    chromadbPort,
    googleSearchMcpPort,
    browserUrl: `http://localhost:${appPort}/chat`,
    healthUrl: `http://127.0.0.1:${appPort}/health`,
  };

  return {
    ...config,
    defaultEnv: {
      NODE_ENV: 'production',
      PORT: String(appPort),
      OPENAI_CODEX_CALLBACK_PORT: String(callbackPort),
      APP_URL: `http://localhost:${appPort}`,
      LOG_LEVEL: 'info',
      MOCK_OIDC: 'true',
      CONFIG_OUTPUT_DIR: normalizeForEnv(config.outputDir),
      WORKSPACE_ROOT: normalizeForEnv(config.workspaceDir),
      CLINE_WORKSPACE_ROOT: normalizeForEnv(config.workspaceDir),
      SHARED_WORKSPACE_ROOT: normalizeForEnv(config.sharedWorkspaceDir),
      CLINE_SHARED_WORKSPACE_ROOT: normalizeForEnv(config.sharedWorkspaceDir),
      LLM_PROVIDER: 'noop',
      LLM_MODEL: 'claude-sonnet-4-5-20250929',
      SWARM_MODE: 'single',
      ENABLE_AGENT_SCHEDULER: 'true',
      SCHEDULER_POLL_INTERVAL_MS: '15000',
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: String(postgresPort),
      POSTGRES_DB: 'oshal',
      POSTGRES_USER: 'oshal_user',
      POSTGRES_PASSWORD: 'oshal_password',
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      CHROMADB_HOST: '127.0.0.1',
      CHROMADB_PORT: String(chromadbPort),
      CHROMADB_URL: `http://127.0.0.1:${chromadbPort}`,
      GOOGLE_SEARCH_MCP_URL: `http://127.0.0.1:${googleSearchMcpPort}/mcp`,
      ANTHROPIC_API_KEY: '',
      PRESENTRON_API_KEY: '',
      KEYCLOAK_CLIENT_SECRET: '',
    },
  };
}

/** @description Creates the local runtime directories and writes the generated env file. */
async function handleInit(config, options) {
  const startedAt = Date.now();
  logEvent('info', 'Initializing local any-bot runtime', { baseDir: config.baseDir });
  ensureRuntimeLayout(config, options.dryRun);
  writeRuntimeEnvFile(config, options.dryRun);
  logEvent('info', 'Initialized local any-bot runtime', {
    envFile: config.envFile,
    durationMs: Date.now() - startedAt,
  });
}

/** @description Starts Docker-backed dependencies and launches the local any-bot server. */
async function handleStart(config, options) {
  const startedAt = Date.now();
  ensureRuntimeLayout(config, options.dryRun);
  writeRuntimeEnvFile(config, options.dryRun);
  await ensurePortAvailable(config.appPort, options.dryRun);

  if (!options.skipDeps) {
    runComposeLifecycle(config, ['up', '-d', 'postgres', 'redis', 'chromadb', 'google-search-mcp'], options.dryRun);
    await waitForDependencies(config, options.dryRun);
  }

  if (options.dryRun) {
    logEvent('info', 'Dry-run local start prepared', {
      browserUrl: config.browserUrl,
      serverEntryPoint: config.serverEntryPoint,
      detached: options.detached,
    });
    return;
  }

  ensureFileExists(config.serverEntryPoint, 'compiled server entry point');
  const runtimeEnv = buildRuntimeEnvironment(config);

  if (options.detached) {
    await startDetachedServer(config, runtimeEnv, options.noBrowser);
  } else {
    await startForegroundServer(config, runtimeEnv, options.noBrowser);
  }

  logEvent('info', 'Local any-bot start command completed', {
    detached: options.detached,
    durationMs: Date.now() - startedAt,
  });
}

/** @description Waits for Postgres, Redis, and ChromaDB to become reachable on their local host ports. */
async function waitForDependencies(config, dryRun) {
  const dependencies = [
    { name: 'postgres', port: config.postgresPort },
    { name: 'redis', port: config.redisPort },
    { name: 'chromadb', port: config.chromadbPort },
    { name: 'google-search-mcp', port: config.googleSearchMcpPort },
  ];

  if (dryRun) {
    dependencies.forEach((dependency) => {
      logEvent('info', 'Would wait for local dependency readiness', dependency);
    });
    return;
  }

  for (const dependency of dependencies) {
    logEvent('info', 'Waiting for local dependency readiness', dependency);
    await waitForTcpPort('127.0.0.1', dependency.port, 30000, dependency.name);
  }
}

/** @description Stops the detached local any-bot server and optional dependency stack. */
async function handleStop(config, options) {
  const startedAt = Date.now();
  const pidRecord = readPidRecord(config.serverPidFile);

  if (pidRecord) {
    stopDetachedProcess(pidRecord.pid, options.dryRun);
    if (!options.dryRun && fs.existsSync(config.serverPidFile)) {
      fs.rmSync(config.serverPidFile, { force: true });
    }
  } else {
    logEvent('warn', 'No detached local any-bot server PID file found', { pidFile: config.serverPidFile });
  }

  if (!options.skipDeps) {
    runComposeLifecycle(config, ['down'], options.dryRun);
  }

  logEvent('info', 'Local any-bot stop command completed', {
    durationMs: Date.now() - startedAt,
  });
}

/** @description Reports the local runtime directories, detached server state, and HTTP health status. */
async function handleStatus(config) {
  const pidRecord = readPidRecord(config.serverPidFile);
  const serverRunning = pidRecord ? isProcessRunning(pidRecord.pid) : false;
  const health = await fetchHealthStatus(config.healthUrl);

  logEvent('info', 'Local any-bot status', {
    baseDir: config.baseDir,
    envFile: config.envFile,
    browserUrl: config.browserUrl,
    detachedServerPid: pidRecord?.pid,
    detachedServerRunning: serverRunning,
    health,
  });

  const composeInfo = detectComposeCommand(false);
  if (composeInfo.available) {
    const psResult = spawnSync(composeInfo.command, [...composeInfo.args, '-p', COMPOSE_PROJECT_NAME, '-f', config.composeFile, 'ps'], {
      encoding: 'utf8',
      env: buildComposeEnvironment(config),
    });
    if (psResult.status === 0 && psResult.stdout.trim().length > 0) {
      process.stdout.write(psResult.stdout);
    }
  }
}

/** @description Ensures local runtime directories exist or logs the planned actions in dry-run mode. */
function ensureRuntimeLayout(config, dryRun) {
  const directories = [
    config.baseDir,
    config.logDir,
    config.outputDir,
    config.runDir,
    config.workspaceDir,
    config.sharedWorkspaceDir,
  ];

  directories.forEach((directoryPath) => {
    if (dryRun) {
      logEvent('info', 'Would ensure local runtime directory', { directoryPath });
      return;
    }

    fs.mkdirSync(directoryPath, { recursive: true });
  });
}

/** @description Writes the generated local runtime env file while preserving existing overrides. */
function writeRuntimeEnvFile(config, dryRun) {
  const existingValues = readEnvFile(config.envFile);
  const envValues = {
    ...config.defaultEnv,
    ...existingValues,
  };
  const content = renderEnvFileContent(config, envValues);

  if (dryRun) {
    logEvent('info', 'Would write local runtime env file', { envFile: config.envFile });
    return;
  }

  fs.writeFileSync(config.envFile, content, 'utf8');
  logEvent('info', 'Wrote local runtime env file', { envFile: config.envFile });
}

/** @description Renders the generated env file content for the local runtime. */
function renderEnvFileContent(config, values) {
  const sections = [
    ['Local runtime', ['NODE_ENV', 'PORT', 'OPENAI_CODEX_CALLBACK_PORT', 'APP_URL', 'LOG_LEVEL', 'MOCK_OIDC']],
    ['Persistence and workspace', ['CONFIG_OUTPUT_DIR', 'WORKSPACE_ROOT', 'CLINE_WORKSPACE_ROOT', 'SHARED_WORKSPACE_ROOT', 'CLINE_SHARED_WORKSPACE_ROOT']],
    ['Provider defaults', ['LLM_PROVIDER', 'LLM_MODEL', 'SWARM_MODE', 'ANTHROPIC_API_KEY', 'PRESENTRON_API_KEY']],
    ['Scheduler and dependencies', ['ENABLE_AGENT_SCHEDULER', 'SCHEDULER_POLL_INTERVAL_MS', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'REDIS_URL', 'CHROMADB_HOST', 'CHROMADB_PORT', 'CHROMADB_URL', 'GOOGLE_SEARCH_MCP_URL']],
    ['Optional auth overrides', ['KEYCLOAK_CLIENT_SECRET']],
  ];

  const lines = [
    '# oshal any-bot local runtime configuration',
    '# Generated by oshal-any-bot-local. Safe to edit and re-run.',
    `# Base directory: ${normalizeForEnv(config.baseDir)}`,
    '',
  ];

  sections.forEach(([title, keys]) => {
    lines.push(`# ${title}`);
    keys.forEach((key) => lines.push(`${key}=${quoteEnvValue(values[key] ?? '')}`));
    lines.push('');
  });

  return `${lines.join('\n').trim()}\n`;
}

/** @description Starts the dependency stack using Docker Compose or logs the planned command. */
function runComposeLifecycle(config, composeArgs, dryRun) {
  const composeInfo = detectComposeCommand(true);
  const args = [...composeInfo.args, '-p', COMPOSE_PROJECT_NAME, '-f', config.composeFile, ...composeArgs];

  if (dryRun) {
    logEvent('info', 'Would run Docker Compose for local any-bot', {
      command: formatCommand(composeInfo.command, args),
    });
    return;
  }

  logEvent('info', 'Running Docker Compose for local any-bot', {
    command: formatCommand(composeInfo.command, args),
  });

  const result = spawnSync(composeInfo.command, args, {
    stdio: 'inherit',
    env: buildComposeEnvironment(config),
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`Docker Compose exited with status ${result.status}`);
  }
}

/** @description Starts the compiled server in the foreground and optionally opens the browser. */
async function startForegroundServer(config, runtimeEnv, noBrowser) {
  logEvent('info', 'Starting local any-bot server in foreground', {
    serverEntryPoint: config.serverEntryPoint,
    browserUrl: config.browserUrl,
  });

  if (!noBrowser) {
    void waitForHealth(config.healthUrl, HEALTH_TIMEOUT_MS)
      .then(() => openBrowser(config.browserUrl))
      .catch((error) => {
        logEvent('warn', 'Browser auto-open skipped after health wait failure', { error: serializeError(error) });
      });
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [config.serverEntryPoint], {
      cwd: config.packageRoot,
      env: runtimeEnv,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Foreground any-bot server exited with status ${code}`));
    });
  });
}

/** @description Starts the compiled server as a detached background process. */
async function startDetachedServer(config, runtimeEnv, noBrowser) {
  const pidRecord = readPidRecord(config.serverPidFile);
  if (pidRecord && isProcessRunning(pidRecord.pid)) {
    logEvent('warn', 'Detached local any-bot server is already running', pidRecord);
    return;
  }

  const stdoutFd = fs.openSync(config.serverLogFile, 'a');
  const stderrFd = fs.openSync(config.serverErrorFile, 'a');
  const child = spawn(process.execPath, [config.serverEntryPoint], {
    cwd: config.packageRoot,
    env: runtimeEnv,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
  });

  child.unref();
  fs.writeFileSync(config.serverPidFile, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
  logEvent('info', 'Started detached local any-bot server', {
    pid: child.pid,
    serverLogFile: config.serverLogFile,
    serverErrorFile: config.serverErrorFile,
  });

  if (!noBrowser) {
    await waitForHealth(config.healthUrl, HEALTH_TIMEOUT_MS);
    await openBrowser(config.browserUrl);
  }
}

/** @description Builds the environment map used for the local server process. */
function buildRuntimeEnvironment(config) {
  return {
    ...process.env,
    ...readEnvFile(config.envFile),
  };
}

/** @description Builds environment variables consumed by the Docker Compose dependency stack. */
function buildComposeEnvironment(config) {
  const runtimeEnv = readEnvFile(config.envFile);
  return {
    ...process.env,
    OSHAL_POSTGRES_DB: runtimeEnv.POSTGRES_DB || config.defaultEnv.POSTGRES_DB,
    OSHAL_POSTGRES_USER: runtimeEnv.POSTGRES_USER || config.defaultEnv.POSTGRES_USER,
    OSHAL_POSTGRES_PASSWORD: runtimeEnv.POSTGRES_PASSWORD || config.defaultEnv.POSTGRES_PASSWORD,
    OSHAL_POSTGRES_PORT: runtimeEnv.POSTGRES_PORT || config.defaultEnv.POSTGRES_PORT,
    OSHAL_REDIS_PORT: String(config.redisPort),
    OSHAL_CHROMADB_PORT: String(config.chromadbPort),
    OSHAL_GOOGLE_SEARCH_MCP_PORT: String(config.googleSearchMcpPort),
  };
}

/** @description Detects an available Docker Compose command across supported operating systems. */
function detectComposeCommand(required) {
  const dockerCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  if ((dockerCompose.status ?? 1) === 0) {
    return { available: true, command: 'docker', args: ['compose'] };
  }

  const legacyCompose = spawnSync('docker-compose', ['version'], { stdio: 'ignore' });
  if ((legacyCompose.status ?? 1) === 0) {
    return { available: true, command: 'docker-compose', args: [] };
  }

  if (required) {
    throw new Error('Docker Compose is required. Install Docker Desktop or Docker Engine with Compose support, or rerun with --skip-deps.');
  }

  return { available: false, command: '', args: [] };
}

/** @description Waits for a TCP port to accept connections before continuing startup. */
async function waitForTcpPort(host, port, timeoutMs, dependencyName) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await canConnectToPort(host, port);
    if (reachable) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(1000);
  }

  throw new Error(`Timed out waiting for ${dependencyName} on ${host}:${port}`);
}

/** @description Checks whether a local TCP port accepts a connection. */
async function canConnectToPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    socket.on('connect', () => {
      socket.end();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** @description Prevents startup when another process is already bound to the requested app port. */
function ensurePortAvailable(port, dryRun) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', (error) => {
      if (dryRun) {
        logEvent('warn', 'Detected port conflict during dry-run local start', {
          port,
          error: serializeError(error),
        });
        resolve();
        return;
      }

      reject(new Error(`Port ${port} is already in use. Stop the other service or rerun with --port <number>.`));
    });

    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve());
    });
  });
}

/** @description Waits until the local health endpoint responds successfully. */
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await fetchHealthStatus(url);
    if (status.reachable) {
      return;
    }
    await delay(1000);
  }

  throw new Error(`Timed out waiting for local any-bot health at ${url}`);
}

/** @description Reads HTTP health for the local any-bot runtime without throwing on failure. */
async function fetchHealthStatus(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      response.resume();
      resolve({ reachable: response.statusCode === 200, statusCode: response.statusCode ?? null });
    });

    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });

    request.on('error', (error) => {
      resolve({ reachable: false, statusCode: null, error: serializeError(error) });
    });
  });
}

/** @description Opens the browser on macOS, Windows, or Linux using the host-default handler. */
async function openBrowser(url) {
  const platform = process.platform;
  const commands = {
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '', url]],
    linux: ['xdg-open', [url]],
  };
  const [command, args] = commands[platform] || commands.linux;

  logEvent('info', 'Opening browser for local any-bot', { url, command });

  await new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', (error) => {
      logEvent('warn', 'Failed to open browser automatically', { url, error: serializeError(error) });
      resolve();
    });

    child.unref();
    resolve();
  });
}

/** @description Stops the detached Node process using the appropriate OS-specific mechanism. */
function stopDetachedProcess(pid, dryRun) {
  if (dryRun) {
    logEvent('info', 'Would stop detached local any-bot server', { pid });
    return;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
    if ((result.status ?? 1) !== 0) {
      throw new Error(`Failed to stop Windows process ${pid}`);
    }
    return;
  }

  process.kill(pid, 'SIGTERM');
}

/** @description Reads the detached server PID record when present and well-formed. */
function readPidRecord(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    logEvent('warn', 'Failed to parse detached PID file', { filePath, error: serializeError(error) });
    return null;
  }
}

/** @description Checks whether a process ID is currently active. */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

/** @description Reads key/value pairs from an env file or returns an empty object when absent. */
function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
}

/** @description Throws when a required packaged file is missing. */
function ensureFileExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`);
  }
}

/** @description Prints CLI usage instructions for the local installer and launcher. */
function printUsage() {
  process.stdout.write(`oshal-any-bot-local\n\nUsage:\n  oshal-any-bot-local <command> [options]\n\nCommands:\n  init      Create local runtime folders and the generated env file\n  start     Start Docker-backed dependencies and launch local any-bot\n  stop      Stop the detached local server and dependency containers\n  status    Print local runtime status and dependency state\n  help      Show this usage text\n\nOptions:\n  --base-dir <path>              Override the runtime base directory\n  --port <number>                Override the app port (default: 3456)\n  --openai-callback-port <n>     Override the callback port (default: 1455)\n  --postgres-port <number>       Override the host Postgres port (default: 55432)\n  --redis-port <number>          Override the host Redis port (default: 56379)\n  --chromadb-port <number>       Override the host ChromaDB port (default: 58000)\n  --google-search-mcp-port <n>   Override the host Google Search MCP port (default: 58080)\n  --skip-deps                    Skip Docker dependency startup/shutdown\n  --detached                     Run the any-bot server in the background\n  --no-browser                   Do not auto-open the browser\n  --dry-run                      Print planned actions without changing the system\n  --help                         Show this usage text\n\nExamples:\n  oshal-any-bot-local init\n  oshal-any-bot-local start --detached\n  oshal-any-bot-local start --skip-deps --no-browser\n  oshal-any-bot-local stop\n  oshal-any-bot-local status\n`);
}

/** @description Parses a positive integer string and falls back when invalid. */
function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** @description Converts dashed CLI option names into camelCase object keys. */
function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, group) => group.toUpperCase());
}

/** @description Normalizes filesystem paths so env files remain cross-platform friendly. */
function normalizeForEnv(filePath) {
  return path.resolve(filePath).replaceAll(path.sep, '/');
}

/** @description Quotes env values so spaces and Windows paths round-trip safely. */
function quoteEnvValue(value) {
  return JSON.stringify(String(value));
}

/** @description Formats a command and argument array for logging. */
function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

/** @description Produces a structured JSON log event on stdout or stderr. */
function logEvent(level, message, context = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    module: MODULE_NAME,
    message,
    ...context,
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(record)}\n`);
}

/** @description Converts unknown thrown values into structured error metadata. */
function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

/** @description Returns a Promise that resolves after the provided millisecond delay. */
function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

void main();
