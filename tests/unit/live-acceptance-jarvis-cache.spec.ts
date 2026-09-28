/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Jarvis prompt-cache live-acceptance case's own logic: the call-log parser reads the exact line OpenAIProvider.js prints (checked against the provider source, so a reworded line turns this red) from `docker logs --timestamps` output in pino-JSON or plain form and keeps only its window; created -> hit -> hit with cached tokens = pass, a cold cache on a later conversation = fail, no OpenAI-compatible call at all = unavailable naming the ledger's provider; three fresh tagged conversations are asked the same conversational question and each is closed, its chat ticket and task deleted, its job dismissed and its workspace removed, with a residue read that must be empty (residue or a still-running workspace = red cleanup); without the host log port it writes nothing; the measurement renders between the recall note's markers. The real companion is `node scripts/operations/live-acceptance.js jarvis-cache` on the box.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const cache = requireCjs('../../scripts/lib/live-acceptance-jarvis-cache.js');

const OWNER = 'fixture|jarvis-cache-owner';
const TAG = 'testlab-live-jarvis-cache-0a1b2c3d';
const JARVIS = 'a0000000-0000-4000-8000-000000000050';
const line = (at: number, state: string, input: number, cached: number) =>
  `${new Date(at).toISOString()} {"level":30,"time":${at},"msg":"OpenAI-compatible call (gemini-3.5-flash @ generativelanguage): 2100ms, ${input + 4} tokens (input ${input}, output 4, cached ${cached}), invariant cache ${state}"}`;

function world(options: { states?: Array<[string, number]>; residue?: number; workspace?: string; noCalls?: boolean } = {}) {
  const clock = fakeClock();
  const logs: string[] = [];
  const states = options.states ?? [['created', 0], ['hit', 4096], ['hit', 4096]];
  let asks = 0;
  const api = fakeApi({
    'POST /api/jarvis/ask': ({ body }) => {
      const { sessionId } = body as { sessionId: string };
      clock.advance(20_000);
      const [state, cached] = states[asks] ?? ['none', 0];
      if (!options.noCalls) logs.push(line(clock.now(), state, 6000 - cached, cached));
      asks += 1;
      return { status: 202, json: { jobId: `job-${asks}`, sessionId, chatTicketId: `ticket-${asks}` } };
    },
    'GET /api/jarvis/ask/result': () => ({ status: 200, json: { status: 'done', answer: '5' } }),
    'GET /api/jarvis/history': () => ({ status: 200, json: { turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: '5' }] } }),
    'GET /api/agents': () => ({ status: 200, json: [{ name: 'oshal-assistant', agentId: JARVIS }] }),
    'POST /api/jarvis/thread/close': () => ({ status: 200 }),
    'DELETE /api/tickets/:id': () => ({ status: 200 }),
    'DELETE /api/tasks/:id': () => ({ status: 200 }),
    'POST /api/jarvis/ask/dismiss': () => ({ status: 200 }),
  });
  const statements: Array<{ name: string; params: unknown[] }> = [];
  const sql = async (name: string, params: unknown[]) => {
    statements.push({ name, params });
    if (name === 'jarvis.cost-events') return { rows: [1, 2, 3].map((i) => ({ task_id: `${TAG}-${i}::${JARVIS}`, provider_id: options.noCalls ? 'antigravity-cli' : 'google', model_id: 'm', input_tokens: 6000 })) };
    if (name === 'jarvis.rollups') return { rows: [{ task_id: `${TAG}-1`, total_input_tokens: 6000 }] };
    return { rows: [{ chat_tasks: options.residue ?? 0, chat_messages: 0, chat_tickets: 0, work_items: 0 }] };
  };
  const removed: string[] = [];
  const workspace = {
    state: async () => { clock.advance(30_000); return options.workspace ?? 'final'; },
    remove: async (id: string) => { removed.push(id); return null; },
  };
  const logPort = async (container: string, since: string) => { expect(container).toBe('oshal-local-jarvis-bot'); expect(Number.isNaN(Date.parse(since))).toBe(false); return [...logs]; };
  return { api, sql, statements, removed, ports: { api: api.api, sql, logs: logPort, workspace, ownerSub: OWNER, ...clock } };
}

