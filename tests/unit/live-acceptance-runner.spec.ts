/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the shared live-acceptance machinery: fixture tags; the cleanup ledger (anything created and not removed, or any cleanup error, turns the result red); fixture-workspace removal that refuses non-fixture ids and frames stamped for another owner (real files on disk); the closed statement set (every statement owner-scoped by $1, unknown names refused); the in-container helper (validated requests, every database operation inside the owner's request identity); and the host runner (the operator token only ever in the Authorization header of the runner's own requests, never on a docker command line; the helper's request forwarded by name; exit codes; list and no-token paths).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The host runner's `anonymous` port sends the same JSON request with no Authorization header at all (the dev-workspace case proves its query route refuses such a caller), while `api` keeps sending the token.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const common = requireCjs('../../scripts/lib/live-acceptance-common.js');
const sql = requireCjs('../../scripts/lib/live-acceptance-sql.js');
const helper = requireCjs('../../scripts/lib/live-acceptance-container.js');
const runner = requireCjs('../../scripts/operations/live-acceptance.js');
const { CASES } = requireCjs('../../scripts/lib/live-acceptance-cases.js');

const OWNER = 'fixture|runner-owner';
const TOKEN = 'oshal_pat_fixture_runner_0000';
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('fixture tags and the cleanup ledger', () => {
  it('mints tags only in the testlab-live family', () => {
    const tag = common.mintTag('floater');
    expect(tag).toMatch(/^testlab-live-floater-[0-9a-f]{8}$/);
    expect(common.isFixtureTag(`${tag}-2`)).toBe(true);
    for (const bad of ['../etc', 'testlab-live-x', 'jarvis-owner', 'testlab-live-floater-0a1b2c3d/../x']) expect(common.isFixtureTag(bad)).toBe(false);
    expect(() => common.mintTag('Bad Key')).toThrow('invalid case key');
  });

  it('turns an unremoved fixture or a cleanup error into a red result, and keeps a kept item green', async () => {
    const clean = new common.CleanupLedger();
    clean.created('ticket', 't1');
    clean.removed('ticket', 't1');
    clean.kept('handle', 'h1', 'memory-only');
    expect(common.finish('case', { state: 'pass', detail: 'ok.' }, clean)).toMatchObject({ state: 'pass', detail: 'ok.' });
    const missed = new common.CleanupLedger();
    missed.created('ticket', 't2');
    await missed.attempt('delete', async () => { throw new Error('boom'); });
    const result = common.finish('case', { state: 'pass', detail: 'ok.' }, missed);
    expect(result.state).toBe('fail');
    expect(result.detail).toBe('ok. CLEANUP INCOMPLETE: delete failed: boom; ticket t2 was not removed.');
    expect(common.receiptLine(result.cleanup)).toBe('removed 0; kept 0; outstanding 1 (ticket t2); errors 1 (delete failed: boom)');
    const forgotten = new common.CleanupLedger();
    forgotten.created('ticket', 't3');
    expect(common.finish('case', { state: 'pass', detail: 'ok.' }, forgotten)).toMatchObject({ state: 'fail', detail: 'ok. CLEANUP INCOMPLETE: ticket t3 was not removed.' });
    const twice = new common.CleanupLedger();
    twice.created('linkedin-draft', 41);
    twice.removed('linkedin-draft', 41);
    twice.created('linkedin-draft', 41, 'written again after the ticket was deleted');
    expect(twice.outstanding()).toEqual([{ kind: 'linkedin-draft', id: '41' }]);
    twice.removed('linkedin-draft', 41);
    expect(twice.complete()).toBe(true);
  });

  it('removes only a fixture-tagged workspace whose frames all belong to the owner', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'live-acceptance-ws-'));
    scratch.push(root);
    const mine = 'testlab-live-jarvis-cache-0a1b2c3d-1';
    const theirs = 'testlab-live-jarvis-cache-0a1b2c3d-2';
    for (const [id, owner] of [[mine, OWNER], [theirs, 'fixture|someone-else']]) {
      mkdirSync(path.join(root, id, '.tokenchase'), { recursive: true });
      writeFileSync(path.join(root, id, '.tokenchase', 'frame-0001.json'), JSON.stringify({ userSub: owner }));
    }
    expect(common.fixtureWorkspaceState(root, mine)).toBe('running');
    writeFileSync(path.join(root, mine, '.tokenchase', 'final.json'), '{}');
    expect(common.fixtureWorkspaceState(root, mine)).toBe('final');
    expect(common.removeFixtureWorkspace(root, 'not-a-fixture', OWNER)).toContain('refusing');
    expect(common.removeFixtureWorkspace(root, theirs, OWNER)).toContain('stamped for another owner');
    expect(existsSync(path.join(root, theirs))).toBe(true);
    expect(common.removeFixtureWorkspace(root, mine, OWNER)).toBeNull();
    expect(existsSync(path.join(root, mine))).toBe(false);
    expect(common.fixtureWorkspaceState(root, mine)).toBe('absent');
  });
});

