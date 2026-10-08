/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Operations rendering/loading for native own usage, unprobed health and unchanged legacy telemetry.
 */
import { describe, expect, it, vi } from 'vitest';
import { OperationsView } from '../../src/pages/cockpit/js/views/OperationsView.js';
import {
  agentHealth, formatNativeCost, isNativeOperations, mergeNativeBots, projectNativeLedger,
} from '../../src/pages/cockpit/js/utils/operations-native.js';

const metrics = {
  success: true, source: 'native-tickets-and-ledger',
  data: {
    scope: 'caller', total: 3, inferenceCalls: 1, byStatus: { queued: 1, completed: 2 },
    agents: { registered: 2, online: null, health: 'not_checked' },
  },
};
const bots = [
  { name: 'Local Analyst', agentId: 'resolved-id', declaredAgentId: 'bot-source', online: null, healthStatus: 'not_probed', routable: true },
  { name: 'Other Declaration', agentId: null, declaredAgentId: 'other-id', online: null, healthStatus: 'not_probed', routable: false },
];
const summary = {
  total_micros: 0, total_usd: '$0.000000', tokens_in: 100, tokens_out: 50,
  total_tokens: 150, call_count: 1, estimated_count: 0,
};

function report() {
  return {
    user_id: 'own-caller', summary: { ...summary }, by_bot: { 'bot-source': { ...summary } },
    by_model: { 'local-model': { ...summary } }, by_api: {}, by_harness: {},
    events: [{
      actor: 'own-caller', bot: 'bot-source', model: 'local-model', api: 'private-gpu', harness: null,
      amount: 0, kind: 'metered', tokens_in: 100, tokens_out: 50, estimated: false,
      at: 1_791_460_800_000,
    }],
  };
}

function view(native = true) {
  const instance = Object.create(OperationsView.prototype);
  instance.data = {
    metrics: native ? metrics : { data: { total: 3, swarmHealth: { healthy: 1, offline: 1 } } },
    registry: { bots }, agents: { agents: [] }, qmActivity: {}, workItems: { items: [] }, runs: { runs: [] },
    nativeLedger: native ? projectNativeLedger(report()) : null,
  };
  return instance;
}

