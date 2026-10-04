/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Actual HTTP refusals precede process-log reads and global collectors; operator results and caller summaries remain usable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operatorAdministrationFixture } from '../fixtures/operator-administration';

let fixture: Awaited<ReturnType<typeof operatorAdministrationFixture>>;
beforeEach(async () => { fixture = await operatorAdministrationFixture(); });
afterEach(async () => { await fixture?.close(); });

describe('declared operator administration policy over actual HTTP routes', () => {
  it.each(['/api/v1/logs/query', '/api/v1/logs/modules', '/api/v1/metrics/swarm', '/api/qm/activity'])(
    'refuses unsigned and ordinary callers to %s before any global service read', async route => {
      expect((await fixture.call(route, 'anonymous')).status).toBe(401);
      const response = await fixture.call(route + '?scope=all&ownerSub=fixture-operator&operator=true&ticketId=foreign-ticket');
      expect(response.status).toBe(403);
      expect(await response.text()).not.toMatch(/PRIVATE|foreign-ticket|GLOBAL METRICS/);
      for (const read of [fixture.logQuery, fixture.logModules, fixture.listTickets, fixture.listTasks,
        fixture.aggregate, fixture.recent, fixture.snapshot]) expect(read).not.toHaveBeenCalled();
    },
  );

  it('returns real isolated log bytes and modules for an operator', async () => {
    const response = await fixture.call('/api/v1/logs/query?search=PRIVATE', 'operator');
    expect(response.status).toBe(200); expect(await response.text()).toContain('PRIVATE PROCESS LOG');
    expect(await (await fixture.call('/api/v1/logs/modules', 'operator')).json()).toEqual({ modules: ['fixture-module'] });
    expect(fixture.logQuery).toHaveBeenCalledTimes(1); expect(fixture.logModules).toHaveBeenCalledTimes(1);
  });

  it('preserves the operator global pipeline collector and queue snapshot', async () => {
    const metrics = await fixture.call('/api/v1/metrics/swarm', 'operator');
    expect(metrics.status).toBe(200); expect(await metrics.text()).toContain('foreign-ticket');
    expect(fixture.aggregate).toHaveBeenCalledTimes(1); expect(fixture.recent).toHaveBeenCalledWith(20);
    const queue = await fixture.call('/api/qm/activity', 'operator');
    expect(queue.status).toBe(200);
    expect(JSON.stringify(await queue.json())).toContain('PRIVATE ROUTING FAILURE');
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  });

  it('rechecks operator admission on the next request after the allowlist changes', async () => {
    expect((await fixture.call('/api/v1/metrics/swarm', 'operator')).status).toBe(200);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await fixture.call('/api/v1/metrics/swarm', 'operator')).status).toBe(403);
    expect(fixture.aggregate).toHaveBeenCalledTimes(1); expect(fixture.recent).toHaveBeenCalledTimes(1);
  });

  it('keeps the caller summary route open and owner-scoped', async () => {
    const response = await fixture.call('/api/v1/metrics/summary?scope=all');
    expect(response.status).toBe(200);
    expect(fixture.listTickets).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'fixture-member' }));
    expect(fixture.listTasks).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'fixture-member' }));
    expect(fixture.aggregate).not.toHaveBeenCalled(); expect(fixture.snapshot).not.toHaveBeenCalled();
  });
});
