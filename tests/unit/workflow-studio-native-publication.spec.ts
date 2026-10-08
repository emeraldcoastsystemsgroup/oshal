/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual shipped native publication/run methods over an explicit browser-only mocked contract, including lost acknowledgement without replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowStudioDataMethods as methods } from '../../src/pages/workflow-studio/workflow-studio-data.js';
import { workflowTicketTypeSlug } from '../../src/pages/workflow-studio/workflow-studio-utils.js';

function definition() {
  return { id:'a0000000-0000-0000-0000-000000000079', version:7, name:'Owned synthetic browser workflow',
    publication:{ package:'authored-owned-draft-v7', ticketType:'authored-owned-draft-v7', runtimeRegistered:true } };
}
function view(native = true) {
  const page = { state:{ nativeStudio:native, selectedDefinition:definition(), pendingNativeRun:null as any },
    requireDefinition:() => page.state.selectedDefinition, reloadDefinitions:vi.fn().mockResolvedValue(undefined),
    render:vi.fn(), setStatus:vi.fn(), saveActiveDefinition:vi.fn().mockResolvedValue(definition()),
    buildPublishSpecFromDefinition:vi.fn().mockReturnValue({ name:'legacy-fixture', mode:'single-shot', workerBot:'declared-bot' }) };
  return page;
}
function input() {
  return { executor:'native-broker-v1', prompt:'Owned browser-only input',
    limits:{ wall_ms:60000, output_tokens:64, artifact_bytes:1024 } };
}
function responses(values: Array<[number, unknown]>) {
  const fetch = vi.fn(async (_url:string, _options:{ body:string }) => {
    const next = values.shift();
    if (!next) throw new Error('No repeated mutation response exists');
    return new Response(JSON.stringify(next[1]), { status:next[0], headers:{'content-type':'application/json'} });
  });
  vi.stubGlobal('fetch',fetch);
  return fetch;
}

beforeEach(() => {
  vi.spyOn(console,'error').mockImplementation(() => {});
  vi.stubGlobal('document',{ getElementById:() => ({ checked:false }) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual Studio owned publication/run browser-only contract', () => {
  it('publishes only selected saved version and acknowledges server-owned package state', async () => {
    const page = view(); const acknowledged = { ...definition(), version:7 };
    const fetch = responses([[200,{ success:true, publication:acknowledged.publication, definition:acknowledged }]]);
    await methods.publishNativeDefinition.call(page,page.state.selectedDefinition);
    expect(fetch.mock.calls[0][0]).toBe(`/api/workflow-studio/definitions/${acknowledged.id}/publish`);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({expectedVersion:7});
    expect(page.state.selectedDefinition).toEqual(acknowledged);
    expect(page.setStatus.mock.calls.some(([,tone]) => tone === 'success')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates a normal owned ticket and dispatches exact explicit input with the published version', async () => {
    const page = view(); const ticketId = 'a0000000-0000-0000-0000-000000000081';
    const fetch = responses([[200,{ticket:{id:ticketId}}],[200,{status:'queued',ticketId,envelope:{id:'real-envelope'}}]]);
    const result = await methods.startNativeWorkflow.call(page,input());
    expect(fetch.mock.calls[0][0]).toBe('/tickets');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({kind:definition().publication.ticketType});
    expect(fetch.mock.calls[1][0]).toBe(`/api/workflow-studio/definitions/${definition().id}/run`);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({...input(),ticketId,expectedVersion:7});
    expect(result.status).toBe('queued'); expect(page.state.pendingNativeRun).toBeNull();
    expect(page.setStatus.mock.calls.every(([message]) => !message.includes('completed'))).toBe(true);
  });

  it('retains known ticket after rejected or uncertain dispatch and prevents another mutation', async () => {
    const page = view(); const ticketId = 'a0000000-0000-0000-0000-000000000081';
    const fetch = responses([[200,{ticket:{id:ticketId}}],[503,{refused:'store_unavailable',detail:'Owned failure'}]]);
    await expect(methods.startNativeWorkflow.call(page,input())).rejects.toThrow();
    expect(page.state.pendingNativeRun.ticketId).toBe(ticketId);
    await expect(methods.startNativeWorkflow.call(page,input())).rejects.toThrow('ticket inspection');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(page.setStatus.mock.calls.every(([,tone]) => tone !== 'success')).toBe(true);
  });

  it('does not replay uncertain normal ticket creation', async () => {
    const page = view(); const fetch = vi.fn().mockRejectedValue(new TypeError('Owned network loss'));
    vi.stubGlobal('fetch',fetch);
    await expect(methods.startNativeWorkflow.call(page,input())).rejects.toThrow();
    expect(page.state.pendingNativeRun.ticketId).toBeNull();
    await expect(methods.startNativeWorkflow.call(page,input())).rejects.toThrow('ticket inspection');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains acknowledged draft state when publication conflicts', async () => {
    const page = view(); const prior = page.state.selectedDefinition;
    const fetch = responses([[409,{refused:'generation_mismatch',detail:'Owned stale source'}]]);
    await methods.publishNativeDefinition.call(page,prior);
    expect(page.state.selectedDefinition).toBe(prior);
    expect(page.render).not.toHaveBeenCalled(); expect(page.reloadDefinitions).not.toHaveBeenCalled();
    expect(page.setStatus.mock.calls.every(([,tone]) => tone !== 'success')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the legacy publication request and uses exact acknowledged native runtime identity', async () => {
    const page = view(false); const fetch = responses([[200,{app:{displayName:'Owned legacy fixture'}}]]);
    await methods.publishActiveDefinition.call(page);
    expect(fetch.mock.calls[0][0]).toBe('/api/swarm/apps/publish');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({spec:page.buildPublishSpecFromDefinition.mock.results[0].value,scope:'person'});
    expect(workflowTicketTypeSlug(definition())).toBe(definition().publication.ticketType);
    expect(workflowTicketTypeSlug({name:'Legacy name'})).toBe('legacy-name');
  });
});
