/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — proves the headless swarm CLI (scripts/swarm-cli.js) against a stub controller: trusted-service auth headers on every call, the ask→poll→answer loop, per-controller+user session persistence (consecutive asks are ONE thread; --new rotates it), the OIDC-redirect → exit 2 auth failure, job errors → exit 1, poll timeout → exit 3, and catalog formatting. The stub emulates POST /api/jarvis/ask (202+jobId) and GET /ask/result (pending→done) exactly as jarvis-routes responds, so the CLI's contract with the real surface endpoints is what's under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.resolve(__dirname, '../../packages/swarm-cli/bin/swarm-cli.js');
const SECRET = 'unit-test-secret';
const SUB = 'cli-unit-user';
const STUB_PAT = 'oshal_pat_stubtoken1234567890abcdef1234567890abcdef';

interface StubCall { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown }
interface Stub { url: string; calls: StubCall[]; close: () => Promise<void> }

/** Behavior knobs for one stub controller instance. */
interface StubBehavior {
  /** Answer returned once the job completes. */
  answer?: string;
  /** How many result polls report 'pending' before completing (default 1). */
  pendingPolls?: number;
  /** Force every response to be a 302 redirect (the OIDC wall a browser would follow). */
  redirectAll?: boolean;
  /** Complete the job with status:'error' instead of an answer. */
  jobError?: string;
  /** Never complete — every poll stays 'pending' (for the timeout path). */
  neverDone?: boolean;
}

/** Start a stub controller emulating the /api/jarvis endpoints the CLI drives. */
function startStub(behavior: StubBehavior = {}): Promise<Stub> {
  const calls: StubCall[] = [];
  let polls = 0;
  const pendingPolls = behavior.pendingPolls ?? 1;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      if (behavior.redirectAll) {
        res.writeHead(302, { Location: '/login' }).end();
        return;
      }
      const send = (code: number, payload: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = req.url || '';
      if (req.method === 'POST' && url === '/api/jarvis/ask') {
        send(202, { jobId: 'job-1', sessionId: (body as { sessionId?: string })?.sessionId, chatTicketId: 'tk-1' });
      } else if (url.startsWith('/api/jarvis/ask/result')) {
        polls += 1;
        if (behavior.neverDone || polls <= pendingPolls) send(200, { status: 'pending', label: 'x' });
        else if (behavior.jobError) send(200, { status: 'error', error: behavior.jobError });
        else send(200, { status: 'done', answer: behavior.answer ?? 'stub answer', dispatched: [], routed: [], handoffs: [] });
      } else if (url.startsWith('/api/jarvis/history')) {
        send(200, { turns: [{ role: 'user', text: 'hi' }, { role: 'jarvis', text: 'hello' }] });
      } else if (url === '/api/jarvis/catalog') {
        send(200, { apps: [{ key: 'email', name: 'Communications', blurb: 'mail', mode: 'delegate', deepLink: '/x' }] });
      } else if (url === '/api/jarvis/tasks') {
        send(200, { tasks: [{ id: '1', title: 'build it', status: 'done', result: 'built' }] });
      } else if (req.method === 'POST' && url === '/api/cli-tokens') {
        // Mint requires SOME credential, like serviceSecretOr(requiresAuth) would.
        if (req.headers['x-service-secret'] || req.headers.authorization) {
          send(201, { id: 'tok-1', label: (body as { label?: string })?.label ?? 'cli token', token: STUB_PAT, createdAt: 'now' });
        } else send(401, { error: 'unauthorized' });
      } else if (url === '/api/cli-tokens/whoami') {
        if (req.headers.authorization === `Bearer ${STUB_PAT}`) send(200, { sub: 'pat-owner', email: 'pat@x', operator: false });
        else if (req.headers['x-service-secret']) send(200, { sub: String(req.headers['x-oshal-user-sub']), email: null, operator: false });
        else send(401, { error: 'unauthorized' });
      } else if (req.method === 'DELETE' && url.startsWith('/api/cli-tokens/')) {
        send(200, { ok: true, revoked: url.endsWith('/tok-1') });
      } else if (url === '/api/cli-tokens') {
        send(200, { tokens: [{ id: 'tok-1', label: 'x', createdAt: 'now', lastUsedAt: null, revoked: false }] });
      } else {
        send(404, { error: 'not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => new Promise((r) => { server.close(() => r()); }),
      });
    });
  });
}

/** Run the CLI as a child process, the way a headless deployment would. Optional `input` is
 *  written to stdin then closed — used to drive the `chat` REPL from a pipe. */
function runCli(
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  });
}

