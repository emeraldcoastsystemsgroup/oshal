/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify publishing, clone activation and pending manifests require current operator authority before effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { swarmPublishingFixture } from '../fixtures/workflow-administration';

let fixture: Awaited<ReturnType<typeof swarmPublishingFixture>>;
beforeEach(async () => { fixture = await swarmPublishingFixture(); });
afterEach(async () => { await fixture.close(); });
const spec = { name: 'published-workflow', mode: 'single-shot', workerBot: 'shared-bot',
  bots: [{ agentId: 'shared-bot', name: 'Shared bot' }] };

describe('shared bot activation administration', () => {
  it.each(['person', 'tenant', 'public'])('refuses %s publishing before compilation, files or activation', async scope => {
    for (const user of ['unknown', 'member']) {
      const response = await fixture.call('/api/swarm/apps/publish?isOperator=true', user, 'POST', { spec, scope, ownerSub: 'fixture-operator' });
      expect(response.status).toBe(user === 'unknown' ? 401 : 403);
    }
    expect(fixture.compile).not.toHaveBeenCalled(); expect(fixture.getApp).not.toHaveBeenCalled();
    expect(fixture.loadApp).not.toHaveBeenCalled(); expect(existsSync(path.join(fixture.directory, 'deployed-apps'))).toBe(false);
  });

  it('refuses clone activation and pending reads before resolving shared apps or manifest files', async () => {
    for (const user of ['unknown', 'member']) {
      const denied = user === 'unknown' ? 401 : 403;
      expect((await fixture.call('/api/swarm/apps/shared-workflow/clone', user, 'POST', { name: 'member-copy', isOperator: true })).status).toBe(denied);
      expect((await fixture.call('/api/swarm/apps/pending?ownerSub=fixture-operator', user)).status).toBe(denied);
    }
    expect(fixture.getApp).not.toHaveBeenCalled(); expect(fixture.listApps).not.toHaveBeenCalled();
    expect(fixture.files).not.toHaveBeenCalled(); expect(fixture.loadApp).not.toHaveBeenCalled();
    expect(existsSync(path.join(fixture.directory, 'deployed-apps'))).toBe(false);
  });

  it.each(['person', 'tenant', 'public'])('preserves operator %s publishing with real compilation and isolated manifests', async scope => {
    const response = await fixture.call('/api/swarm/apps/publish', 'operator', 'POST', { spec, scope, ownerSub: 'forged-owner' });
    expect(response.status).toBe(201); const body = await response.json();
    expect(body.manifestPath).toBe(path.join(fixture.directory, 'deployed-apps', spec.name + '.yaml'));
    expect(readFileSync(body.manifestPath, 'utf8')).toContain('shared-bot');
    expect(fixture.compile).toHaveBeenCalledWith(spec, scope);
    expect(fixture.loadApp).toHaveBeenCalledWith(body.manifestPath, { scope, ownerSub: scope === 'person' ? 'fixture-operator' : null, tenantId: null });
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await fixture.call('/api/swarm/apps/publish', 'operator', 'POST', { spec, scope })).status).toBe(403);
    expect(fixture.loadApp).toHaveBeenCalledTimes(1);
  });

  it('allows operator clone activation and returns only isolated pending files', async () => {
    const response = await fixture.call('/api/swarm/apps/shared-workflow/clone', 'operator', 'POST', { name: 'operator-copy' });
    expect(response.status).toBe(201); const body = await response.json();
    expect(readFileSync(body.manifestPath, 'utf8')).toContain('shared-bot');
    expect(fixture.loadApp).toHaveBeenCalledWith(body.manifestPath, { scope: 'person', ownerSub: 'fixture-operator', tenantId: null });
    const pending = path.join(fixture.directory, 'pending.yaml');
    writeFileSync(pending, 'name: pending-workflow\ndisplayName: Pending workflow\n');
    fixture.files.mockReturnValue([pending]);
    const list = await fixture.call('/api/swarm/apps/pending', 'operator'); expect(list.status).toBe(200);
    expect((await list.json()).pending).toEqual([expect.objectContaining({ name: 'pending-workflow', path: pending })]);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await fixture.call('/api/swarm/apps/pending', 'operator')).status).toBe(403);
    expect((await fixture.call('/api/swarm/apps/shared-workflow/clone', 'operator', 'POST', {})).status).toBe(403);
    expect(fixture.loadApp).toHaveBeenCalledTimes(1); expect(fixture.files).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary application discovery', async () => {
    const list = await fixture.call('/api/swarm/apps'); expect(list.status).toBe(200);
    expect((await list.json()).apps).toEqual([fixture.source]);
    expect(fixture.listApps).toHaveBeenCalledWith(undefined, { ownerSub: 'fixture-member', isOperator: false });
  });
});
