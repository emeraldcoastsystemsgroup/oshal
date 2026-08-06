/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact dynamic-CLI identity propagation, same-workspace serialization, fail-closed invalid subjects, and identity-owned cleanup under replacement races.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove dynamic CLI children receive caller identity but no controller/database secret environment.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutorService } from '../../src/features/chat-orchestration/services/tool-executor-service';
import { StreamManager } from '../../src/features/streaming';
import { DynamicToolExecutorRegistry } from '../../src/features/tool-registry';

let root: string;
let priorWorkspaceRoot: string | undefined;
let priorControllerSecret: string | undefined;
let priorDatabaseUrl: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-tool-cli-scope-'));
  priorWorkspaceRoot = process.env.CLINE_WORKSPACE_ROOT;
  priorControllerSecret = process.env.OSHAL_TEST_CONTROLLER_SECRET;
  priorDatabaseUrl = process.env.DATABASE_URL;
  process.env.CLINE_WORKSPACE_ROOT = root;
  process.env.OSHAL_TEST_CONTROLLER_SECRET = 'must-not-reach-tool';
  process.env.DATABASE_URL = 'postgresql://must-not-reach-tool';
});

afterEach(() => {
  if (priorWorkspaceRoot === undefined) delete process.env.CLINE_WORKSPACE_ROOT;
  else process.env.CLINE_WORKSPACE_ROOT = priorWorkspaceRoot;
  if (priorControllerSecret === undefined) delete process.env.OSHAL_TEST_CONTROLLER_SECRET;
  else process.env.OSHAL_TEST_CONTROLLER_SECRET = priorControllerSecret;
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Quote one trusted executable/script path for the platform shell used by exec. */
function quoteCommandPart(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

/** Wait until a subprocess publishes a bounded test marker. */
async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Build a CLI descriptor whose process snapshots its workspace identity before being released. */
function createExecutor(): ToolExecutorService {
  const scriptPath = path.join(root, 'identity-probe.cjs');
  fs.writeFileSync(scriptPath, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const marker = path.join(process.cwd(), process.argv[2]);",
    "const release = path.join(process.cwd(), process.argv[3]);",
    "const subject = fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8');",
    "fs.writeFileSync(marker, subject, 'utf8');",
    'const wait = new Int32Array(new SharedArrayBuffer(4));',
    'const deadline = Date.now() + 5000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);',
    'if (!fs.existsSync(release)) process.exit(3);',
    'process.stdout.write(subject);',
  ].join('\n'));
  const registry = new DynamicToolExecutorRegistry();
  registry.register({
    toolName: 'identity-probe',
    executorType: 'cli',
    cliCommand: `${quoteCommandPart(process.execPath)} ${quoteCommandPart(scriptPath)} {input.marker} {input.release}`,
    runtimeRegistered: true,
    registeredAt: new Date().toISOString(),
  });
  return new ToolExecutorService({
    streamManager: new StreamManager(),
    dynamicToolExecutorRegistry: registry,
  });
}

/** Build a one-shot child that records only the environment fields relevant to this boundary. */
function createEnvironmentProbeExecutor(): ToolExecutorService {
  const scriptPath = path.join(root, 'environment-probe.cjs');
  fs.writeFileSync(scriptPath, [
    "const fs = require('fs');",
    "const path = require('path');",
    "fs.writeFileSync(path.join(process.cwd(), process.argv[2]), JSON.stringify({",
    '  userSub: process.env.OSHAL_USER_SUB,',
    '  controllerSecret: process.env.OSHAL_TEST_CONTROLLER_SECRET,',
    '  databaseUrl: process.env.DATABASE_URL,',
    '  hasPath: Boolean(process.env.PATH || process.env.Path),',
    '}));',
  ].join('\n'));
  const registry = new DynamicToolExecutorRegistry();
  registry.register({
    toolName: 'environment-probe',
    executorType: 'cli',
    cliCommand: `${quoteCommandPart(process.execPath)} ${quoteCommandPart(scriptPath)} {input.marker}`,
    runtimeRegistered: true,
    registeredAt: new Date().toISOString(),
  });
  return new ToolExecutorService({
    streamManager: new StreamManager(),
    dynamicToolExecutorRegistry: registry,
  });
}

describe('ToolExecutorService dynamic CLI identity scope', () => {
  it('preserves exact subjects and serializes invocations sharing one workspace', async () => {
    const executor = createExecutor();
    const workspace = path.join(root, 'shared-task');
    const first = executor.executeTool(
      'shared-task', 'identity-probe', { marker: 'first.started', release: 'first.release' },
      'agent-a', ' Owner-A ',
    );
    await waitForFile(path.join(workspace, 'first.started'));
    expect(fs.readFileSync(path.join(workspace, 'first.started'), 'utf8')).toBe(' Owner-A ');

    const second = executor.executeTool(
      'shared-task', 'identity-probe', { marker: 'second.started', release: 'second.release' },
      'agent-b', 'owner-b',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(path.join(workspace, 'second.started'))).toBe(false);

    fs.writeFileSync(path.join(workspace, 'first.release'), 'release');
    await first;
    await waitForFile(path.join(workspace, 'second.started'));
    expect(fs.readFileSync(path.join(workspace, 'second.started'), 'utf8')).toBe('owner-b');
    fs.writeFileSync(path.join(workspace, 'second.release'), 'release');
    await second;
    expect(fs.existsSync(path.join(workspace, '.oshal-user-sub'))).toBe(false);
  });

  it('does not delete a newer identity-file replacement during cleanup', async () => {
    const executor = createExecutor();
    const workspace = path.join(root, 'replacement-task');
    const run = executor.executeTool(
      'replacement-task', 'identity-probe', { marker: 'started', release: 'release' },
      'agent-a', 'owner-a',
    );
    await waitForFile(path.join(workspace, 'started'));

    const identityPath = path.join(workspace, '.oshal-user-sub');
    fs.unlinkSync(identityPath);
    fs.writeFileSync(identityPath, 'newer-invocation', { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, 'release'), 'release');
    await run;

    expect(fs.readFileSync(identityPath, 'utf8')).toBe('newer-invocation');
  });

  it('rejects invalid supplied subjects before spawning the CLI', async () => {
    const executor = createExecutor();
    for (const [index, subject] of ['', 'owner\u0000alias', 'x'.repeat(513)].entries()) {
      const taskId = `invalid-${index}`;
      await expect(executor.executeTool(
        taskId, 'identity-probe', { marker: 'started', release: 'release' }, 'agent-a', subject,
      )).rejects.toThrow(/exact UTF-8/);
      expect(fs.existsSync(path.join(root, taskId, 'started'))).toBe(false);
      expect(fs.existsSync(path.join(root, taskId, '.oshal-user-sub'))).toBe(false);
    }
  });

  it('forwards caller identity but not controller or database secrets', async () => {
    const executor = createEnvironmentProbeExecutor();
    await executor.executeTool(
      'environment-task', 'environment-probe', { marker: 'environment.json' },
      'agent-a', ' Owner-A ',
    );
    const observed = JSON.parse(fs.readFileSync(
      path.join(root, 'environment-task', 'environment.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(observed).toEqual({ userSub: ' Owner-A ', hasPath: true });
  });
});