describe('swarm-cli (headless Jarvis client)', () => {
  let stateDir: string;
  let stub: Stub | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-spec-'));
  });
  afterEach(async () => {
    if (stub) { await stub.close(); stub = undefined; }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const baseEnv = (url: string): Record<string, string> => ({
    OSHAL_API_URL: url,
    SWARM_SERVICE_SECRET: SECRET,
    OSHAL_USER_SUB: SUB,
    OSHAL_CLI_STATE_DIR: stateDir,
  });

  it('ask: sends trusted-service headers, polls to completion, prints the answer JSON', async () => {
    stub = await startStub({ answer: 'the swarm says hi' });
    const run = await runCli(['ask', 'hello', '--json', '--poll', '50'], baseEnv(stub.url));
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.answer).toBe('the swarm says hi');
    const ask = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/jarvis/ask');
    expect(ask).toBeDefined();
    expect(ask!.headers['x-service-secret']).toBe(SECRET);
    expect(ask!.headers['x-oshal-user-sub']).toBe(SUB);
    expect((ask!.body as { message: string }).message).toBe('hello');
  }, 20_000);

  it('ask: consecutive invocations reuse ONE persisted thread; --new rotates it', async () => {
    stub = await startStub({ pendingPolls: 0 });
    const env = baseEnv(stub.url);
    await runCli(['ask', 'first', '--poll', '50'], env);
    await runCli(['ask', 'second', '--poll', '50'], env);
    const sessions = stub.calls
      .filter((c) => c.method === 'POST' && c.url === '/api/jarvis/ask')
      .map((c) => (c.body as { sessionId: string }).sessionId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[0]).toMatch(/^cli-[\w-]+$/);
    await runCli(['ask', 'third', '--new', '--poll', '50'], env);
    const rotated = (stub.calls
      .filter((c) => c.method === 'POST' && c.url === '/api/jarvis/ask')
      .at(-1)!.body as { sessionId: string }).sessionId;
    expect(rotated).not.toBe(sessions[0]);
  }, 20_000);

  it('exits 2 with guidance when the server answers with the OIDC redirect wall', async () => {
    stub = await startStub({ redirectAll: true });
    const run = await runCli(['ask', 'hello'], baseEnv(stub.url));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('auth required');
  }, 20_000);

  it('exits 2 when a secret is configured without an acting user sub', async () => {
    const run = await runCli(['ask', 'hello'], {
      OSHAL_API_URL: 'http://127.0.0.1:1', SWARM_SERVICE_SECRET: SECRET, OSHAL_USER_SUB: '', OSHAL_CLI_STATE_DIR: stateDir,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('OSHAL_USER_SUB');
  }, 20_000);

  it('exits 1 when the Jarvis turn fails server-side', async () => {
    stub = await startStub({ jobError: 'bot exploded' });
    const run = await runCli(['ask', 'hello', '--poll', '50'], baseEnv(stub.url));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('bot exploded');
  }, 20_000);

  it('exits 3 when no answer arrives within --timeout', async () => {
    stub = await startStub({ neverDone: true });
    const run = await runCli(['ask', 'hello', '--timeout', '1', '--poll', '100'], baseEnv(stub.url));
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('no answer within');
  }, 20_000);

  it('catalog: renders the apps Jarvis can reach', async () => {
    stub = await startStub();
    const run = await runCli(['catalog'], baseEnv(stub.url));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Communications');
  }, 20_000);

  it('history: replays the thread transcript', async () => {
    stub = await startStub();
    const run = await runCli(['history'], baseEnv(stub.url));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('you> hi');
    expect(run.stdout).toContain('jarvis> hello');
  }, 20_000);

  it('login (secret bootstrap): mints a PAT, saves the context WITHOUT the secret', async () => {
    stub = await startStub();
    const run = await runCli(
      ['login', '--url', stub.url, '--secret', SECRET, '--sub', SUB],
      { OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Logged in as pat-owner');
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    expect(config.currentContext).toBe('default');
    expect(config.contexts.default.token).toBe(STUB_PAT);
    expect(config.contexts.default.secret).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain(SECRET);
  }, 20_000);

  it('after login, commands authenticate with the saved Bearer token (no env needed)', async () => {
    stub = await startStub();
    await runCli(
      ['login', '--url', stub.url, '--token', STUB_PAT],
      { OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' },
    );
    const run = await runCli(['ask', 'hello', '--json', '--poll', '50'],
      { OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' });
    expect(run.code).toBe(0);
    const ask = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/jarvis/ask');
    expect(ask!.headers.authorization).toBe(`Bearer ${STUB_PAT}`);
    expect(ask!.headers['x-service-secret']).toBeUndefined();
  }, 20_000);

  it('whoami + tokens revoke work against the saved context', async () => {
    stub = await startStub();
    const env = { OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' };
    await runCli(['login', '--url', stub.url, '--token', STUB_PAT], env);
    const who = await runCli(['whoami'], env);
    expect(who.code).toBe(0);
    expect(who.stdout).toContain('pat-owner');
    const revoke = await runCli(['tokens', 'revoke', 'tok-1'], env);
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain('revoked tok-1');
  }, 20_000);

  it('logout forgets the context', async () => {
    stub = await startStub();
    const env = { OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' };
    await runCli(['login', '--url', stub.url, '--token', STUB_PAT], env);
    const out = await runCli(['logout'], env);
    expect(out.code).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    expect(config.contexts.default).toBeUndefined();
  }, 20_000);

  it('version prints the package version and needs no server or auth', async () => {
    const run = await runCli(['version'], { OSHAL_CLI_STATE_DIR: stateDir });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^swarm-cli \d+\.\d+/);
  }, 20_000);

  it('completion emits a shell script for each supported shell; rejects unknown shells', async () => {
    const bash = await runCli(['completion', 'bash'], { OSHAL_CLI_STATE_DIR: stateDir });
    expect(bash.code).toBe(0);
    expect(bash.stdout).toContain('complete -F _swarm_cli swarm-cli');
    const zsh = await runCli(['completion', 'zsh'], { OSHAL_CLI_STATE_DIR: stateDir });
    expect(zsh.stdout).toContain('#compdef swarm-cli');
    const pwsh = await runCli(['completion', 'powershell'], { OSHAL_CLI_STATE_DIR: stateDir });
    expect(pwsh.stdout).toContain('Register-ArgumentCompleter');
    const bad = await runCli(['completion', 'fish'], { OSHAL_CLI_STATE_DIR: stateDir });
    expect(bad.code).toBe(2);
  }, 20_000);

  it('pipe-safety: no ANSI escapes or banner on stdout when not a TTY', async () => {
    const help = await runCli(['help'], { OSHAL_CLI_STATE_DIR: stateDir });
    // eslint-disable-next-line no-control-regex
    expect(help.stdout).not.toMatch(/\x1b\[/);
    expect(help.stdout).not.toContain('the swarm, from your terminal');
    stub = await startStub();
    // An `ask` result must stay clean (answer only) even though color helpers exist.
    const ask = await runCli(['ask', 'hello', '--poll', '50'], baseEnv(stub.url));
    // eslint-disable-next-line no-control-regex
    expect(ask.stdout).not.toMatch(/\x1b\[/);
    expect(ask.stdout.trim()).toBe('stub answer');
  }, 20_000);

  it('chat: a piped message prints the answer and exits 0 (no readline-after-close crash on EOF)', async () => {
    stub = await startStub();
    // The pipe drains (stdin EOF) while the turn is in flight — this used to throw
    // ERR_USE_AFTER_CLOSE from rl.prompt() and exit 1 after a good answer.
    const run = await runCli(['chat', '--quiet', '--poll', '50'], baseEnv(stub.url), 'hello\n');
    expect(run.stdout).toContain('jarvis>');
    expect(run.stdout).toContain('stub answer');
    expect(run.code).toBe(0);
  }, 20_000);

  it('pipe-safety: stderr status notes carry no ANSI when stderr is not a TTY', async () => {
    stub = await startStub();
    const run = await runCli(['ask', 'hello', '--poll', '50'], baseEnv(stub.url));
    // eslint-disable-next-line no-control-regex
    expect(run.stderr).not.toMatch(/\x1b\[/);
  }, 20_000);

  it('color: stderr status notes ARE colored when color is forced (note() gates on stderr, not stdout)', async () => {
    // Regression lock for the status-color fix: note()/error route through the stderr-gated uiErr
    // table, so they color independently of stdout. FORCE_COLOR makes supportsColor(stderr) true
    // without a pty; the "ask" thread note therefore carries ANSI. Its counterpart above proves the
    // safe direction (redirected/piped stderr stays byte-clean). The remaining untestable-here case
    // — stdout piped while stderr is a live TTY — is covered by construction (uiErr ignores COLOR_ON).
    stub = await startStub();
    const run = await runCli(['ask', 'hello', '--poll', '50'], { ...baseEnv(stub.url), FORCE_COLOR: '1' });
    // eslint-disable-next-line no-control-regex
    expect(run.stderr).toMatch(/\x1b\[/);
  }, 20_000);

  it('--no-banner is accepted (boolean flag) and login stays clean when piped', async () => {
    stub = await startStub();
    const run = await runCli(
      ['login', '--url', stub.url, '--token', STUB_PAT, '--no-banner'],
      { OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('the swarm, from your terminal');
  }, 20_000);
});