describe('Jarvis prompt-cache live acceptance', () => {
  it('reads the exact call-log line the OpenAI-compatible provider prints', () => {
    const provider = readFileSync('any-bot/server/services/llm/OpenAIProvider.js', 'utf8');
    expect(provider).toContain('`OpenAI-compatible call (${this.model} @ ${this.endpointLabel}): ${latency}ms, ${usage.totalTokens} tokens `');
    expect(provider).toContain('`(input ${usage.inputTokens}, output ${usage.outputTokens}, cached ${usage.cacheReads}), invariant cache ${promptCache}`');
    const at = Date.parse('2026-09-28T12:00:10Z');
    const calls = cache.parseCallLines([line(at, 'hit', 2000, 4096), `2026-09-28T12:00:11.000000000Z OpenAI-compatible call (m @ e): 90ms, 10 tokens (input 6, output 4, cached 0), invariant cache created`,
      line(at + 3_600_000, 'hit', 1, 1), '2026-09-28T12:00:12Z unrelated'], at - 1000, at + 5000);
    expect(calls.map((c: { state: string; cached: number; input: number }) => [c.state, c.cached, c.input])).toEqual([['hit', 4096, 2000], ['created', 0, 6]]);
  });

  it('passes on created then hit with cached tokens, and removes every conversation', async () => {
    const w = world();
    const result = await cache.run(w.ports, { tag: TAG });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('created -> hit(4096 cached) -> hit(4096 cached)');
    const asks = w.api.calls.filter((c) => c.path === '/api/jarvis/ask').map((c) => c.body);
    expect(asks).toEqual([1, 2, 3].map((i) => ({ message: cache.QUESTION, sessionId: `${TAG}-${i}` })));
    expect(w.removed).toEqual([`${TAG}-1`, `${TAG}-2`, `${TAG}-3`]);
    expect(w.statements.find((s) => s.name === 'jarvis.residue')!.params).toEqual([OWNER, [`${TAG}-1`, `${TAG}-2`, `${TAG}-3`]]);
    expect(w.statements.find((s) => s.name === 'jarvis.cost-events')!.params.slice(0, 2)).toEqual([OWNER, JARVIS]);
    expect(result.evidence.conversations.map((m: { ledgerInput: number }) => m.ledgerInput)).toEqual([6000, 6000, 6000]);
    expect(result.cleanup.outstanding).toEqual([]);
    expect(result.cleanup.kept).toEqual([`cost-ledger ${TAG} (oshal_cost_events rows and chat_tasks usage rollups record real spend)`]);
  });

  it('fails a later conversation that misses the cache', async () => {
    const result = await cache.run(world({ states: [['created', 0], ['created', 0], ['hit', 4096]] }).ports, { tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('created -> created -> hit(4096 cached)');
  });

  it('is unavailable, naming the ledger provider, when Jarvis answered on another brain', async () => {
    const result = await cache.run(world({ noCalls: true }).ports, { tag: TAG });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('Jarvis answered on another brain (antigravity-cli/m)');
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('turns residue or a still-running workspace into a red cleanup', async () => {
    const residue = await cache.run(world({ residue: 1 }).ports, { tag: TAG });
    expect(residue.state).toBe('fail');
    expect(residue.detail).toContain('residue remains for');
    const running = world({ workspace: 'running' });
    const left = await cache.run(running.ports, { tag: TAG });
    expect(left.state).toBe('fail');
    expect(left.detail).toContain('the bot was still writing the ask workspace; it was left');
    expect(running.removed).toEqual([]);
  });

  it('writes nothing without the host log port', async () => {
    const w = world();
    const result = await cache.run({ ...w.ports, logs: undefined }, { tag: TAG });
    expect(result.state).toBe('unavailable');
    expect(w.api.calls).toEqual([]);
  });

  it('renders the measurement between the recall note\'s markers', async () => {
    const result = await cache.run(world().ports, { tag: TAG });
    const block = cache.renderMeasurementBlock(result, { date: '2026-09-28 12:00 UTC', commit: '47baec80' });
    expect(block.startsWith(cache.DOC_START)).toBe(true);
    expect(block).toContain('| 2 | 0 | 1 | hit | 1904 | 4096 | 4 | 2100 | 6000 | 0 |');
    const note = readFileSync('docs/architecture/jarvis-own-task-recall.md', 'utf8');
    const written = cache.writeMeasurement(note, block);
    expect(written).toContain('core 47baec80');
    expect(written.split(cache.DOC_START)).toHaveLength(2);
    expect(() => cache.writeMeasurement('no markers here', block)).toThrow('marker pair');
  });
});
