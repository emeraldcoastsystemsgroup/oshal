/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the remote-node CLI against a real local HTTP control plane, proving pull scratch cleanup and deadline-capped Retry-After behavior without production-only test hooks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep the cleanup and retry behavior groups independently readable and below the repository function-size limit.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove an accepted-but-silent HTTP response cannot outlive the overall tool deadline, and make cleanup failure observable without masking a primary transfer error.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Prove concurrent pull cleanup waits for an already-issued sibling read after another worker rejects.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Give ordinary multi-request pull fixtures a 1.5-second control-plane budget so suite contention cannot preempt their intended truncation/cleanup assertion; dedicated 125ms deadline cases remain strict.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Keep the 125ms production deadline strict while accepting either fail-closed deadline message and measuring it inside the existing two-second child-process guard under scheduler contention.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const cli = join(root, 'scripts', 'codex-remote-node.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'oshal-remote-node-test-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type PullMode = 'success' | 'concurrent-short-chunk' | 'invalid-stage-length' | 'short-chunk';

interface ControlPlaneState {
  cleanupFails: boolean;
  commands: string[];
  dataBase64: string;
  events: string[];
  hangCleanup: boolean;
  hangResult: boolean;
  mode: PullMode;
  retryAfter?: string;
  tasks: Map<string, string>;
}

interface ControlPlaneOptions {
  cleanupFails?: boolean;
  hangCleanup?: boolean;
  hangResult?: boolean;
  retryAfter?: string;
}

interface RunningControlPlane {
  close: () => Promise<void>;
  commands: string[];
  events: string[];
  url: string;
}

interface CliResult {
  code: number | null;
  elapsedMs: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

const readRequestJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
};

const sendJson = (res: ServerResponse, status: number, body: unknown, headers = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const chunkRange = (command: string): { offset: number; take: number } => {
  const offset = Number(command.match(/\.Seek\((\d+),/)?.[1]);
  const take = Number(command.match(/New-Object byte\[\]\s+(\d+)/)?.[1]);
  if (!Number.isFinite(offset) || !Number.isFinite(take)) throw new Error(`Unparseable range command: ${command}`);
  return { offset, take };
};

const completedResult = (state: ControlPlaneState, command: string): unknown => {
  if (state.cleanupFails && command.includes('Remove-Item')) {
    return { status: 'failed', error: 'cleanup refused by test node' };
  }
  if (command.includes('ToBase64String([IO.File]::ReadAllBytes')) {
    const stdout = state.mode === 'invalid-stage-length' ? 'not-a-length' : String(state.dataBase64.length);
    return { status: 'completed', output: { stdout } };
  }
  if (command.includes('[IO.File]::OpenRead')) {
    const { offset, take } = chunkRange(command);
    const shorten = state.mode === 'short-chunk' || (state.mode === 'concurrent-short-chunk' && offset === 0);
    const end = shorten ? offset + take - 1 : offset + take;
    return { status: 'completed', output: { stdout: state.dataBase64.slice(offset, end) } };
  }
  return { status: 'completed', output: { stdout: '' } };
};

const handlePost = async (req: IncomingMessage, res: ServerResponse, state: ControlPlaneState): Promise<void> => {
  const task = await readRequestJson(req);
  const taskId = String(task.taskId || '');
  const input = task.input as { arguments?: { command?: unknown } } | undefined;
  const command = String(input?.arguments?.command || '');
  if (command.includes('Remove-Item')) state.events.push('cleanup-enqueued');
  state.tasks.set(taskId, command);
  state.commands.push(command);
  sendJson(res, 202, { accepted: true, taskId });
};

const handleGet = (req: IncomingMessage, res: ServerResponse, state: ControlPlaneState): void => {
  if (state.retryAfter) {
    sendJson(res, 429, { error: 'backpressure' }, { 'retry-after': state.retryAfter });
    return;
  }
  const taskId = decodeURIComponent(req.url?.match(/\/tasks\/([^/]+)\/result/)?.[1] || '');
  const command = state.tasks.get(taskId);
  if (state.hangResult || (state.hangCleanup && command?.includes('Remove-Item'))) return;
  if (command == null) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (state.mode === 'concurrent-short-chunk' && command.includes('[IO.File]::OpenRead') && chunkRange(command).offset > 0) {
    setTimeout(() => {
      state.events.push('sibling-read-completed');
      sendJson(res, 200, completedResult(state, command));
    }, 200);
    return;
  }
  sendJson(res, 200, completedResult(state, command));
};

const requestHandler = (state: ControlPlaneState) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  try {
    if (req.method === 'POST' && req.url?.endsWith('/tasks')) {
      await handlePost(req, res, state);
      return;
    }
    if (req.method === 'GET' && req.url?.includes('/result')) {
      handleGet(req, res, state);
      return;
    }
    sendJson(res, 404, { error: 'unknown route' });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Control plane did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
};

const startControlPlane = async (data: Buffer, mode: PullMode, options: ControlPlaneOptions = {}): Promise<RunningControlPlane> => {
  const state: ControlPlaneState = {
    cleanupFails: options.cleanupFails ?? false,
    commands: [],
    dataBase64: data.toString('base64'),
    events: [],
    hangCleanup: options.hangCleanup ?? false,
    hangResult: options.hangResult ?? false,
    mode,
    retryAfter: options.retryAfter,
    tasks: new Map(),
  };
  const server = createServer(requestHandler(state));
  const url = await listen(server);
  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    commands: state.commands,
    events: state.events,
    url,
  };
};

const runCli = (args: string[], timeoutMs = 3_000): Promise<CliResult> => new Promise((resolve, reject) => {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.once('error', reject);
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve({ code, elapsedMs: Date.now() - startedAt, stderr, stdout, timedOut });
  });
});

