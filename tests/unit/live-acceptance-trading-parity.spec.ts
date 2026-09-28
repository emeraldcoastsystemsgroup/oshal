/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the trading-parity live-acceptance case over a fake api port: passes only when the parity card's three steps pass, the plan route answers its plans and arm, and BOTH unconfirmed promotion paths answer 428; a failed card step or a confirm gate that lets a change through fails it; a degraded step (not armed on paper), an older package (404) or an older card (two steps) is not runnable rather than a pass. No request the case sends carries confirm, and it creates nothing, so its cleanup receipt is empty.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, type FakeHandler, type RecordedCall } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const parity = requireCjs('../../scripts/lib/live-acceptance-trading-parity.js');
const PAPER_ID = '11111111-2222-4333-8444-5555555500ee';

type Step = { state: string; detail: string };
const step = (state: string, detail = `${state} detail`): Step => ({ state, detail });

function world(options: { steps?: Step[]; plansStatus?: number; amendStatus?: number; mixStatus?: number; over?: Record<string, FakeHandler> } = {}) {
  return fakeApi({
    'POST /api/test-lab/run': ({ body }) => ({ status: 200, json: { results: [{ id: (body as { scenarioId: string }).scenarioId, steps: options.steps ?? [step('pass'), step('pass'), step('pass')] }] } }),
    'GET /api/trading/position-plans': () => (options.plansStatus === 404
      ? { status: 404, json: { error: 'not_found' } }
      : { status: 200, json: { book: 'paper', plans: [{ symbol: 'AAPL' }], armed: { sessions: 20, source: 'env' } } }),
    'GET /api/trading/accounts': () => ({ status: 200, json: { books: [{ bookId: PAPER_ID, ref: 'paper', kind: 'paper' }, { bookId: 'x', ref: 'live', kind: 'live' }] } }),
    'POST /api/trading/position-plans/amend': () => ({ status: options.amendStatus ?? 428, json: { error: 'confirm_required' } }),
    'POST /api/trading/accounts/books/:bookId/mix': () => ({ status: options.mixStatus ?? 428, json: { error: 'confirm_required' } }),
    ...(options.over || {}),
  });
}

/** Every write-capable call the case made carried no confirm flag. */
const noConfirm = (calls: RecordedCall[]) => calls.filter((c) => c.method !== 'GET').every((c) => (c.body as { confirm?: unknown } | undefined)?.confirm === undefined);

describe('trading-parity live acceptance', () => {
  it('passes: all three card steps pass, the plan route answers, and both unconfirmed promotion paths refuse 428', async () => {
    const api = world();
    const result = await parity.run({ api: api.api });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('paper book: 1 open plan(s), plans armed at 20 sessions (env)');
    expect(result.detail).toContain('unconfirmed amend -> HTTP 428, unconfirmed parity mix edit -> HTTP 428');
    expect(result.detail).toContain('market-gap-readback=pass, exit-plan-readback=pass, yield-sleeve-readback=pass');
    expect(api.calls.find((c) => c.path.endsWith('/mix'))?.path).toBe(`/api/trading/accounts/books/${PAPER_ID}/mix`);
    expect(noConfirm(api.calls), 'no request may carry confirm').toBe(true);
    expect(result.cleanup).toMatchObject({ removed: [], outstanding: [], errors: [] });
  });

  it('fails when a promotion path lets an unconfirmed change through, or a card step fails', async () => {
    expect((await parity.run({ api: world({ mixStatus: 200 }).api })).state).toBe('fail');
    expect((await parity.run({ api: world({ amendStatus: 200 }).api })).state).toBe('fail');
    const failed = await parity.run({ api: world({ steps: [step('pass'), step('fail', 'The readback could not complete'), step('pass')] }).api });
    expect(failed.state).toBe('fail');
    expect(failed.detail).toContain('The readback could not complete');
  });

  it('a feature not armed on paper is not runnable yet (the step names the setting), never a pass', async () => {
    const r = await parity.run({ api: world({ steps: [step('pass'), step('pass'), step('degraded', 'set TRADING_YIELD_SLEEVE=paper')] }).api });
    expect(r.state).toBe('unavailable');
    expect(r.detail).toContain('TRADING_YIELD_SLEEVE=paper');
  });

  it('an older package (no plan route) or an older card (two steps) is not runnable, and nothing is posted', async () => {
    const old = world({ plansStatus: 404 });
    const r = await parity.run({ api: old.api });
    expect(r.state).toBe('unavailable');
    expect(r.detail).toContain('not mounted');
    expect(old.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect((await parity.run({ api: world({ steps: [step('pass'), step('pass')] }).api })).state).toBe('unavailable');
  });

  it('with no api port the case is not runnable and says so', async () => {
    const r = await parity.run({});
    expect(r.state).toBe('unavailable');
    expect(r.detail).toContain('no api port');
  });
});
