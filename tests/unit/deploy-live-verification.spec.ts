/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the post-deploy live verification. On 2026-09-15 a deploy printed DEPLOYED while Jarvis answered nothing and an operator ticket escalated on manifest_worker_dispatch_failed: every existing gate measures containers, none measured the product. Two boundaries are crossed for real here — the actual scripts/lib/deploy-verify.sh executed by the real Git Bash with a stubbed docker binary (ordering, loudness, the skip switch, the exact remedy text), and the actual probe checks run by the real Node against a real loopback HTTP server speaking the api's contracts (verdicts, cleanup, and no secret in the output) — in ONE process, because this host's firewall refuses a cross-process connection to a Node listener. What is NOT crossed, and is stated rather than implied: the real api, the real queue manager and the real Jarvis bot. Only a deploy reaches those, which is why the deploy is where this runs.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const LIB = path.resolve('scripts/lib/deploy-verify.sh');
const DEPLOY = path.resolve('scripts/oshal-deploy.sh');
const PROBE = path.resolve('scripts/operations/deploy-live-verification.js');
const BASH_RESOLVER = path.resolve('scripts/lib/windows-git-bash.ps1');
const libSource = readFileSync(LIB, 'utf8');
const deploySource = readFileSync(DEPLOY, 'utf8');
const SECRET = 'fixture-service-secret-never-printed';
const SUBJECT = 'fixture|operator-subject-never-printed';
const BASH_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Resolve Bash through the production identity probe and fail closed on a WSL/System32 launcher. */
function resolveHostBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const resolver = BASH_RESOLVER.replace(/'/g, "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${resolver}'; $selected = Resolve-OshalGitBash; if (-not $selected) { exit 2 }; [Console]::Out.Write($selected)`,
  ], { encoding: 'utf8', timeout: 30_000 });
  const candidate = result.stdout.trim();
  if (result.error || result.status !== 0 || !path.win32.isAbsolute(candidate)
    || /[\\/](?:system32|sysnative|syswow64)[\\/]|wsl\.exe$/i.test(candidate)) {
    throw new Error('A validated Git Bash executable is required for the deploy verification guard.');
  }
  return candidate;
}
const BASH = resolveHostBash();

let scratch: string;
let stub: string;
/** A bash `docker` FUNCTION, not a PATH entry: it shadows the real binary completely, so no case
 *  in this file can reach the engine even if the lib grows another docker call tomorrow. */
const DOCKER_STUB = `docker() {
  printf '%s\\n' "$*" >> "$DOCKER_STUB_LOG"
  case "$1" in
    cp) return "\${DOCKER_STUB_CP_RC:-0}" ;;
    exec)
      case "$*" in
        *psql*) printf '%s\\n' "\${DOCKER_STUB_GRANT:-t}"; return 0 ;;
        *" jarvis") printf '%s\\n' "\${DOCKER_STUB_JARVIS_OUT:-answered}"; return "\${DOCKER_STUB_JARVIS_RC:-0}" ;;
        *" ticket") printf '%s\\n' "\${DOCKER_STUB_TICKET_OUT:-moved}"; return "\${DOCKER_STUB_TICKET_RC:-0}" ;;
      esac ;;
  esac
  printf 'UNEXPECTED DOCKER CALL\\n' >&2
  return 97
}
`;

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'deploy-verify-'));
  stub = path.join(scratch, 'docker-stub.sh');
  writeFileSync(stub, DOCKER_STUB);
});

afterAll(() => {
  expect(path.dirname(path.resolve(scratch))).toBe(path.resolve(tmpdir()));
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the REAL verification library in a real shell with the docker binary shadowed. */
function verify(env: Record<string, string> = {}) {
  const callLog = path.join(scratch, `calls-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(callLog, '');
  const result = spawnSync(BASH, ['--noprofile', '--norc', '-c',
    'set -uo pipefail\nsource "$1"\nsource "$2"\noshal_deploy_post_verify\nprintf "RC=%s\\n" "$?"',
    'deploy-verify-test', stub.replace(/\\/g, '/'), LIB.replace(/\\/g, '/')],
  { cwd: process.cwd(), encoding: 'utf8', timeout: BASH_TIMEOUT_MS, env: { ...process.env, ...env, DOCKER_STUB_LOG: callLog.replace(/\\/g, '/') } });
  return { ...result, calls: readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('scripts/lib/deploy-verify.sh — the three checks a deploy is not finished without', () => {
  it('passes, in order, when the grant is present and both probes succeed', () => {
    const run = verify();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('RC=0');
    const lines = run.stdout.split('\n').filter((line) => line.startsWith('VERIFY '));
    expect(lines.map((line) => line.split(/\s+/)[2])).toEqual(['bot-role-grant', 'jarvis-ask', 'ticket-dispatch']);
    expect(lines.every((line) => line.startsWith('VERIFY PASS'))).toBe(true);
    expect(run.calls[0]).toMatch(/psql .*has_table_privilege/);
    expect(run.calls.some((call) => call.endsWith(' jarvis'))).toBe(true);
    expect(run.calls.some((call) => call.endsWith(' ticket'))).toBe(true);
  });

  it('fails LOUD and non-zero on a missing grant, naming the exact re-apply command', () => {
    const run = verify({ DOCKER_STUB_GRANT: 'f' });
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain('VERIFY FAIL  bot-role-grant');
    // The remedy has to be runnable as typed, not a pointer to "the migration".
    expect(run.stdout).toContain('docker cp scripts/migrations/140-bot-role-ownership-reads.sql');
    expect(run.stdout).toMatch(/psql -U \w+ -d \w+ -f \/tmp\/bot-role-grants\.sql/);
    // And it has to say why it will come back, or it gets re-applied forever without a fix.
    expect(run.stdout).toContain('scripts/governance/provision-app-role.mjs');
    expect(run.stdout).toContain('authorization_bot_posture_unavailable');
  });

  it('asserts the grant on the table the ADR-149 posture guard actually reads', () => {
    const run = verify();
    expect(run.calls[0]).toContain("has_table_privilege('oshal_bot', 'public.oshal_authorization_applications', 'SELECT')");
  });

  it.each([
    ['jarvis-ask', { DOCKER_STUB_JARVIS_RC: '1', DOCKER_STUB_JARVIS_OUT: "Jarvis returned status 'error'" }],
    ['ticket-dispatch', { DOCKER_STUB_TICKET_RC: '1', DOCKER_STUB_TICKET_OUT: "landed in 'escalated'" }],
  ])('makes a failing %s check fatal rather than advisory', (check, env) => {
    const run = verify(env as Record<string, string>);
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain(`VERIFY FAIL  ${check}`);
    expect(run.stdout).toContain('post-deploy live verification: 1 check(s) FAILED');
  });

  it('never reports success when the probe could not be staged', () => {
    const run = verify({ DOCKER_STUB_CP_RC: '1' });
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain('VERIFY FAIL  probe-staging');
    expect(run.stdout).not.toContain('VERIFY PASS  jarvis-ask');
  });

  it('honours exactly one documented skip switch, and runs nothing at all when it is set', () => {
    const run = verify({ OSHAL_DEPLOY_SKIP_LIVE_VERIFY: '1' });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('SKIPPED by OSHAL_DEPLOY_SKIP_LIVE_VERIFY');
    expect(run.stdout).toContain('UNVERIFIED as a product');
    expect(run.calls, 'a skipped verification must not touch docker').toEqual([]);
    // One reader of the switch, and no second skip-shaped variable anywhere in the library.
    expect(libSource.match(/\$\{OSHAL_DEPLOY_SKIP_LIVE_VERIFY:-0\}/g) ?? []).toHaveLength(1);
    const skipVars = new Set(libSource.match(/\bOSHAL_[A-Z_]*SKIP[A-Z_]*\b/g) ?? []);
    expect([...skipVars]).toEqual(['OSHAL_DEPLOY_SKIP_LIVE_VERIFY']);
  });

  it('is named in the runbook the failure messages point at', () => {
    const runbook = readFileSync(path.resolve('docs/runbooks/deploy-parity.md'), 'utf8');
    expect(runbook).toContain('OSHAL_DEPLOY_SKIP_LIVE_VERIFY');
    expect(runbook).toContain('scripts/lib/deploy-verify.sh');
  });

  it('is syntactically valid bash', () => {
    for (const file of [LIB, DEPLOY]) {
      const parsed = spawnSync(BASH, ['--noprofile', '--norc', '-n', file], { encoding: 'utf8', timeout: 10_000 });
      expect(parsed.stderr || '').toBe('');
      expect(parsed.status, file).toBe(0);
    }
  });
});

describe('scripts/oshal-deploy.sh — where the verification sits in the run', () => {
  const at = (needle: string) => {
    const index = deploySource.indexOf(needle);
    expect(index, `missing anchor: ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it('runs AFTER the health, parity and census gates and BEFORE the DEPLOYED line', () => {
    const call = at('if ! oshal_deploy_post_verify; then');
    expect(call).toBeGreaterThan(at('bash scripts/deploy-parity-check.sh --quiet >>'));
    expect(call).toBeGreaterThan(at('host /health not answering'));
    expect(call).toBeGreaterThan(at('unhealthy after grace window'));
    expect(call).toBeGreaterThan(at('log "census:'));
    expect(call).toBeLessThan(at('log "DEPLOYED '));
  });

  it('refuses at preflight when the verification helper is absent (never silently skipped)', () => {
    expect(deploySource).toContain('source "$VERIFY_HELPER" || fail2');
    expect(at('source "$VERIFY_HELPER"')).toBeLessThan(at('docker info >/dev/null'));
  });

  it('exits 4 — its own code — and does NOT roll back on a verification failure', () => {
    const block = deploySource.slice(at('if ! oshal_deploy_post_verify; then'), at('log "DEPLOYED '));
    expect(block).toContain('exit 4');
    expect(block, 'rolling back on a product failure replaces an outage with an outage plus a version surprise')
      .not.toMatch(/\brollback\b/);
    expect(block).toMatch(/NOT rolled back/i);
    // Reachable from nowhere else, or the code stops meaning anything.
    expect(deploySource.match(/exit 4/g) ?? []).toHaveLength(1);
    expect(deploySource.slice(0, deploySource.indexOf('set -uo pipefail'))).toMatch(/EXIT:[\s\S]*\b4\b/);
  });

  it('only prints DEPLOYED once the verification has passed', () => {
    const deployedLine = deploySource.slice(at('log "DEPLOYED '));
    expect(deployedLine.split('\n')[0]).toMatch(/live verification passed/);
  });

  it('leaves the existing rollback exit contract untouched', () => {
    expect(deploySource).toMatch(/fail2\(\) \{[^}]*exit 2/);
    expect(deploySource).toMatch(/NO_ROLLBACK" -eq 1 \] && \{[^}]*exit 1/);
  });
});


/* ── The probe's own verdicts, against a REAL loopback server speaking the api's contracts ──
 * The fixture server and the checks run in ONE process on purpose: this host's firewall refuses a
 * cross-process connection to a Node listener (curl reproduces it against the same socket that
 * answers a same-process fetch), so a spawned probe could only ever be tested against a doubled
 * fetch. Here the HTTP stack, the real `fetch`, the real headers and the real JSON are crossed.
 * What is NOT crossed, and is stated rather than implied: the real api, the real queue manager and
 * the real Jarvis bot. Only a deploy reaches those — which is why this ships as a deploy gate. */

type Reply = { status: number; body: unknown };
const probe = createRequire(import.meta.url)(PROBE) as {
  runCheck: (name: string) => Promise<{ ok: boolean; code: number; detail: string }>;
};

let server: Server;
let requests: string[] = [];
let replies: Record<string, Reply | Reply[]> = {};

/** Route one fixture request: drain and record it, then answer from the per-case `replies` table. */
function handle(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  const route = `${request.method} ${(request.url || '').split('?')[0]}`;
  requests.push(route);
  const key = Object.keys(replies).find((candidate) => route.startsWith(candidate));
  const configured = key ? replies[key] : undefined;
  const reply = Array.isArray(configured)
    ? (configured.length > 1 ? configured.shift()! : configured[0]!)
    : configured;
  response.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply?.body ?? {}));
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    PORT: String(port),
    SWARM_SERVICE_SECRET: SECRET,
    OSHAL_OPERATOR_SUBS: SUBJECT,
    OSHAL_VERIFY_SUB: '',
    OSHAL_VERIFY_POLL_MS: '5',
    OSHAL_VERIFY_BUDGET_MS: '400',
    OSHAL_VERIFY_REQUEST_TIMEOUT_MS: '4000',
  });
});

afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); });
afterEach(() => { requests = []; replies = {}; });

const MINT: Reply = { status: 201, body: { id: 'pat-1', token: 'never-printed-token-value' } };
const ASK_ACCEPTED: Reply = { status: 202, body: { jobId: 'job-1' } };

describe('scripts/operations/deploy-live-verification.js — verdicts and cleanup', () => {
  it('passes when Jarvis answers, and closes the thread and revokes the token afterwards', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/jarvis/ask': ASK_ACCEPTED,
      'GET /api/jarvis/ask/result': [{ status: 200, body: { status: 'pending' } }, { status: 200, body: { status: 'done', answer: 'ready' } }],
    };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain('Jarvis answered');
    expect(requests).toContain('POST /api/jarvis/thread/close');
    expect(requests).toContain('DELETE /api/cli-tokens/pat-1');
  });

  it.each([
    ['an error verdict', { status: 200, body: { status: 'error', error: 'authorization_bot_posture_unavailable' } }, 'authorization_bot_posture_unavailable'],
    ['a done verdict with no answer text', { status: 200, body: { status: 'done', answer: '' } }, 'no answer text'],
    ['an expired job', { status: 200, body: { status: 'expired' } }, "status 'expired'"],
  ])('fails on %s, and still revokes the token', async (_label, result, expected) => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': ASK_ACCEPTED, 'GET /api/jarvis/ask/result': result as Reply };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain(expected as string);
    expect(requests).toContain('DELETE /api/cli-tokens/pat-1');
  });

  it('fails when Jarvis never answers inside the budget', async () => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': ASK_ACCEPTED, 'GET /api/jarvis/ask/result': { status: 200, body: { status: 'pending' } } };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('never answered within');
    expect(requests).toContain('POST /api/jarvis/thread/close');
  });

  it('fails when the ask itself is refused, naming the status', async () => {
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/jarvis/ask': { status: 404, body: { error: 'session_not_found' } } };
    const verdict = await probe.runCheck('jarvis');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('404');
    expect(verdict.detail).toContain('session_not_found');
  });

  it('queues the synthetic ticket at the only state the queue manager polls', async () => {
    const bodies: unknown[] = [];
    replies = { 'POST /api/cli-tokens': MINT, 'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } }, 'GET /api/tickets/': { status: 200, body: { status: 'complete' } } };
    const capture = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => { bodies.push(Buffer.concat(chunks).toString('utf8')); handle(request, response); });
    });
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve));
    const previous = process.env.PORT;
    process.env.PORT = String((capture.address() as { port: number }).port);
    try {
      await probe.runCheck('ticket');
    } finally {
      process.env.PORT = previous;
      await new Promise<void>((resolve) => { capture.close(() => resolve()); });
    }
    const created = JSON.parse(bodies.find((body) => String(body).includes('ticketType')) as string);
    expect(created).toMatchObject({ status: 'approved', ticketType: 'task' });
  });

  it('passes when the queue moves the synthetic ticket, then cancels and deletes it', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': [{ status: 200, body: { status: 'approved' } }, { status: 200, body: { status: 'complete' } }],
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict, verdict.detail).toMatchObject({ ok: true, code: 0 });
    expect(verdict.detail).toContain("'approved' -> 'complete'");
    expect(requests).toContain('PUT /api/tickets/ticket-1/cancel');
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('fails when the ticket escalates — the exact 2026-09-15 shape — and still cleans up', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'escalated' } },
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain("landed in 'escalated'");
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('fails when the queue never dispatches the ticket at all', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/tickets': { status: 201, body: { ticketId: 'ticket-1' } },
      'GET /api/tickets/': { status: 200, body: { status: 'approved' } },
    };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('the queue never dispatched it');
    expect(requests).toContain('DELETE /api/tickets/ticket-1');
  });

  it('fails without leaking anything when the token cannot be minted', async () => {
    replies = { 'POST /api/cli-tokens': { status: 401, body: { error: 'service_secret_rejected' } } };
    const verdict = await probe.runCheck('ticket');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('could not mint an operator token');
    expect(requests).toEqual(['POST /api/cli-tokens']);
  });

  it('never puts the service secret, the minted token or the operator subject in its output', async () => {
    replies = {
      'POST /api/cli-tokens': MINT,
      'POST /api/jarvis/ask': ASK_ACCEPTED,
      'GET /api/jarvis/ask/result': { status: 200, body: { status: 'done', answer: 'ready' } },
    };
    const verdict = await probe.runCheck('jarvis');
    for (const secret of [SECRET, SUBJECT, 'never-printed-token-value']) {
      expect(verdict.detail, `the probe leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
  });

  it('refuses an unknown check name rather than doing something', async () => {
    const verdict = await probe.runCheck('something-else');
    expect(verdict.code).toBe(1);
    expect(verdict.detail).toContain('unknown check');
    expect(requests).toEqual([]);
  });
});

describe('scripts/operations/deploy-live-verification.js — the CLI wrapper', () => {
  /** Run the REAL script as the deploy runs it. NODE_TEST_CONTEXT is stripped so a child can
   *  never inherit a harness variable that rewrites its exit code. This case needs no network:
   *  a box with no operator identity is refused before the first request. */
  it('exits 2 and says so when the box carries no operator identity to ask as', () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.OSHAL_OPERATOR_SUBS;
    delete childEnv.OSHAL_VERIFY_SUB;
    const run = spawnSync(process.execPath, [PROBE, 'jarvis'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: childEnv });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(run.stdout).toContain('OSHAL_OPERATOR_SUBS is empty');
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
  });
});