describe('the closed statement set and the in-container helper', () => {
  it('owner-scopes every statement by $1 and refuses any other name', () => {
    for (const [name, text] of Object.entries(sql.STATEMENTS as Record<string, string>)) {
      expect(text, name).toMatch(/\b(owner_sub|user_sub) = \$1\b/);
      expect(text, name).not.toMatch(/\$\d+\s*::\s*regclass|;\s*\S/);
    }
    expect(() => sql.statementText('DROP TABLE tickets')).toThrow('unknown live-acceptance statement');
  });

  it('validates requests before touching anything', () => {
    expect(() => helper.parseRequest('{"op":"shell","sub":"x"}')).toThrow('unknown or missing op');
    expect(() => helper.parseRequest('{"op":"sql","sub":"x","name":"nope","params":[]}')).toThrow('unknown live-acceptance statement');
    expect(() => helper.parseRequest('{"op":"sql","name":"linkedin.draft-residue","params":[]}')).toThrow('owner subject');
    expect(() => helper.parseRequest('{"op":"ticket-get","sub":"x"}')).toThrow('an id is required');
    expect(helper.parseRequest('{"op":"sql","sub":"x","name":"linkedin.draft-residue","params":["x","t"]}').name).toBe('linkedin.draft-residue');
  });

  it('runs database operations inside the owner request identity', async () => {
    const scopes: unknown[] = [];
    let inside = false;
    const deps = {
      runWithRequestIdentity: async (identity: unknown, fn: () => Promise<unknown>) => { scopes.push(identity); inside = true; try { return await fn(); } finally { inside = false; } },
      pool: { query: async (text: string, params: unknown[]) => { expect(inside).toBe(true); return { rows: [{ text, params }] }; } },
      tickets: { getTicket: async () => { expect(inside).toBe(true); return { ticketId: 't', ownerSub: OWNER, ticketType: 'x', status: 'approved', metadata: { a: 1 }, secret: 'no' }; },
        deleteTicket: async () => { expect(inside).toBe(true); } },
      workspaceRoot: tmpdir(),
    };
    const out = await helper.execute({ op: 'sql', sub: OWNER, name: 'linkedin.draft-residue', params: [OWNER, 't'] }, deps);
    expect(out.rows[0].text).toBe(sql.STATEMENTS['linkedin.draft-residue']);
    expect((await helper.execute({ op: 'ticket-get', sub: OWNER, id: 't' }, deps)).ticket).toEqual({ ticketId: 't', ownerSub: OWNER, ticketType: 'x', status: 'approved', metadata: { a: 1 } });
    expect(await helper.execute({ op: 'ticket-delete', sub: OWNER, id: 't' }, deps)).toEqual({ deleted: true });
    expect(scopes).toEqual([1, 2, 3].map(() => ({ sub: OWNER, isOperator: false })));
    expect(await helper.execute({ op: 'workspace-state', sub: OWNER, id: 'testlab-live-x-0a1b2c3d' }, deps)).toEqual({ state: 'absent' });
  });
});