describe('Operations native caller ledger', () => {
  it('selects only the explicit native caller contract', () => {
    expect(isNativeOperations(metrics)).toBe(true);
    expect(isNativeOperations({ source: metrics.source, data: { scope: 'fleet' } })).toBe(false);
    expect(isNativeOperations({ data: metrics.data })).toBe(false);
    expect(isNativeOperations(null)).toBe(false);
  });

  it('keeps zero-price real calls visible, joins declared identity, and records observed metadata only', () => {
    const ledger = projectNativeLedger(report());
    expect(ledger.summary).toMatchObject({ micros: 0, calls: 1, tokens: 150 });
    expect(ledger.byModel[0]).toMatchObject({ id: 'local-model', micros: 0, calls: 1, providers: ['private-gpu'] });
    const merged = mergeNativeBots(bots, ledger);
    expect(merged[0]).toMatchObject({ totalRequests: 1, totalInputTokens: 100, totalOutputTokens: 50, apiType: 'private-gpu', harnessType: null, online: null });
    expect(merged[1].nativeUsage).toBeNull();
    expect(ledger.recent[0].at).toBe(1_791_460_800_000);
    expect(formatNativeCost(0)).toBe('$0.000000');
    expect(formatNativeCost(1)).toBe('$0.000001');
    expect(formatNativeCost(-42)).toBe('-$0.000042');
    expect(formatNativeCost(undefined)).toBe('Unavailable');
  });

  it('keeps reported spend distinct from metered spend and refuses incomplete kind totals', () => {
    const mixed = report();
    mixed.summary = { ...summary, total_micros: 250_000, call_count: 2, total_tokens: 170, tokens_in: 110, tokens_out: 60 };
    mixed.by_bot['bot-source'] = { ...mixed.summary };
    mixed.by_model['local-model'] = { ...mixed.summary };
    mixed.events.push({ ...mixed.events[0], amount: 250_000, kind: 'reported', tokens_in: 10, tokens_out: 10, at: mixed.events[0].at + 1 });
    expect(projectNativeLedger(mixed).kinds).toEqual({ metered: 0, reported: 250_000 });
    const instance = view();
    instance.data.nativeLedger = projectNativeLedger(mixed);
    expect(instance._renderCost()).toContain('$0.250000');
    expect(instance._renderCost()).toContain('$0.000000');
    mixed.events.pop();
    expect(projectNativeLedger(mixed).kinds).toBeNull();
  });

  it('does not turn routability, usage or null health into online/offline observations', () => {
    expect(agentHealth(bots[0])).toBe('unknown');
    expect(agentHealth({ online: true })).toBe('online');
    expect(agentHealth({ online: false })).toBe('offline');
    expect(agentHealth({ online: true, dbStatus: 'inactive' })).toBe('disabled');
    const instance = view();
    const agents = instance._renderAgents();
    const overview = instance._renderOverview();
    expect(agents).toContain('ops-agent-card unknown');
    expect(agents).not.toContain('ops-agent-card offline');
    expect(agents).not.toContain('ops-agent-card online');
    expect(agents).toContain('Not recorded');
    expect(agents).not.toContain('openai-codex');
    expect(overview).toContain('Health not probed · 2 unknown');
    expect(overview).not.toContain('0%');
    expect(overview).toContain('Your Tickets by Status');
    expect(overview).toContain('queued');
    expect(overview).not.toContain('Backlog');
  });

  it('renders actual own model/bot usage, valid zero and millisecond UTC timestamps without legacy cost fallback', () => {
    const instance = view();
    instance.data.qmActivity = { modelUsage: { foreign: { modelId: 'foreign-model', totalCost: 999 } } };
    instance.data.agents = { agents: [{ totalCost: 999, totalRequests: 999 }] };
    const html = instance._renderCost();
    expect(html).toContain('Your Usage Ledger');
    expect(html).toContain('Your Usage by Model');
    expect(html).toContain('Local Analyst');
    expect(html).toContain('private-gpu · 1 calls · 150 tokens');
    expect(html).toContain('$0.000000');
    expect(html).toContain(new Date(1_791_460_800_000).toISOString().replace('T', ' ').replace('Z', ' UTC'));
    expect(html).toContain('Metered Cost');
    expect(html).toContain('Reported Cost');
    expect(html).not.toContain('foreign-model');
    expect(html).not.toContain('$999');
    expect(html).not.toContain('Spend by Hour');
  });

  it('shows an unavailable ledger instead of empty usage or fabricated zero on a failed/malformed read', () => {
    expect(projectNativeLedger(null)).toBeNull();
    expect(projectNativeLedger({ summary })).toBeNull();
    expect(projectNativeLedger({ fleet_summary: summary, by_bot: {}, by_model: {}, events: [] })).toBeNull();
    expect(projectNativeLedger({ ...report(), summary: { ...summary, total_micros: '0' } })).toBeNull();
    const instance = view();
    instance.data.nativeLedger = null;
    expect(instance._renderCost()).toContain('Your usage ledger is unavailable');
    expect(instance._renderCost()).not.toContain('$0.000000');
    expect(instance._renderOverview()).toContain('Unavailable');
    expect(instance._renderAgents()).toContain('Unavailable');
  });

  it('retains a failed native own-ledger read as unavailable during actual view loading', async () => {
    const instance = view();
    instance._renderBody = vi.fn();
    instance.api = { getSafe: vi.fn(async (endpoint, fallback) => (
      endpoint === '/api/v1/metrics/summary' ? metrics : fallback
    )) };
    await instance._loadAndRender();
    expect(instance.api.getSafe).toHaveBeenCalledWith('/api/costs', null);
    expect(instance.data.nativeLedger).toBeNull();
    expect(instance._renderCost()).toContain('Your usage ledger is unavailable');
    expect(instance._renderCost()).not.toContain('$0.000000');
  });

  it('loads only the own ledger after native admission and retains the legacy loading/rendering path', async () => {
    for (const native of [true, false]) {
      const instance = view(native);
      instance._renderBody = vi.fn();
      instance.api = { getSafe: vi.fn(async (endpoint, fallback) => {
        if (endpoint === '/api/v1/metrics/summary') return instance.data.metrics;
        if (endpoint === '/api/swarm/bots/registry') return { bots };
        if (endpoint === '/api/costs') return report();
        return fallback;
      }) };
      await instance._loadAndRender();
      const endpoints = instance.api.getSafe.mock.calls.map(([endpoint]) => endpoint);
      expect(endpoints.includes('/api/costs')).toBe(native);
      expect(endpoints).not.toContain('/api/costs/admin');
      expect(endpoints).not.toContain('/api/admin/costs');
      for (const endpoint of ['/api/qm/activity', '/api/v1/metrics/agents', '/api/v1/metrics/queue-health?scope=all']) {
        expect(endpoints.includes(endpoint)).toBe(!native);
      }
      expect(instance._renderBody).toHaveBeenCalledOnce();
      if (!native) {
        instance.data.registry = { bots: [{ name: 'Observed Legacy', online: false, telemetry: { totalCost: 2, totalRequests: 4 } }] };
        expect(instance._renderAgents()).toContain('ops-agent-card offline');
        expect(instance._renderAgents()).toContain('$2.00');
        expect(instance._renderOverview()).toContain('Pipeline Flow');
      }
    }
  });

  it('escapes ledger and bot display values without exposing raw actor identifiers', () => {
    const instance = view();
    instance.data.registry.bots = [{ ...bots[0], name: '<script>bot</script>' }];
    instance.data.nativeLedger.byModel[0].id = '<img src=x>';
    const html = instance._renderAgents() + instance._renderCost();
    expect(html).toContain('&lt;script&gt;bot&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<script>bot</script>');
    expect(html).not.toContain('own-caller');
  });
});