const pullArgs = (url: string, out: string): string[] => [
  'pull', `--url=${url}`, '--secret=test-secret', '--client=test-client',
  '--remote=C:\\Recaps\\source.bin', `--local=${out}`, '--chunkSize=2000', '--timeoutMs=1500',
  '--cleanupTimeoutMs=125',
];

const cleanupCommands = (commands: string[]): string[] => commands.filter((command) =>
  command.includes('Remove-Item') && command.includes('.pull-') && command.includes('-ErrorAction Stop'));

describe('codex remote-node pull cleanup', () => {
  it('removes the pulled scratch artifact exactly once after a successful transfer', async () => {
    const data = Buffer.alloc(3_500, 0x5a);
    const plane = await startControlPlane(data, 'success');
    const out = join(scratch, 'success.bin');
    try {
      const result = await runCli(pullArgs(plane.url, out));
      expect(result, `${result.stdout}\n${result.stderr}`).toMatchObject({ code: 0, timedOut: false });
      expect(readFileSync(out).equals(data)).toBe(true);
      expect(cleanupCommands(plane.commands)).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });

  it('fails visibly when a successful transfer cannot remove its remote scratch artifact', async () => {
    const plane = await startControlPlane(Buffer.alloc(3_500, 0x5a), 'success', { cleanupFails: true });
    try {
      const result = await runCli(pullArgs(plane.url, join(scratch, 'cleanup-failure.bin')));
      expect(result).toMatchObject({ code: 1, timedOut: false });
      expect(result.stderr).toMatch(/remote pull cleanup failed/i);
      expect(result.stderr).toMatch(/cleanup refused by test node/i);
      expect(cleanupCommands(plane.commands)).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });

  it('bounds a cleanup result that accepts the connection but never responds', async () => {
    const plane = await startControlPlane(Buffer.alloc(3_500, 0x5a), 'success', { hangCleanup: true });
    try {
      const result = await runCli(pullArgs(plane.url, join(scratch, 'cleanup-hang.bin')), 2_000);
      expect(result).toMatchObject({ code: 1, timedOut: false });
      expect(result.stderr).toMatch(/remote pull cleanup failed/i);
      expect(result.elapsedMs).toBeLessThan(1_000);
      expect(cleanupCommands(plane.commands)).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });

});

describe('codex remote-node concurrent pull cleanup', () => {
  it('waits for an issued sibling chunk before removing the shared scratch file', async () => {
    const plane = await startControlPlane(Buffer.alloc(3_500, 0x5a), 'concurrent-short-chunk');
    const args = [...pullArgs(plane.url, join(scratch, 'concurrent-failure.bin')), '--concurrency=2'];
    try {
      const result = await runCli(args);
      expect(result).toMatchObject({ code: 1, timedOut: false });
      expect(result.stderr).toMatch(/aborted rather than write a corrupt file/i);
      expect(plane.events).toEqual(['sibling-read-completed', 'cleanup-enqueued']);
      expect(cleanupCommands(plane.commands)).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });
});

describe('codex remote-node retry deadlines', () => {
  it.each([
    ['an invalid staging response', 'invalid-stage-length' as const, /could not stage remote file/i],
    ['a truncated chunk', 'short-chunk' as const, /aborted rather than write a corrupt file/i],
  ])('removes the pulled scratch artifact exactly once after %s', async (_label, mode, expectedError) => {
    const plane = await startControlPlane(Buffer.alloc(3_500, 0x41), mode);
    const out = join(scratch, `${mode}.bin`);
    try {
      const result = await runCli(pullArgs(plane.url, out));
      expect(result.code).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toMatch(expectedError);
      expect(existsSync(out)).toBe(false);
      expect(cleanupCommands(plane.commands)).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });

  it.each([
    ['numeric seconds', '120'],
    ['an HTTP date', new Date(Date.now() + 120_000).toUTCString()],
  ])('caps Retry-After expressed as %s at the task deadline', async (_label, retryAfter) => {
    const plane = await startControlPlane(Buffer.alloc(1), 'success', { retryAfter });
    try {
      const result = await runCli([
        'shell', `--url=${plane.url}`, '--secret=test-secret', '--client=test-client',
        '--cmd=Get-Date', '--timeoutMs=125',
      ], 2_000);
      expect(result.code).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toMatch(/timed out waiting for shell\.exec|request deadline elapsed/i);
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      await plane.close();
    }
  });
});

describe('codex remote-node stalled response handling', () => {
  it('aborts a result fetch that accepts the connection but never sends headers', async () => {
    const plane = await startControlPlane(Buffer.alloc(1), 'success', { hangResult: true });
    try {
      const result = await runCli([
        'shell', `--url=${plane.url}`, '--secret=test-secret', '--client=test-client',
        '--cmd=Get-Date', '--timeoutMs=125',
      ], 2_000);
      expect(result).toMatchObject({ code: 1, timedOut: false });
      expect(result.stderr).toMatch(/timed out waiting for shell\.exec|request deadline elapsed/i);
      expect(result.elapsedMs).toBeLessThan(2_000);
    } finally {
      await plane.close();
    }
  });

  it('reports cleanup failure separately while preserving the primary transfer error', async () => {
    const plane = await startControlPlane(Buffer.alloc(1), 'invalid-stage-length', { cleanupFails: true });
    try {
      const result = await runCli(pullArgs(plane.url, join(scratch, 'dual-failure.bin')));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/could not stage remote file/i);
      expect(result.stderr).toMatch(/cleanup also failed/i);
      expect(result.stderr).toMatch(/cleanup refused by test node/i);
      expect(cleanupCommands(plane.commands)).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });
});