describe('the host runner', () => {
  it('sends the token only as the Authorization header of its own requests', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
    const ports = runner.httpPorts('http://127.0.0.1:35457', TOKEN, fetchImpl);
    const res = await ports.api('POST', '/api/x', { a: 1 }, { headers: { origin: 'http://127.0.0.1:35457', 'x-oshal-test-lab': '1' } });
    await ports.upload('/api/artifacts/handles/upload', { type: 'application/pdf' }, { name: 'a.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-') });
    expect(res).toMatchObject({ status: 200, json: { ok: true } });
    expect(seen[0].init.headers).toEqual({ 'content-type': 'application/json', origin: 'http://127.0.0.1:35457', 'x-oshal-test-lab': '1', authorization: `Bearer ${TOKEN}` });
    expect(seen[0].init.redirect).toBe('manual');
    expect(seen[1].init.body).toBeInstanceOf(FormData);
    expect(seen.every((s) => s.url.startsWith('http://127.0.0.1:35457/'))).toBe(true);
  });

  it('sends no credential on the anonymous port', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }); };
    const ports = runner.httpPorts('http://127.0.0.1:35457', TOKEN, fetchImpl);
    const res = await ports.anonymous('GET', '/api/dev-workspace-index/query?q=ADR-077');
    await ports.api('GET', '/api/dev-workspace-index/dev-mode');
    expect(res).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
    expect(seen[0].url).toBe('http://127.0.0.1:35457/api/dev-workspace-index/query?q=ADR-077');
    expect(seen[0].init.headers).toEqual({});
    expect(JSON.stringify(seen[0].init)).not.toContain(TOKEN);
    expect(seen[1].init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it('forwards the helper request by name and never puts it or the token on a docker command line', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const exec = (args: string[], env: NodeJS.ProcessEnv) => {
      calls.push({ args, env });
      return { status: 0, stdout: args[0] === 'exec' && args.includes('node') ? 'RESULT {"ok":true,"rows":[{"drafts":0}]}\n' : '', stderr: '' };
    };
    const container = runner.containerHelper('oshal-local-api', exec);
    const ports = runner.containerPorts(container, OWNER);
    expect(await ports.sql('linkedin.draft-residue', [OWNER, 't'])).toEqual({ rows: [{ drafts: 0 }] });
    container.dispose();
    const run = calls.find((c) => c.args.includes('node'))!;
    expect(run.args).toContain('OSHAL_LIVE_ACCEPTANCE_REQUEST');
    expect(run.args.some((a) => a.startsWith('OSHAL_LIVE_ACCEPTANCE_REQUEST='))).toBe(false);
    expect(JSON.parse(run.env.OSHAL_LIVE_ACCEPTANCE_REQUEST!)).toEqual({ op: 'sql', sub: OWNER, name: 'linkedin.draft-residue', params: [OWNER, 't'] });
    expect(calls.flatMap((c) => c.args).some((a) => a.includes(OWNER) || a.includes('oshal_pat_'))).toBe(false);
    expect(calls.map((c) => c.args[0])).toEqual(['exec', 'cp', 'cp', 'cp', 'exec', 'exec']);
    expect(calls[calls.length - 1].args.slice(-3, -1)).toEqual(['rm', '-rf']);
  });

  it('exits 0 only when every case passed, and refuses without a token', async () => {
    expect(runner.exitCodeFor([{ state: 'pass' }])).toBe(0);
    expect(runner.exitCodeFor([{ state: 'pass' }, { state: 'unavailable' }])).toBe(3);
    expect(runner.exitCodeFor([{ state: 'pass' }, { state: 'fail' }])).toBe(1);
    const lines: string[] = [];
    const saved = { ...process.env };
    try {
      delete process.env.OSHAL_VERIFY_OPERATOR_PAT;
      process.env.OSHAL_VERIFY_ENV_FILE = path.join(tmpdir(), 'no-such-live-acceptance.env');
      expect(await runner.main(['congress'], (l: string) => lines.push(l))).toBe(2);
    } finally {
      process.env = saved;
    }
    expect(lines).toEqual(['UNAVAILABLE: OSHAL_VERIFY_OPERATOR_PAT is neither exported nor in the .env; nothing was written.']);
    const listed: string[] = [];
    expect(await runner.main(['list'], (l: string) => listed.push(l))).toBe(0);
    expect(listed).toHaveLength(CASES.length);
  });
});
