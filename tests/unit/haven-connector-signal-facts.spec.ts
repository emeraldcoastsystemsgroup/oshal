/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: connector-signal facts are caller-scoped (the read is WHERE user_sub = $1 with exactly the caller's sub as the only parameter, and it never selects token columns), carry no raw scope string or account identifier into a prompt-injected fact, count expiry down honestly, and retire the keys a disconnected provider no longer justifies.
 */

import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_FACT_KEY_PREFIX,
  connectorAttentionMessages,
  connectorCapabilityLabels,
  connectorSignalCandidates,
  connectorSignalFactKeys,
  daysUntilExpiry,
  isStorableFact,
  readConnectorSignalRows,
  type ConnectorSignalRow,
} from '@/features/user-model';

const NOW = new Date('2026-08-02T12:00:00.000Z');

/** Records every query the code under test issues, so the guard asserts CALLS, not substrings. */
function recordingPool(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return { rows };
    },
  };
}

function row(over: Partial<ConnectorSignalRow> & { provider: string }): Record<string, unknown> {
  return {
    provider: over.provider,
    status: over.status ?? 'connected',
    scopes: over.scopes ?? null,
    expiry: over.expiry ?? null,
  };
}

describe('connector-facts-are-caller-scoped', () => {
  it('reads ONLY the caller sub: the SQL filters on user_sub and the sub is the sole parameter', async () => {
    const pool = recordingPool([row({ provider: 'google' })]);
    await readConnectorSignalRows(pool, 'auth0|owner-1');

    expect(pool.calls).toHaveLength(1);
    const [call] = pool.calls;
    // The isolation boundary, asserted structurally: a parameterized owner filter, and the caller's
    // sub is the ONLY bound value — no second sub, no tenant, no unfiltered branch.
    expect(call.params).toEqual(['auth0|owner-1']);
    const normalized = call.text.replace(/\s+/g, ' ');
    expect(normalized).toContain('WHERE user_sub = $1');
    // A literal sub interpolated into the SQL would defeat the parameterization.
    expect(normalized).not.toContain('auth0|owner-1');
    // Removing the filter (or widening it with an OR / a "1=1") must not pass this guard.
    expect(normalized).not.toMatch(/\bOR\b/i);
    expect(normalized).not.toMatch(/1\s*=\s*1/);
  });

  it('never selects credential columns — a signal fact cannot carry a token', async () => {
    const pool = recordingPool([]);
    await readConnectorSignalRows(pool, 'auth0|owner-1');
    const sql = pool.calls[0].text.toLowerCase();
    expect(sql).not.toContain('access_token');
    expect(sql).not.toContain('refresh_token');
  });

  it('an empty sub reads nothing at all (no query is issued)', async () => {
    const pool = recordingPool([row({ provider: 'google' })]);
    expect(await readConnectorSignalRows(pool, '')).toEqual([]);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('connector-signal fact derivation', () => {
  it('maps scopes to bounded capability labels and drops anything unrecognised', () => {
    expect(connectorCapabilityLabels('https://www.googleapis.com/auth/gmail.send openid'))
      .toEqual(['send email']);
    // An unknown/opaque scope contributes NOTHING — that is what keeps provider text out of prompts.
    expect(connectorCapabilityLabels('x-vendor-opaque-blob-9f3a')).toEqual([]);
    expect(connectorCapabilityLabels(null)).toEqual([]);
  });

  it('a derived fact carries no raw scope string and no account identifier', () => {
    const rawScope = 'https://www.googleapis.com/auth/gmail.send';
    const [fact] = connectorSignalCandidates(
      [{ provider: 'google', status: 'connected', scopes: rawScope, expiry: null }],
      NOW,
    );
    expect(fact.facet).toBe('signal');
    expect(fact.source).toBe('signal');
    expect(fact.factKey).toBe(`${CONNECTOR_FACT_KEY_PREFIX}google`);
    expect(fact.factValue).toContain('send email');
    expect(fact.factValue).not.toContain(rawScope);
    expect(fact.factValue).not.toContain('googleapis.com');
    // And it must survive the model's own fail-closed storability filter.
    expect(isStorableFact(fact)).toBe(true);
  });

  it('counts an expiry down only inside the warning window, and says so when it has passed', () => {
    const inFourDays = new Date(NOW.getTime() + 4 * 86_400_000).toISOString();
    const inSixtyDays = new Date(NOW.getTime() + 60 * 86_400_000).toISOString();
    const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString();

    expect(daysUntilExpiry(inFourDays, NOW)).toBe(4);
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry('not-a-date', NOW)).toBeNull();

    const soon = connectorSignalCandidates([{ provider: 'google', status: 'connected', scopes: null, expiry: inFourDays }], NOW);
    expect(soon[0].factValue).toContain('expires in 4 days');

    const far = connectorSignalCandidates([{ provider: 'google', status: 'connected', scopes: null, expiry: inSixtyDays }], NOW);
    expect(far[0].factValue).not.toContain('expires');

    const gone = connectorSignalCandidates([{ provider: 'google', status: 'connected', scopes: null, expiry: yesterday }], NOW);
    expect(gone[0].factValue).toContain('access expired');
  });

  it('folds several accounts of one provider into ONE fact, worst health and soonest expiry winning', () => {
    const facts = connectorSignalCandidates([
      { provider: 'google', status: 'connected', scopes: 'gmail.send', expiry: new Date(NOW.getTime() + 20 * 86_400_000).toISOString() },
      { provider: 'google', status: 'connected', scopes: 'calendar', expiry: new Date(NOW.getTime() + 2 * 86_400_000).toISOString() },
      { provider: 'google', status: 'revoked', scopes: null, expiry: null },
    ], NOW);
    expect(facts).toHaveLength(1);
    expect(facts[0].factValue).toContain('one account needs reconnecting');
    expect(facts[0].factValue).toContain('expires in 2 days');
    expect(facts[0].factValue).toContain('send email');
    expect(facts[0].factValue).toContain('calendar');
  });

  it('reports the live fact keys so a disconnected provider stops being claimed', () => {
    expect(connectorSignalFactKeys([
      { provider: 'slack', status: 'connected', scopes: null, expiry: null },
      { provider: 'google', status: 'connected', scopes: null, expiry: null },
      { provider: 'google', status: 'error', scopes: null, expiry: null },
    ])).toEqual(['connector-google', 'connector-slack']);
    expect(connectorSignalFactKeys([])).toEqual([]);
  });

  it('raises attention messages for broken and expiring connections, and stays quiet otherwise', () => {
    const healthy = connectorAttentionMessages(
      [{ provider: 'google', status: 'connected', scopes: null, expiry: new Date(NOW.getTime() + 90 * 86_400_000).toISOString() }],
      NOW,
    );
    expect(healthy).toEqual([]);

    const attention = connectorAttentionMessages([
      { provider: 'slack', status: 'revoked', scopes: null, expiry: null },
      { provider: 'google', status: 'connected', scopes: null, expiry: new Date(NOW.getTime() + 86_400_000).toISOString() },
    ], NOW);
    expect(attention).toHaveLength(2);
    expect(attention.join(' ')).toContain('google');
    expect(attention.join(' ')).toContain('slack');
    expect(attention.some((m) => m.includes('expires in 1 day'))).toBe(true);
  });
});
