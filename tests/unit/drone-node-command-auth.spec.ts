/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove the standalone drone node rejects missing and incorrect machine credentials across a real HTTP/process boundary before it can mutate simulated flight state.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const SERVICE_SECRET = 'drone-node-real-boundary-fixture';
let child: ChildProcessWithoutNullStreams;
let baseUrl = '';
let childOutput = '';

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a drone-node test port');
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

function isolatedNodeEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    SWARM_SERVICE_SECRET: SERVICE_SECRET,
    DRONE_PROVIDER: 'sim',
    DRONE_NODE_ID: 'auth-boundary-drone',
    DRONE_NODE_PORT: String(port),
    DRONE_NODE_ENDPOINT: `http://127.0.0.1:${port}`,
    OSHAL_API_URL: 'http://127.0.0.1:1',
  };
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`drone node exited early: ${childOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* Process has not bound the socket yet. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`timed out waiting for drone node: ${childOutput}`);
}

async function command(commandName: string, secret?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/drone-node/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Service-Secret': secret } : {}) },
    body: JSON.stringify({ command: commandName, args: {} }),
  });
}

beforeAll(async () => {
  const port = await allocateLoopbackPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const tsxCli = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  child = spawn(process.execPath, [tsxCli, 'src/app/drone-node-server.ts'], {
    cwd: REPO_ROOT,
    env: isolatedNodeEnvironment(port),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });
  await waitForHealth();
}, 15_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit').catch(() => undefined);
});

describe('drone-node command authentication boundary', () => {
  it('rejects missing and incorrect credentials', async () => {
    expect((await command('arm')).status).toBe(401);
    expect((await command('arm', `${SERVICE_SECRET}-wrong`)).status).toBe(401);
  });

  it('executes commands only with the exact configured credential', async () => {
    const arm = await command('arm', SERVICE_SECRET);
    expect(arm.status).toBe(200);
    expect((await arm.json()).telemetry.status).toBe('armed');
    expect((await command('disarm', 'wrong')).status).toBe(401);
    const disarm = await command('disarm', SERVICE_SECRET);
    expect(disarm.status).toBe(200);
    expect((await disarm.json()).telemetry.status).toBe('disarmed');
  });
});
