/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove the node-pool control plane is fail-closed, rejects untrusted persona paths and reserved claims, never returns credentials, restores pre-assignment files, and serializes assign/release hooks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Split assignment scenarios into focused suites so governance-counted describe callbacks remain below fifty physical lines.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove crash recovery removes marked credential residue before a pool node can report idle.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: prove assignment credentials are rejected and generated provider files contain only non-secret, non-auto-approved metadata.
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodePoolRoutes, createNodePoolState } from '@/app/routes/node-pool-routes';

const ENV_KEYS = [
  'SWARM_SERVICE_SECRET',
  'NODE_POOL_PERSONA_ROOTS',
  'CONFIG_OUTPUT_DIR',
  'CLINE_CONFIG_DIR',
  'NODE_POOL_MODE',
];
const savedEnv = new Map<string, string | undefined>();
let testRoot = '';

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-node-pool-'));
  process.env.CONFIG_OUTPUT_DIR = path.join(testRoot, 'output');
  process.env.CLINE_CONFIG_DIR = path.join(testRoot, 'cline');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function serveNode(state = createNodePoolState()): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use('/node', createNodePoolRoutes(state));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function nodeRequest(
  server: TestServer,
  route: string,
  body?: Record<string, unknown>,
  secret?: string,
): Promise<Response> {
  return fetch(`${server.url}/node/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(secret ? { 'x-service-secret': secret } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function validAssignment(personaFile?: string): Record<string, unknown> {
  return {
    agentId: 'agent-1',
    ...(personaFile ? { personaFile } : {}),
    agent: 'cline',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  };
}

function createPersona(root: string, name = 'persona.yaml'): string {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  fs.writeFileSync(file, 'name: Worker\nagent_id: agent-1\nrole: worker\nperspective: safe\n');
  return file;
}

describe('node-pool route authorization', () => {
  it('fails closed when the service secret is unconfigured', async () => {
    const server = await serveNode();
    try {
      expect((await nodeRequest(server, 'status')).status).toBe(503);
    } finally {
      await server.close();
    }
  });

  it('rejects absent/wrong secrets and accepts only the exact secret', async () => {
    process.env.SWARM_SERVICE_SECRET = 'node-control-secret';
    const server = await serveNode();
    try {
      expect((await nodeRequest(server, 'status')).status).toBe(401);
      expect((await nodeRequest(server, 'status', undefined, 'wrong')).status).toBe(401);
      expect((await nodeRequest(server, 'status', undefined, 'node-control-secret')).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('node-pool persona isolation', () => {
  it('rejects persona traversal and security fields the runtime does not enforce', async () => {
    process.env.SWARM_SERVICE_SECRET = 'node-control-secret';
    const trusted = path.join(testRoot, 'trusted');
    const outside = createPersona(path.join(testRoot, 'outside'));
    process.env.NODE_POOL_PERSONA_ROOTS = trusted;
    fs.mkdirSync(trusted, { recursive: true });
    const server = await serveNode();
    try {
      const escaped = await nodeRequest(server, 'assign', validAssignment(outside), 'node-control-secret');
      const reserved = await nodeRequest(server, 'assign', {
        ...validAssignment(),
        toolAuthorizations: ['admin-everything'],
      }, 'node-control-secret');
      expect(escaped.status).toBe(400);
      expect(reserved.status).toBe(400);
    } finally {
      await server.close();
    }
  });

});

describe('node-pool credential lifecycle', () => {
  it('writes non-secret provider metadata and restores all pre-assignment files on release', async () => {
    process.env.SWARM_SERVICE_SECRET = 'node-control-secret';
    const trusted = path.join(testRoot, 'trusted');
    const personaFile = createPersona(trusted);
    process.env.NODE_POOL_PERSONA_ROOTS = trusted;
    const baselines = seedBaselineFiles();
    const server = await serveNode();
    try {
      const assigned = await nodeRequest(server, 'assign', validAssignment(personaFile), 'node-control-secret');
      const assignedText = await assigned.text();
      expect(assigned.status).toBe(200);
      expect(assignedText).not.toMatch(/api[_-]?key|access[_-]?token|secret/i);
      const config = JSON.parse(fs.readFileSync(baselines.clineConfig, 'utf8')) as Record<string, unknown>;
      expect(config).toEqual({ autoApprove: false, provider: 'anthropic', model: 'claude-sonnet-4-6' });
      const globalState = JSON.parse(fs.readFileSync(baselines.globalState, 'utf8')) as {
        mode: string;
        autoApprovalSettings: { enabled: boolean; actions: Record<string, boolean> };
      };
      expect(globalState.mode).toBe('plan');
      expect(globalState.autoApprovalSettings.enabled).toBe(false);
      expect(Object.values(globalState.autoApprovalSettings.actions).every((value) => value === false)).toBe(true);
      expect((await nodeRequest(server, 'release', {}, 'node-control-secret')).status).toBe(200);
      expect(fs.readFileSync(baselines.persona, 'utf8')).toBe('baseline-persona');
      expect(fs.readFileSync(baselines.clineConfig, 'utf8')).toBe('baseline-config');
      expect(fs.readFileSync(baselines.globalState, 'utf8')).toBe('baseline-state');
    } finally {
      await server.close();
    }
  });

  it('rejects a legacy credential carrier before creating assignment files', async () => {
    process.env.SWARM_SERVICE_SECRET = 'node-control-secret';
    const server = await serveNode();
    try {
      const rejected = await nodeRequest(server, 'assign', {
        ...validAssignment(),
        credentials: { ANTHROPIC_API_KEY: 'must-not-materialize' },
      }, 'node-control-secret');
      expect(rejected.status).toBe(400);
      expect(fs.existsSync(path.join(process.env.CONFIG_OUTPUT_DIR!, 'bot-persona.json'))).toBe(false);
      expect(fs.existsSync(path.join(process.env.CLINE_CONFIG_DIR!, 'config.json'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('scrubs marked credential residue before a restarted pool reports idle', () => {
    process.env.NODE_POOL_MODE = 'true';
    const files = seedBaselineFiles();
    const marker = path.join(process.env.CONFIG_OUTPUT_DIR!, '.node-pool-session-active');
    fs.writeFileSync(files.clineConfig, 'crash-resident-provider-secret');
    fs.writeFileSync(marker, 'interrupted\n');
    const state = createNodePoolState();
    expect(state.status).toBe('idle');
    expect(fs.existsSync(files.persona)).toBe(false);
    expect(fs.existsSync(files.clineConfig)).toBe(false);
    expect(fs.existsSync(files.globalState)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

});

describe('node-pool transition isolation', () => {
  it('serializes release behind an in-flight assignment hook', async () => {
    process.env.SWARM_SERVICE_SECRET = 'node-control-secret';
    const state = createNodePoolState();
    let finishAssign!: () => void;
    state.onAssign = () => new Promise<void>((resolve) => { finishAssign = resolve; });
    const server = await serveNode(state);
    try {
      const assigning = nodeRequest(server, 'assign', validAssignment(), 'node-control-secret');
      await waitUntil(() => state.status === 'assigning');
      const releasing = nodeRequest(server, 'release', {}, 'node-control-secret');
      expect(state.status).toBe('assigning');
      finishAssign();
      expect((await assigning).status).toBe(200);
      expect((await releasing).status).toBe(200);
      expect(state.status).toBe('idle');
    } finally {
      await server.close();
    }
  });
});

function seedBaselineFiles(): { persona: string; clineConfig: string; globalState: string } {
  const persona = path.join(process.env.CONFIG_OUTPUT_DIR!, 'bot-persona.json');
  const clineConfig = path.join(process.env.CLINE_CONFIG_DIR!, 'config.json');
  const globalState = path.join(process.env.CLINE_CONFIG_DIR!, 'data', 'globalState.json');
  fs.mkdirSync(path.dirname(persona), { recursive: true });
  fs.mkdirSync(path.dirname(globalState), { recursive: true });
  fs.writeFileSync(persona, 'baseline-persona');
  fs.writeFileSync(clineConfig, 'baseline-config');
  fs.writeFileSync(globalState, 'baseline-state');
  return { persona, clineConfig, globalState };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for node transition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
