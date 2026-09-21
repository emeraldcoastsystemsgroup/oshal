/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P5 guard: the oshal leg of bench/ reported not-run unconditionally, so the benchmark measured competitors and never us. This runs the REAL bench/run.py (real Python, the real oshal_leg module, the real psycopg2 driver) against a real HTTP seam standing in for the controller's POST /api/send-message and a real disposable PostgreSQL holding the real chat_tasks schema (migration 005). The seam answers with one set of token numbers and writes a DIFFERENT set into chat_tasks, so the only way the leg's row can match is by reading the ledger's own columns - a leg that trusts the node's response is caught, not just the stub. Refusals: a rejected secret, a run with no ledger row, an answer on a different model and a missing setting each report themselves instead of a number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const REPO_ROOT = resolve(__dirname, '../..');
const RUN_PY = join(REPO_ROOT, 'bench', 'run.py');
const RUN_TIMEOUT_MS = 120_000;

const SECRET = `bench-fixture-secret-${randomUUID()}`;
const SUB = 'bench-fixture-user';
const AGENT = '00000000-0000-4000-8000-0000000000aa';
const MODEL = 'fixture/gpt-oss-20b:free';
/** What the fixture writes into chat_tasks - the number the leg must report. */
const LEDGER = { input: 1234, output: 567, cost: 0.0042, requests: 3 };
/** What the fixture answers over HTTP - deliberately different, so trusting the response is caught. */
const RESPONSE = { input: 99, output: 11 };
/** An answer the shared task.check() grades as passing: the line items sum to the total. */
const PASSING_ANSWER = JSON.stringify({
  vendor: 'ACME INDUSTRIAL SUPPLY', date: '2026-03-04', currency: 'USD',
  line_items: [
    { description: 'Widget, heavy-duty', amount: 1237.5 },
    { description: 'Freight and handling', amount: 85.5 },
    { description: 'Rush surcharge', amount: 200 },
    { description: 'Sales tax', amount: 114.23 },
  ],
  total: 1637.23,
});

type Mode = 'ledger' | 'no-row' | 'off-model';
interface Seen { headers: IncomingMessage['headers']; body: Record<string, unknown> }

let pg: DisposablePostgres;
let dsn: string;
let server: Server;
let port: number;
let python: string;
let mode: Mode = 'ledger';
const seen: Seen[] = [];

/**
 * @description Locate a Python 3 that can import psycopg2 - the leg reads the ledger with it. A box
 *   without either fails this guard loudly rather than skipping it into a green that proves nothing.
 * @returns The interpreter name that answered.
 */
function locatePython(): string {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['-c', 'import psycopg2, requests; print("ok")'], { encoding: 'utf8' });
    if (r.status === 0 && /ok/.test(r.stdout)) return candidate;
  }
  throw new Error('bench-oshal-leg guard needs a python3 with psycopg2 and requests on PATH (pip install -r bench/requirements.txt)');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * @description The controller seam: the same headers, refusals and answer shape POST /api/send-message
 *   has, over a real socket, plus the ledger write a bot node makes under `<thread>::<agent>`.
 */
