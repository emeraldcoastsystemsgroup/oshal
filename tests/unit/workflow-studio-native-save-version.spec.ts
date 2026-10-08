/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the actual Studio Save method's version-bound browser-only HTTP contract and preserve acknowledged state on a stale response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowStudioDataMethods } from '../../src/pages/workflow-studio/workflow-studio-data.js';

type Definition = ReturnType<typeof definition>;
type View = {
  state: { selectedDefinition: Definition };
  requireDefinition: () => Definition;
  reloadDefinitions: ReturnType<typeof vi.fn>;
  reloadVersionHistory: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
};

function definition(version = 1) {
  return {
    id: 'a0000000-0000-0000-0000-000000000079', version,
    name: 'Owned browser-only draft', description: 'Synthetic browser contract only',
    nodes: [], edges: [], metadata: { tags: ['owned-fixture'] },
  };
}

function view(selected: Definition): View {
  const result: View = {
    state: { selectedDefinition: selected }, requireDefinition: () => result.state.selectedDefinition,
    reloadDefinitions: vi.fn().mockResolvedValue(undefined),
    reloadVersionHistory: vi.fn().mockResolvedValue(undefined), render: vi.fn(), setStatus: vi.fn(),
  };
  return result;
}

function response(status: number, body: unknown) {
  const fetch = vi.fn(async (_url: string, _options: { body?: string }) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual Studio Save browser-only HTTP contract', () => {
  it('sends the selected version and replaces state only with the real acknowledged next definition', async () => {
    const prior = definition(7);
    const acknowledged = definition(8);
    const page = view(prior);
    const fetch = response(200, { success: true, definition: acknowledged });
    const saved = await workflowStudioDataMethods.saveActiveDefinition.call(page);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`/api/workflow-studio/definitions/${prior.id}`);
    expect(JSON.parse(fetch.mock.calls[0][1].body!)).toEqual({
      id: prior.id, expectedVersion: 7, name: prior.name, description: prior.description,
      nodes: prior.nodes, edges: prior.edges, metadata: prior.metadata,
    });
    expect(saved).toEqual(acknowledged);
    expect(page.state.selectedDefinition).toEqual(acknowledged);
    expect(page.reloadVersionHistory).toHaveBeenCalledWith(prior.id);
    expect(page.setStatus).toHaveBeenCalledWith(`Saved ${prior.name}.`, 'success');
  });

  it('keeps the prior selected version and reports the real stale-tab refusal without success or reload', async () => {
    const prior = definition(7);
    const page = view(prior);
    const fetch = response(409, { refused: 'generation_mismatch', detail: 'Owned fixture draft changed' });
    const saved = await workflowStudioDataMethods.saveActiveDefinition.call(page);
    expect(JSON.parse(fetch.mock.calls[0][1].body!).expectedVersion).toBe(7);
    expect(saved).toBeNull();
    expect(page.state.selectedDefinition).toBe(prior);
    expect(page.reloadDefinitions).not.toHaveBeenCalled();
    expect(page.reloadVersionHistory).not.toHaveBeenCalled();
    expect(page.render).not.toHaveBeenCalled();
    expect(page.setStatus).toHaveBeenCalledWith('Failed to save workflow: Request failed: 409', 'error');
    expect(page.setStatus.mock.calls.every(([, tone]) => tone !== 'success')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
