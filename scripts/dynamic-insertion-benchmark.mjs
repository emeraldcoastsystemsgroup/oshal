#!/usr/bin/env node
/**
 * Dynamic insertion benchmark for OSHAL.
 *
 * This script validates runtime tool registration plus dynamic bot insertion
 * against a running docker-compose.oshal-local.yml stack. It creates temporary
 * tools, agents, persona files, containers, Redis keys, and a dynamic compose
 * overlay, then removes them on success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.OSHAL_E2E_BASE_URL ?? 'http://127.0.0.1:35457';
const COUNT = Number.parseInt(process.env.STRESS_DYNAMIC_AGENT_COUNT ?? process.env.DYNAMIC_INSERTION_COUNT ?? '3', 10);
const MAX_COUNT = Number.parseInt(process.env.DYNAMIC_INSERTION_MAX_COUNT ?? '18', 10);
const CONCURRENCY = Number.parseInt(process.env.DYNAMIC_INSERTION_CONCURRENCY ?? '6', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.DYNAMIC_INSERTION_REQUEST_TIMEOUT_MS ?? '30000', 10);
const REQUEST_RETRY_ATTEMPTS = Number.parseInt(process.env.DYNAMIC_INSERTION_REQUEST_RETRY_ATTEMPTS ?? '6', 10);
const REQUEST_RETRY_DELAY_MS = Number.parseInt(process.env.DYNAMIC_INSERTION_REQUEST_RETRY_DELAY_MS ?? '2000', 10);
const DEBUG_LOG_LIMIT = Number.parseInt(process.env.DYNAMIC_INSERTION_DEBUG_LOG_LIMIT ?? '3', 10);
const RUN_ID = process.env.DYNAMIC_INSERTION_RUN_ID ?? new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const KEEP_ARTIFACTS_ON_FAILURE = process.env.KEEP_DYNAMIC_AGENT_ARTIFACTS === 'true';
const ALLOW_EXISTING_DYNAMIC_COMPOSE = process.env.ALLOW_EXISTING_DYNAMIC_COMPOSE === 'true';
const WORKSPACE_ROOT = process.cwd();
const DYNAMIC_COMPOSE_PATH = path.join(WORKSPACE_ROOT, 'docker-compose.dynamic.yml');
const STARTED_AT = Date.now();

const items = Array.from({ length: COUNT }, (_, index) => ({
  index: index + 1,
  agentName: `stress-dynamic-bot-${RUN_ID}-${index + 1}`,
  toolName: `stress-runtime-tool-${RUN_ID}-${index + 1}`,
  agentId: '',
}));

const results = [];
let keepArtifacts = false;

function log(message) {
  console.log(message);
}

function pass(name, detail = '') {
  results.push({ status: 'PASS', name, detail });
  log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`);
}

function fail(name, error) {
  const detail = error instanceof Error ? error.message : String(error);
  results.push({ status: 'FAIL', name, detail });
  log(`[FAIL] ${name} :: ${detail}`);
}

function exec(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function safeExec(cmd, args) {
  try {
    return exec(cmd, args);
  } catch {
    return '';
  }
}

function sql(query) {
  return exec('docker', ['exec', 'oshal-local-db', 'psql', '-U', 'oshal', '-d', 'oshal', '-At', '-c', query]);
}

function safeSql(query) {
  try {
    sql(query);
  } catch {
    // best effort cleanup
  }
}

async function request(method, route, body, ok = [200, 201, 204]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!ok.includes(response.status)) {
      throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 1000)}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithRetry(method, route, body, ok = [200, 201, 204], attempts = REQUEST_RETRY_ATTEMPTS) {
  let lastError = null;
  const retryCount = Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      return await request(method, route, body, ok);
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        await sleep(REQUEST_RETRY_DELAY_MS * Math.min(attempt, 3));
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function step(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
    return detail;
  } catch (error) {
    fail(name, error);
    throw error;
  }
}

async function waitFor(read, label, timeoutMs = 120_000, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out${lastError ? `; last error: ${lastError}` : ''}`);
}

function assertCount() {
  if (!Number.isFinite(COUNT) || COUNT < 1 || COUNT > MAX_COUNT) {
    throw new Error(`DYNAMIC_INSERTION_COUNT/STRESS_DYNAMIC_AGENT_COUNT must be between 1 and ${MAX_COUNT}; got ${COUNT}`);
  }
  if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > MAX_COUNT) {
    throw new Error(`DYNAMIC_INSERTION_CONCURRENCY must be between 1 and ${MAX_COUNT}; got ${CONCURRENCY}`);
  }
}

function assertNoUnexpectedDynamicCompose() {
  if (!fs.existsSync(DYNAMIC_COMPOSE_PATH)) {
    return;
  }
  if (ALLOW_EXISTING_DYNAMIC_COMPOSE) {
    return;
  }
  throw new Error(
    'docker-compose.dynamic.yml already exists. Remove it first or set ALLOW_EXISTING_DYNAMIC_COMPOSE=true if this benchmark may overwrite it.',
  );
}

async function cleanup() {
  log('[CLEANUP] removing stress containers, rows, runtime tools, redis keys, persona files, dynamic compose');
  for (const item of items) {
    safeExec('docker', ['rm', '-f', `oshal-${item.agentName}`]);

    try {
      await request('DELETE', `/api/tools/runtime/${encodeURIComponent(item.toolName)}`, undefined, [200, 404]);
    } catch {
      // best effort
    }

    if (item.agentId) {
      try {
        await request('DELETE', `/api/swarm/agents/${encodeURIComponent(item.agentId)}`, undefined, [200, 404]);
      } catch {
        // best effort
      }
      safeSql(`DELETE FROM agent_tools WHERE agent_id='${sqlEscape(item.agentId)}';`);
      safeSql(`DELETE FROM agents WHERE agent_id='${sqlEscape(item.agentId)}';`);
      safeExec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'DEL', `oshal:runtime-agent:${item.agentId}`]);
      safeExec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'DEL', `oshal:mesh:agent.${item.agentId}`]);
    }

    safeSql(`DELETE FROM runtime_tool_executors WHERE tool_name='${sqlEscape(item.toolName)}';`);
    safeSql(`DELETE FROM tools WHERE name='${sqlEscape(item.toolName)}';`);
    safeExec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'DEL', `oshal:mesh:agent.${item.agentName}`]);

    const personaPath = path.join(WORKSPACE_ROOT, 'ai-lab', 'bot-personas', `${item.agentName}.yaml`);
    try {
      if (fs.existsSync(personaPath)) {
        fs.unlinkSync(personaPath);
      }
    } catch {
      // best effort
    }
  }

  try {
    if (fs.existsSync(DYNAMIC_COMPOSE_PATH)) {
      fs.unlinkSync(DYNAMIC_COMPOSE_PATH);
    }
  } catch {
    // best effort
  }
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

async function main() {
  log(`[BENCHMARK] dynamic insertion runId=${RUN_ID} count=${COUNT} concurrency=${CONCURRENCY} baseUrl=${BASE_URL}`);

  try {
    await step('preflight', async () => {
      assertCount();
      assertNoUnexpectedDynamicCompose();
      const health = await request('GET', '/health');
      const dbReady = exec('docker', ['exec', 'oshal-local-db', 'pg_isready', '-U', 'oshal', '-d', 'oshal']);
      const redisReady = exec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'PING']);
      return `${JSON.stringify(health)}; ${dbReady}; redis=${redisReady}`;
    });

    await step('register runtime tools', async () => {
      await mapWithConcurrency(items, CONCURRENCY, async (item) => {
        const result = await request('POST', '/api/tools/runtime/register', {
          tool: {
            name: item.toolName,
            displayName: `Stress Runtime Tool ${RUN_ID} ${item.index}`,
            category: 'stress',
            description: 'Aggressive dynamic runtime tool registration stress proof',
            defaultAuthMode: 'auto',
            requiresApproval: false,
            tags: ['stress', 'runtime-registered'],
            inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          },
          executor: {
            toolName: item.toolName,
            executorType: 'cli',
            cliCommand: `node -e "console.log('stress-runtime:${item.index}:' + process.argv[1])" {input.message}`,
          },
        });
        if (!result?.registered || result.executor?.executorType !== 'cli') {
          throw new Error(`bad tool response for ${item.toolName}: ${JSON.stringify(result)}`);
        }
      });
      const rows = sql(`SELECT count(*) FROM runtime_tool_executors WHERE tool_name LIKE 'stress-runtime-tool-${sqlEscape(RUN_ID)}-%'`);
      if (Number(rows) !== COUNT) {
        throw new Error(`expected ${COUNT} runtime executors, got ${rows}`);
      }
      return `${COUNT} tools registered`;
    });

    await step('create dynamic agents with tool assignments', async () => {
      await mapWithConcurrency(items, CONCURRENCY, async (item) => {
        const result = await request('POST', '/api/swarm/agents', {
          name: item.agentName,
          systemPrompt: `You are stress validation bot ${item.index}. Keep responses short and factual.`,
          role: `Stress Dynamic Validation Bot ${item.index}`,
          topology: 'swarm',
          constraints: ['Only used for bounded dynamic insertion stress validation.'],
          capabilities: ['dynamic-runtime-validation', 'runtime-tool-use', `stress-lane-${item.index}`],
          routingKeywords: ['dynamic-runtime-validation', item.agentName, `stress-lane-${item.index}`],
          selectorDescriptor: `Routes stress validation lane ${item.index}.`,
          toolAssignments: [{ toolName: item.toolName, authMode: 'auto' }],
        });
        if (!result?.success || !result.agentId) {
          throw new Error(`bad agent response for ${item.agentName}: ${JSON.stringify(result)}`);
        }
        item.agentId = result.agentId;
      });
      const rows = sql(`SELECT count(*) FROM agents WHERE name LIKE 'stress-dynamic-bot-${sqlEscape(RUN_ID)}-%'`);
      if (Number(rows) !== COUNT) {
        throw new Error(`expected ${COUNT} agents, got ${rows}`);
      }
      return items.map((item) => `${item.agentName}=${item.agentId}`).join('; ');
    });

    await step('verify persona files and tool assignments', async () => {
      for (const item of items) {
        const personaPath = path.join(WORKSPACE_ROOT, 'ai-lab', 'bot-personas', `${item.agentName}.yaml`);
        if (!fs.existsSync(personaPath)) {
          throw new Error(`missing persona ${item.agentName}`);
        }
        const contents = fs.readFileSync(personaPath, 'utf8');
        if (!contents.includes(`stress-lane-${item.index}`)) {
          throw new Error(`persona missing stress lane ${item.agentName}`);
        }
        const assignment = sql(`SELECT t.name || ':' || at.auth_mode FROM agent_tools at JOIN tools t ON t.tool_id = at.tool_id WHERE at.agent_id='${sqlEscape(item.agentId)}' AND t.name='${sqlEscape(item.toolName)}'`);
        if (assignment !== `${item.toolName}:auto`) {
          throw new Error(`bad assignment ${item.agentName}: ${assignment}`);
        }
      }
      return `${COUNT} personas and assignments verified`;
    });

    await step('launch dynamic containers', async () => {
      await mapWithConcurrency(items, CONCURRENCY, async (item) => {
        const result = await request('POST', `/api/agents/${encodeURIComponent(item.agentId)}/launch`, {});
        if (!result?.success) {
          throw new Error(`launch failed ${item.agentName}: ${JSON.stringify(result)}`);
        }
      });
      const compose = fs.readFileSync(DYNAMIC_COMPOSE_PATH, 'utf8');
      for (const item of items) {
        if (!compose.includes(item.agentName)) {
          throw new Error(`dynamic compose missing ${item.agentName}`);
        }
      }
      return `${COUNT} launch calls returned success`;
    });

    await step('verify containers running and healthy', async () => {
      await mapWithConcurrency(items, CONCURRENCY, async (item) => {
        await waitFor(
          () => safeExec('docker', ['inspect', '-f', '{{.State.Status}}', `oshal-${item.agentName}`]) === 'running',
          `${item.agentName} running`,
        );
        await waitFor(
          () => safeExec('docker', ['exec', `oshal-${item.agentName}`, 'wget', '-qO-', 'http://127.0.0.1:5000/health']).includes('ok'),
          `${item.agentName} health`,
        );
      });
      return `${COUNT} containers healthy`;
    });

    await step('verify Redis heartbeats with routing metadata', async () => {
      await mapWithConcurrency(items, CONCURRENCY, async (item) => {
        const heartbeat = await waitFor(() => {
          const raw = safeExec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'GET', `oshal:runtime-agent:${item.agentId}`]);
          return raw && raw !== '(nil)' ? JSON.parse(raw) : null;
        }, `${item.agentName} heartbeat`);
        if (heartbeat.agentName !== item.agentName || heartbeat.status !== 'online') {
          throw new Error(`bad heartbeat identity ${item.agentName}: ${JSON.stringify(heartbeat)}`);
        }
        if (heartbeat.role !== `Stress Dynamic Validation Bot ${item.index}`) {
          throw new Error(`bad heartbeat role ${item.agentName}: ${JSON.stringify(heartbeat)}`);
        }
        if (!heartbeat.capabilities?.includes(`stress-lane-${item.index}`)) {
          throw new Error(`bad capabilities ${item.agentName}: ${JSON.stringify(heartbeat)}`);
        }
        if (heartbeat.internalEndpointUrl !== `http://${item.agentName}:5000`) {
          throw new Error(`bad internal endpoint ${item.agentName}: ${JSON.stringify(heartbeat)}`);
        }
      });
      return `${COUNT} heartbeats profile-backed`;
    });

    await step('verify registry overlay and mesh subscriptions', async () => {
      const registry = await waitFor(async () => {
        const snapshot = await requestWithRetry('GET', '/api/swarm/bots/registry', undefined, [200], 3);
        const bots = Array.isArray(snapshot) ? snapshot : (snapshot?.bots || snapshot?.agents || []);
        const missing = items.filter((item) => !hasRegistryBot(bots, item));
        return missing.length === 0 ? { bots } : null;
      }, 'registry overlay entries', 180_000, 5_000);
      const bots = registry.bots;
      for (const item of items) {
        const found = bots.find((bot) => isRegistryBotMatch(bot, item));
        if (!found) {
          throw new Error(`registry missing ${item.agentName}`);
        }
        await waitFor(() => {
          const logs = safeExec('docker', ['logs', '--tail', '160', `oshal-${item.agentName}`]);
          return logs.includes(`agent.${item.agentId}`) && logs.includes(`agent.${item.agentName}`) && logs.includes('swarm.capabilities');
        }, `${item.agentName} mesh subscriptions`, 120_000, 3_000);
      }
      return `${COUNT} registry entries and mesh subscriptions verified`;
    });

    await step('benchmark summary', async () => `count=${COUNT}; durationMs=${Date.now() - STARTED_AT}`);
  } catch (error) {
    keepArtifacts = KEEP_ARTIFACTS_ON_FAILURE;
    const debugLimit = Number.isFinite(DEBUG_LOG_LIMIT) && DEBUG_LOG_LIMIT >= 0 ? Math.min(DEBUG_LOG_LIMIT, items.length) : 3;
    for (const item of items.slice(0, debugLimit)) {
      const logs = safeExec('docker', ['logs', '--tail', '140', `oshal-${item.agentName}`]);
      if (logs) {
        log(`[DEBUG] ${item.agentName} logs:\n${logs}`);
      }
    }
    if (items.length > debugLimit) {
      log(`[DEBUG] skipped logs for ${items.length - debugLimit} containers; set DYNAMIC_INSERTION_DEBUG_LOG_LIMIT=${items.length} to print all.`);
    }
    if (!KEEP_ARTIFACTS_ON_FAILURE) {
      await cleanup();
    } else {
      log('[CLEANUP] kept artifacts after failure because KEEP_DYNAMIC_AGENT_ARTIFACTS=true');
    }
    process.exitCode = 1;
  } finally {
    if (!keepArtifacts && process.exitCode !== 1) {
      await cleanup();
      pass('cleanup completed');
    }
    log('[SUMMARY]');
    for (const result of results) {
      log(`${result.status} ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
    }
  }
}

async function mapWithConcurrency(values, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(values[currentIndex], currentIndex);
    }
  }));
}

function hasRegistryBot(bots, item) {
  return bots.some((bot) => isRegistryBotMatch(bot, item));
}

function isRegistryBotMatch(bot, item) {
  return bot?.agentId === item.agentId || bot?.name === item.agentName || bot?.id === item.agentId;
}

main().catch((error) => {
  fail('benchmark crashed', error);
  process.exit(1);
});
