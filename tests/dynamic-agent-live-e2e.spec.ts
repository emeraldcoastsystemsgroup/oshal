/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Opt-in live Docker E2E for dynamic tool registration and dynamic bot launch
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL fallback follows PLAYWRIGHT_PORT via the shared apiOrigin() helper (127.0.0.1 hostname kept deliberately — IPv4 loopback dodges the wslrelay ::1 wedge); OSHAL_E2E_BASE_URL still wins when set (byte-identical under the default env)
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { test, expect } from '@playwright/test';
import { apiOrigin } from './helpers';

const BASE_URL = process.env.OSHAL_E2E_BASE_URL ?? apiOrigin('127.0.0.1');
const RUN_LIVE_E2E = process.env.RUN_DYNAMIC_AGENT_E2E === 'true';

test.describe('dynamic agent live Docker E2E', () => {
  test.skip(!RUN_LIVE_E2E, 'Set RUN_DYNAMIC_AGENT_E2E=true against a running docker-compose.oshal-local.yml stack.');

  test('registers a runtime tool, creates a dynamic agent, launches a bot-node container, and publishes routing metadata', async () => {
    test.setTimeout(240_000);

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const agentName = `e2e-dynamic-bot-${stamp}`;
    const toolName = `e2e-runtime-tool-${stamp}`;
    const containerName = `oshal-${agentName}`;
    const personaPath = path.join(process.cwd(), 'ai-lab', 'bot-personas', `${agentName}.yaml`);
    const dynamicComposePath = path.join(process.cwd(), 'docker-compose.dynamic.yml');
    let agentId = '';

    const api = async (method: string, route: string, body?: unknown, ok = [200, 201, 204]) => {
      const response = await fetch(`${BASE_URL}${route}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!ok.includes(response.status)) {
        throw new Error(`${method} ${route} returned ${response.status}: ${text}`);
      }
      return text ? JSON.parse(text) : null;
    };

    const cleanup = async () => {
      safeExec('docker', ['rm', '-f', containerName]);
      await safeApiDelete(api, `/api/tools/runtime/${encodeURIComponent(toolName)}`);
      if (agentId) {
        await safeApiDelete(api, `/api/swarm/agents/${encodeURIComponent(agentId)}`);
      }
      if (agentId) {
        safeSql(`DELETE FROM agent_tools WHERE agent_id='${agentId.replace(/'/g, "''")}';`);
        safeSql(`DELETE FROM agents WHERE agent_id='${agentId.replace(/'/g, "''")}';`);
        safeExec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'DEL', `oshal:runtime-agent:${agentId}`]);
      }
      safeSql(`DELETE FROM runtime_tool_executors WHERE tool_name='${toolName.replace(/'/g, "''")}';`);
      safeSql(`DELETE FROM tools WHERE name='${toolName.replace(/'/g, "''")}';`);
      safeExec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'DEL', `oshal:mesh:agent.${agentName}`]);
      try { if (fs.existsSync(personaPath)) fs.unlinkSync(personaPath); } catch { /* best effort */ }
      try { if (fs.existsSync(dynamicComposePath)) fs.unlinkSync(dynamicComposePath); } catch { /* best effort */ }
    };

    try {
      await api('GET', '/health');

      const registered = await api('POST', '/api/tools/runtime/register', {
        tool: {
          name: toolName,
          displayName: `E2E Runtime Tool ${stamp}`,
          category: 'runtime',
          description: 'End-to-end runtime CLI tool registration proof',
          defaultAuthMode: 'auto',
          requiresApproval: false,
          tags: ['e2e', 'runtime-registered'],
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        },
        executor: {
          toolName,
          executorType: 'cli',
          cliCommand: 'node -e "console.log(\'runtime-e2e:\' + process.argv[1])" {input.message}',
        },
      });
      expect(registered.registered).toBeTruthy();
      expect(registered.executor.executorType).toBe('cli');

      const executorRow = sql(`SELECT tool_name || ':' || executor_type FROM runtime_tool_executors WHERE tool_name='${toolName.replace(/'/g, "''")}'`);
      expect(executorRow).toBe(`${toolName}:cli`);

      const created = await api('POST', '/api/swarm/agents', {
        name: agentName,
        systemPrompt: 'You are an E2E dynamic framework validation bot. Keep responses short and factual.',
        role: 'E2E Dynamic Validation Bot',
        topology: 'swarm',
        constraints: ['Only used for automated end-to-end validation.'],
        capabilities: ['dynamic-runtime-validation', 'runtime-tool-use'],
        routingKeywords: ['dynamic-runtime-validation', agentName],
        selectorDescriptor: 'Routes end-to-end dynamic framework validation tasks.',
        toolAssignments: [{ toolName, authMode: 'auto' }],
      });
      expect(created.success).toBeTruthy();
      agentId = created.agentId;
      expect(agentId).toBeTruthy();

      expect(fs.existsSync(personaPath)).toBeTruthy();
      expect(fs.readFileSync(personaPath, 'utf8')).toContain('dynamic-runtime-validation');

      const assignment = sql(`SELECT t.name || ':' || at.auth_mode FROM agent_tools at JOIN tools t ON t.tool_id = at.tool_id WHERE at.agent_id='${agentId}' AND t.name='${toolName.replace(/'/g, "''")}'`);
      expect(assignment).toBe(`${toolName}:auto`);

      const launched = await api('POST', `/api/agents/${encodeURIComponent(agentId)}/launch`, {});
      expect(launched.success).toBeTruthy();
      expect(fs.readFileSync(dynamicComposePath, 'utf8')).toContain('BOT_RUNTIME: bot-node');

      await waitFor(() => exec('docker', ['inspect', '-f', '{{.State.Status}}', containerName]) === 'running', 'dynamic container running');
      await waitFor(() => exec('docker', ['exec', containerName, 'wget', '-qO-', 'http://127.0.0.1:5000/health']).includes('ok'), 'dynamic bot health');

      const heartbeat = await waitForValue(() => {
        const raw = exec('docker', ['exec', 'oshal-local-redis', 'redis-cli', 'GET', `oshal:runtime-agent:${agentId}`]);
        return raw && raw !== '(nil)' ? JSON.parse(raw) : null;
      }, 'runtime heartbeat');
      expect(heartbeat.agentName).toBe(agentName);
      expect(heartbeat.status).toBe('online');
      expect(heartbeat.role).toBe('E2E Dynamic Validation Bot');
      expect(heartbeat.capabilities).toEqual(expect.arrayContaining(['dynamic-runtime-validation', 'runtime-tool-use']));
      expect(heartbeat.internalEndpointUrl).toBe(`http://${agentName}:5000`);

      const registry = await api('GET', '/api/swarm/bots/registry');
      const bots = Array.isArray(registry) ? registry : (registry.bots ?? registry.agents ?? []);
      expect(bots.some((bot: Record<string, unknown>) => bot.agentId === agentId || bot.name === agentName || bot.id === agentId)).toBeTruthy();

      const logs = exec('docker', ['logs', '--tail', '120', containerName]);
      expect(logs).toContain(`agent.${agentId}`);
      expect(logs).toContain(`agent.${agentName}`);
      expect(logs).toContain('swarm.capabilities');
    } finally {
      await cleanup();
    }
  });
});

function exec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function safeExec(cmd: string, args: string[]): void {
  try { exec(cmd, args); } catch { /* best effort */ }
}

function sql(query: string): string {
  return exec('docker', ['exec', 'oshal-local-db', 'psql', '-U', 'oshal', '-d', 'oshal', '-At', '-c', query]);
}

function safeSql(query: string): void {
  try { sql(query); } catch { /* best effort */ }
}

async function safeApiDelete(api: (method: string, route: string, body?: unknown, ok?: number[]) => Promise<unknown>, route: string): Promise<void> {
  try { await api('DELETE', route, undefined, [200, 204, 404]); } catch { /* best effort */ }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const value = await waitForValue(() => predicate() ? true : null, label, timeoutMs);
  expect(value).toBeTruthy();
}

async function waitForValue<T>(read: () => T | null, label: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`${label} timed out${lastError ? `; last error: ${lastError}` : ''}`);
}
