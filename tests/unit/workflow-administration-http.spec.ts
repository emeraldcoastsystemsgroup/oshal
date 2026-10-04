/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify operator-only workflow administration over real HTTP and preserve caller-scoped run history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { workflowAdministrationFixture } from '../fixtures/workflow-administration';
import type { WorkflowDefinition } from '@/features/workflow-studio';

const id = '11111111-2222-4333-8444-555555555555';
const administrative = [['GET', '/definitions'], ['POST', '/definitions'], ['GET', `/definitions/${id}`],
  ['PUT', `/definitions/${id}`], ['GET', `/definitions/${id}/versions`], ['GET', `/definitions/${id}/versions/1`],
  ['POST', `/definitions/${id}/validate`], ['POST', `/definitions/${id}/compile`],
  ['POST', `/definitions/${id}/duplicate`], ['POST', `/definitions/${id}/versions/1/fork`],
  ['POST', '/templates/fixture/create'], ['POST', '/chat']];
let fixture: Awaited<ReturnType<typeof workflowAdministrationFixture>>;
beforeEach(async () => { fixture = await workflowAdministrationFixture(); });
afterEach(async () => { await fixture.close(); });

describe('shared workflow administration', () => {
  it.each(administrative)('refuses %s %s before definitions, persistence or bot execution', async (method, route) => {
    for (const user of ['unknown', 'member']) {
      const response = await fixture.call(`/api/workflow-studio${route}?scope=all&ownerSub=fixture-operator`, user, method,
        method === 'GET' ? undefined : { isOperator: true, description: 'edit shared workflow', id });
      expect(response.status).toBe(user === 'unknown' ? 401 : 403);
    }
    for (const service of fixture.studio) expect(service).not.toHaveBeenCalled();
    expect(fixture.bot).not.toHaveBeenCalled();
    expect(existsSync(path.join(fixture.directory, 'output'))).toBe(false);
  });

  it('supports actual operator definitions, versions, validation, compilation, duplicate and fork', async () => {
    const created = await fixture.call('/api/workflow-studio/definitions', 'operator', 'POST', { name: 'Shared workflow' });
    expect(created.status).toBe(201);
    const { definition } = await created.json() as { definition: WorkflowDefinition };
    for (const route of ['', '/versions', '/versions/1', '/validate', '/compile']) {
      const method = route === '/validate' || route === '/compile' ? 'POST' : 'GET';
      const response = await fixture.call(`/api/workflow-studio/definitions/${definition.id}${route}`, 'operator', method, method === 'POST' ? {} : undefined);
      expect(response.status).toBe(200); expect((await response.json()).success).toBe(true);
    }
    const saved = await fixture.call(`/api/workflow-studio/definitions/${definition.id}`, 'operator', 'PUT', { ...definition, name: 'Updated workflow' });
    expect(saved.status).toBe(200); expect((await saved.json()).definition.version).toBe(2);
    for (const route of ['/duplicate', '/versions/1/fork']) {
      const response = await fixture.call(`/api/workflow-studio/definitions/${definition.id}${route}`, 'operator', 'POST', { name: 'Copied workflow' });
      expect(response.status).toBe(201); expect((await response.json()).definition.id).not.toBe(definition.id);
    }
    const list = await fixture.call('/api/workflow-studio/definitions', 'operator');
    expect((await list.json()).definitions.some((entry: { id: string }) => entry.id === definition.id)).toBe(true);
  });

  it('preserves template metadata for members and allows operator template creation and talk-to-build', async () => {
    const templates = await fixture.call('/api/workflow-studio/templates'); expect(templates.status).toBe(200);
    const { templates: entries } = await templates.json();
    expect((await fixture.call('/api/workflow-studio/catalog')).status).toBe(200);
    const created = await fixture.call(`/api/workflow-studio/templates/${entries[0].id}/create`, 'operator', 'POST', { name: 'Template workflow' });
    expect(created.status).toBe(201); const { definition } = await created.json();
    fixture.bot.mockResolvedValueOnce({ response: '```workflow-graph\n' + JSON.stringify(definition) + '\n```' } as Awaited<ReturnType<typeof fixture.bot>>);
    const response = await fixture.call('/api/workflow-studio/chat', 'operator', 'POST', { definitionId: definition.id, description: 'Refine the workflow' });
    expect(response.status).toBe(200); expect((await response.json()).definition.version).toBe(2);
    expect(fixture.bot).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(String), expect.objectContaining({ userSub: 'fixture-operator' }));
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await fixture.call('/api/workflow-studio/chat', 'operator', 'POST', {})).status).toBe(403);
    expect(fixture.bot).toHaveBeenCalledTimes(1);
  });

  it('keeps the separately mounted run reads caller-scoped and refuses foreign results', async () => {
    const list = await fixture.call('/api/workflow-studio/runs?scope=all&ownerSub=foreign-member');
    expect(list.status).toBe(200);
    expect(fixture.listRuns).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'fixture-member', includeUnowned: false }));
    const detail = await fixture.call(`/api/workflow-studio/runs/${id}`);
    expect(detail.status).toBe(404); expect(await detail.text()).not.toContain('FOREIGN RESULT');
  });
});
