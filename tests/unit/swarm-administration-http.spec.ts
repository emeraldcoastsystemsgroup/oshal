/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mounted HTTP refusal precedes global stores/Plane reads; current operators and normal processing routes retain their contracts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { swarmAdministrationFixture } from '../fixtures/swarm-administration';

let fixture: Awaited<ReturnType<typeof swarmAdministrationFixture>>;
beforeEach(async () => { fixture = await swarmAdministrationFixture(); });
afterEach(async () => { await fixture?.close(); });

describe('global swarm administration over mounted HTTP and current canonical policy', () => {
  it.each(['/runs', '/runs/foreign-run', '/runs/missing-run', '/work-items',
    '/work-items?externalId=foreign-ticket', '/work-items?runId=foreign-run', '/smoke'])(
    'refuses unsigned/ordinary callers to %s before store, cursor or Plane reads', async route => {
      expect((await fixture.call(route, 'anonymous')).status).toBe(401);
      const query = route.includes('?') ? '&' : '?';
      const response = await fixture.call(route + query + 'ownerSub=fixture-operator&scope=all&operator=true&limit=invalid');
      expect(response.status).toBe(403);
      expect(await response.text()).not.toMatch(/PRIVATE|foreign-ticket|foreign-run|fixture-next/);
      for (const read of [fixture.listRuns, fixture.getRun, fixture.recent, fixture.external, fixture.byRun,
        fixture.pullPlane, fixture.getCursor, fixture.setCursor, fixture.escalationRead]) expect(read).not.toHaveBeenCalled();
      expect(fixture.submit).not.toHaveBeenCalled(); expect(fixture.process).not.toHaveBeenCalled();
    },
  );

  it('retains actual isolated run list, detail and missing-record behavior for database-role operators', async () => {
    const list = await fixture.call('/runs?limit=1', 'operator'); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ count: 1, runs: [{ runId: 'foreign-run', error: 'PRIVATE RUN OUTPUT' }] });
    const detail = await fixture.call('/runs/foreign-run', 'operator'); expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ runId: 'foreign-run', error: 'PRIVATE RUN OUTPUT' });
    expect((await fixture.call('/runs/missing-run', 'operator')).status).toBe(404);
    expect(fixture.listRuns).toHaveBeenCalledWith(1);
    expect(fixture.getRun.mock.calls).toEqual([['foreign-run'], ['missing-run']]);
  });

  it('retains all three operator repository selections without promoting query IDs to caller authority', async () => {
    for (const route of ['/work-items?limit=1', '/work-items?externalId=foreign-ticket', '/work-items?runId=foreign-run']) {
      const response = await fixture.call(route, 'operator'); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ count: 1, workItems: [{ title: 'PRIVATE WORK',
        executionOutput: 'PRIVATE EXECUTION', verificationResult: 'PRIVATE VERIFICATION' }] });
    }
    expect(fixture.recent).toHaveBeenCalledWith(1); expect(fixture.external).toHaveBeenCalledWith('foreign-ticket');
    expect(fixture.byRun).toHaveBeenCalledWith('foreign-run');
  });

  it('permits an operator Plane diagnostic through real intake with bounded reads and no checkpoint write', async () => {
    const response = await fixture.call('/smoke', 'operator'); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, provider: 'plane', itemCount: 1,
      items: [{ title: 'PRIVATE PLANE', rawPayload: { privateMarker: 'PRIVATE PLANE PAYLOAD' } }] });
    expect(fixture.pullPlane).toHaveBeenCalledTimes(1);
    expect(fixture.pullPlane).toHaveBeenCalledWith({ limit: 1, useStoredCursor: false, persistCursor: false, cursor: undefined });
    expect(fixture.getCursor).toHaveBeenCalledWith('plane'); expect(fixture.setCursor).not.toHaveBeenCalled();
  });

  it('rechecks database role revocation and preserves the separate break-glass operator path', async () => {
    expect((await fixture.call('/runs', 'operator')).status).toBe(200);
    clearPrivilegedIdentities(); expect((await fixture.call('/runs', 'operator')).status).toBe(403);
    expect((await fixture.call('/runs', 'breakglass')).status).toBe(200);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', ''); expect((await fixture.call('/runs', 'breakglass')).status).toBe(403);
    expect(fixture.listRuns).toHaveBeenCalledTimes(2);
  });

  it('preserves ordinary direct-ticket and non-GitHub provider processing, with isolated execution effects', async () => {
    const direct = await fixture.call('/tickets', 'member', 'POST', { tickets: [{ title: 'My normal work' }] });
    expect(direct.status).toBe(200); expect(await direct.json()).toMatchObject({ runId: 'submitted-run' });
    expect(fixture.submit).toHaveBeenCalledWith([expect.objectContaining({ title: 'My normal work', provider: 'direct' })], { policy: undefined });
    expect((await fixture.call('/providers/plane/process', 'member', 'POST', {})).status).toBe(200);
    expect(fixture.process).toHaveBeenCalledWith('plane', expect.objectContaining({ limit: 50, interactionMode: 'ticket' }));
    expect((await fixture.call('/providers/github/process', 'member', 'POST', {})).status).toBe(403);
    expect(fixture.process).toHaveBeenCalledTimes(1); expect(fixture.pullPlane).not.toHaveBeenCalled();
  });
});