async function respond(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/api/send-message') { json(res, 404, { error: 'not found' }); return; }
  if (req.headers['x-service-secret'] !== SECRET) { json(res, 401, { error: 'not_authenticated' }); return; }
  const encoded = String(req.headers['x-oshal-user-sub-b64'] ?? '');
  if (Buffer.from(encoded, 'base64url').toString('utf8') !== SUB) {
    json(res, 403, { error: 'trusted_service_user_sub_required' }); return;
  }
  const body = JSON.parse(raw) as Record<string, unknown>;
  seen.push({ headers: req.headers, body });
  const taskId = String(body.taskId);
  const model = mode === 'off-model' ? 'other/model' : MODEL;
  if (mode !== 'no-row') {
    await pg.pool.query(
      `INSERT INTO chat_tasks (task_id, title, status, processing_mode, agent_id, provider_id,
         total_input_tokens, total_output_tokens, total_cost, total_requests, usage_by_model)
       VALUES ($1, $2, 'processing', 'agentic', $3, 'openrouter', $4, $5, $6, $7, $8::jsonb)`,
      [`${taskId}::${AGENT}`, taskId, AGENT, LEDGER.input, LEDGER.output, LEDGER.cost, LEDGER.requests,
        JSON.stringify({ [model]: { inputTokens: LEDGER.input, outputTokens: LEDGER.output } })],
    );
  }
  json(res, 200, {
    success: true, response: PASSING_ANSWER,
    usage: { inputTokens: RESPONSE.input, outputTokens: RESPONSE.output, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0, model, provider: 'openrouter', durationMs: 5,
    taskId, taskIdUsed: taskId, requestedTaskId: taskId, agentId: AGENT, ticketCreated: false,
  });
}

interface BenchRun { status: number | null; stdout: string; stderr: string; report: Record<string, unknown> | null }

/**
 * @description Run a child to completion WITHOUT blocking this process's event loop. The seam the
 *   child talks to lives in this same process, so a spawnSync here deadlocks: the child waits for an
 *   HTTP answer the blocked loop can never send, until the child timeout fires. Measured before this
 *   helper existed - every case ran to its 120 s kill.
 * @param args - Arguments for the interpreter.
 * @param env - The child's complete environment.
 * @param cwd - The child's working directory.
 * @returns Exit status and both streams.
 */
function runChild(args: string[], env: Record<string, string | undefined>, cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(python, args, { env, cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); fail(err); });
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

/**
 * @description Run the real entrypoint for the oshal leg only, every setting supplied through the
 *   environment (the cwd is empty so no .env can leak in), and read back the JSON it wrote.
 * @param extraEnv - Overrides for one case (a wrong secret, a missing setting).
 * @param n - Runs per leg, so the stated n is exercised.
 * @returns The exit status, both streams and the parsed results file.
 */
async function runBench(extraEnv: Record<string, string> = {}, n = '2'): Promise<BenchRun> {
  const out = mkdtempSync(join(tmpdir(), 'bench-oshal-out-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bench-oshal-cwd-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OSHAL_BENCH_API_URL: `http://127.0.0.1:${port}`,
    OSHAL_BENCH_DSN: dsn,
    SWARM_SERVICE_SECRET: SECRET,
    OSHAL_BENCH_USER_SUB: SUB,
    OSHAL_BENCH_AGENT_ID: AGENT,
    OPENROUTER_API_KEY: 'bench-fixture-placeholder-never-sent',
    OPENROUTER_FREE_MODEL: MODEL,
    OSHAL_BENCH_LEDGER_WAIT_S: '2',
    ...extraEnv,
  };
  delete env.OSHAL_COST_CENSUS_DSN;
  delete env.BOOTSTRAP_DATABASE_URL;
  const r = await runChild([RUN_PY, '--runners', 'oshal', '--n', n, '--out', out], env, cwd);
  const file = join(out, 'latest.json');
  return {
    status: r.status, stdout: r.stdout, stderr: r.stderr,
    report: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null,
  };
}

function oshalRow(run: BenchRun): Record<string, unknown> {
  const results = (run.report?.results ?? []) as Array<Record<string, unknown>>;
  const row = results.find((r) => String(r.runner).startsWith('oshal'));
  if (!row) throw new Error(`no oshal row in the report; stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  return row;
}

beforeAll(async () => {
  python = locatePython();
  pg = new DisposablePostgres({ purpose: 'bench-oshal-leg', migrations: ['005-conversation-history-and-usage.sql'] });
  await pg.start();
  const c = pg.connection;
  dsn = `postgresql://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => { respond(req, res, raw).catch((err: Error) => json(res, 500, { error: err.message })); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((done) => server?.close(() => done()));
  await pg?.stop();
});

describe('bench: the oshal leg runs through the dispatch and is priced from chat_tasks', () => {
  it('dispatches n times through the HTTP seam and reports the ledger columns, not the response', async () => {
    mode = 'ledger';
    const before = seen.length;
    const run = await runBench();
    expect(run.status, `run.py exited ${run.status}\n${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.report?.n).toBe(2);
    const row = oshalRow(run);
    expect(row.status).toBe('ran');
    expect(row.n).toBe(2);
    expect((row.runs as unknown[]).length).toBe(2);
    expect(row.passed).toBe(2);
    expect(row.input_tokens).toBe(LEDGER.input);
    expect(row.output_tokens).toBe(LEDGER.output);
    expect(row.cost_usd).toBeCloseTo(LEDGER.cost, 6);
    expect(row.llm_calls).toBe(LEDGER.requests);
    expect(row.model).toBe(MODEL);
    // The response carried different numbers; they ride as a cross-check and never become the row.
    expect(row.input_tokens).not.toBe(RESPONSE.input);
    for (const single of row.runs as Array<Record<string, unknown>>) {
      expect(single.response_usage).toEqual({ input_tokens: RESPONSE.input, output_tokens: RESPONSE.output });
      expect(single.chat_task_ids).toEqual([`${String((single.chat_task_ids as string[])[0]).split('::')[0]}::${AGENT}`]);
    }
    const posts = seen.slice(before);
    expect(posts.length).toBe(2);
    expect(new Set(posts.map((p) => p.body.taskId)).size).toBe(2);
    for (const post of posts) {
      expect(post.body.chatOnly).toBe(true);
      expect(post.body.agentId).toBe(AGENT);
      expect(String(post.body.text)).toContain('ACME INDUSTRIAL SUPPLY');
      expect(String(post.body.taskId)).toMatch(/^bench-oshal-[0-9a-f]{16}$/);
    }
    expect(run.stdout).toMatch(/oshal \(live cluster\)\s+ran\s+2\s+2\/2/);
  }, 90_000);

  it('a refused secret is a reason, never a number', async () => {
    mode = 'ledger';
    const before = seen.length;
    const row = oshalRow(await runBench({ SWARM_SERVICE_SECRET: 'not-the-secret' }, '1'));
    expect(row.status).toBe('not-run');
    expect(String(row.reason)).toMatch(/HTTP 401/);
    expect(row.input_tokens).toBe(0);
    expect(seen.length).toBe(before);
  }, 60_000);

  it('a dispatch whose spend never reached chat_tasks is reported as unaccounted', async () => {
    mode = 'no-row';
    const row = oshalRow(await runBench({}, '1'));
    expect(row.status).toBe('not-run');
    expect(String(row.reason)).toMatch(/chat_tasks has no cost row/);
    expect(row.llm_calls).toBe(0);
  }, 60_000);

  it('an answer on a different model is off-model: real numbers, flagged as not the comparison', async () => {
    mode = 'off-model';
    const row = oshalRow(await runBench({}, '1'));
    expect(row.status).toBe('off-model');
    expect(String(row.reason)).toContain('other/model');
    expect(String(row.reason)).toContain(MODEL);
    expect(row.input_tokens).toBe(LEDGER.input);
    expect(row.passed).toBe(1);
  }, 60_000);

  it('a missing setting is named instead of guessed', async () => {
    mode = 'ledger';
    const row = oshalRow(await runBench({ SWARM_SERVICE_SECRET: '' }, '1'));
    expect(row.status).toBe('not-run');
    expect(String(row.reason)).toMatch(/not configured: SWARM_SERVICE_SECRET/);
  }, 60_000);
});
