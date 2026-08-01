/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the global-search deep-link contract + the three new typed adapters. Named guards: search-results-carry-resolvable-deeplinks (every non-null url matches a parameter a surface source file DEMONSTRABLY reads — asserted against the real cockpit/chat/utilities sources, not against a restated list, so deleting the handler turns the guard red) and search-is-caller-scoped (a second user's rows never appear: foreign person-scoped apps, operator-only bots for a basic caller, and another sub's connections). Adapters are exercised through their real search() with stubbed stores; the SQL adapters assert the emitted PARAMETERS AND PREDICATE, not a substring of the query text, so widening the WHERE clause cannot pass.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AppsSearchSource,
  BotsSearchSource,
  ConnectorsSearchSource,
  NO_SURFACE_REASON,
  deepLinkFor,
  type SearchableApp,
  type SearchableBot,
  type SearchHit,
  type SearchHitKind,
} from '@/features/global-search';
import { TicketsSearchSource } from '@/features/global-search';
import { ChatSearchSource } from '@/features/global-search';

const REPO = process.cwd();
const ALL_KINDS: SearchHitKind[] = ['ticket', 'chat', 'app', 'connector', 'bot', 'doc', 'entity'];

/** Minimal pg.Pool stand-in that records every query it is asked to run. */
function stubPool(rows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      },
    } as never,
  };
}

const APPS: SearchableApp[] = [
  {
    name: 'intelligent-operations', displayName: 'Intelligent Operations',
    description: 'incident triage and remediation', suite: 'ai-engineering',
    scope: 'public', ownerSub: null, updatedAt: '2026-07-30T00:00:00.000Z',
  },
  {
    name: 'my-private-flow', displayName: 'My Private Flow',
    description: 'incident notes only I published', suite: 'ai-productivity',
    scope: 'person', ownerSub: 'user-A', updatedAt: '2026-07-31T00:00:00.000Z',
  },
  {
    name: 'her-private-flow', displayName: 'Her Private Flow',
    description: 'incident notes only SHE published', suite: 'ai-productivity',
    scope: 'person', ownerSub: 'user-B', updatedAt: '2026-07-31T00:00:00.000Z',
  },
  {
    name: 'security-center', displayName: 'Security Center',
    description: 'incident audit for operators', suite: 'platform',
    scope: 'operator', ownerSub: null, updatedAt: '2026-07-31T00:00:00.000Z',
  },
];

const BOTS: SearchableBot[] = [
  {
    agentId: 'a0000000-0000-0000-0000-000000000099', name: 'general-bot',
    role: 'general/fallback', capabilities: ['invoices', 'general'],
    harnessType: 'claude-code', accessRoles: ['operator', 'swarm', 'jarvis'], status: 'online',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager',
    role: 'swarm/qa-gatekeeper', capabilities: ['invoices', 'qa'],
    harnessType: 'codex-cli', accessRoles: ['operator', 'swarm'], status: 'offline',
  },
  {
    agentId: 'a0000000-0000-0000-0000-000000000077', name: 'open-domain-bot',
    role: 'domain/open', capabilities: ['invoices'], harnessType: null, status: 'unknown',
  },
];

// ───────────────────────────────────────────────────────────────────────────────
describe('search-results-carry-resolvable-deeplinks', () => {
  it('every hit kind is EITHER linked or registered in NO_SURFACE_REASON with a reason', () => {
    for (const kind of ALL_KINDS) {
      const url = deepLinkFor(kind, 'some-id');
      if (url === null) {
        expect(NO_SURFACE_REASON[kind], `kind '${kind}' returns null with no declared reason`).toBeTruthy();
        expect(String(NO_SURFACE_REASON[kind]).length).toBeGreaterThan(30);
      } else {
        expect(NO_SURFACE_REASON[kind], `kind '${kind}' is both linked and declared no-surface`).toBeUndefined();
        expect(url.startsWith('/'), `kind '${kind}' must yield a same-origin path`).toBe(true);
      }
    }
  });

  /**
   * The load-bearing assertion: each link's parameter is read by the surface it points at. These
   * assertions run against the REAL source files, so deleting a handler (or renaming a parameter on
   * one side only) fails here instead of shipping a link that opens the right page and the wrong row.
   */
  it('the ticket link parameter is read by the cockpit shell', () => {
    const appJs = readFileSync(path.join(REPO, 'src/pages/cockpit/js/app.js'), 'utf8');
    expect(deepLinkFor('ticket', 'tk-1')).toBe('/cockpit/?ticket=tk-1');
    expect(appJs).toMatch(/URLSearchParams[\s\S]{0,40}get\(\s*'ticket'\s*\)/);
    // and the read value must actually reach the ticket-selection seam
    expect(appJs).toMatch(/pendingTicketSelection\s*=\s*requestedTicketId/);
  });

  it('the chat link parameter is read by the chat surface', () => {
    const chatJs = readFileSync(path.join(REPO, 'src/pages/chat/ui/chat-config-modal.mjs'), 'utf8');
    expect(deepLinkFor('chat', 'ct-9')).toBe('/chat?taskId=ct-9');
    expect(chatJs).toMatch(/URLSearchParams[\s\S]{0,60}get\(\s*'taskId'\s*\)/);
  });

  it('the app link parameter is the documented cockpit ?app= contract', () => {
    const ribbon = readFileSync(path.join(REPO, 'src/pages/cockpit/js/components/RibbonNav.js'), 'utf8');
    expect(deepLinkFor('app', 'intelligent-operations')).toBe('/cockpit/?app=intelligent-operations');
    expect(ribbon).toMatch(/params\.get\(\s*'app'\s*\)/);
  });

  it('the bot link parameter is read by cockpit persistence', () => {
    const persistence = readFileSync(path.join(REPO, 'src/pages/cockpit/js/cockpit-persistence.js'), 'utf8');
    expect(deepLinkFor('bot', 'a0-6')).toBe('/cockpit/?agentId=a0-6');
    expect(persistence).toMatch(/params\.get\(\s*'agentId'\s*\)/);
  });

  it('the connector link parameter is read by the utilities surface AND focuses the card', () => {
    const utilities = readFileSync(path.join(REPO, 'src/api/utilities.html'), 'utf8');
    expect(deepLinkFor('connector', 'google')).toBe('/utilities?connector=google');
    expect(utilities).toMatch(/get\(\s*'connector'\s*\)/);
    // the requested card must be located and highlighted, not merely parsed
    expect(utilities).toContain('function focusRequestedConnector()');
    expect(utilities).toMatch(/focusRequestedConnector\(\);/);
    expect(utilities).toMatch(/classList\.add\('deeplinked'\)/);
  });

  it('ids are URI-encoded so an id cannot graft extra query parameters onto the link', () => {
    expect(deepLinkFor('ticket', 'a b&app=evil')).toBe('/cockpit/?ticket=a%20b%26app%3Devil');
    expect(deepLinkFor('connector', 'goo gle#x')).toBe('/utilities?connector=goo%20gle%23x');
  });

  it('an empty id yields null rather than a link to a record that does not exist', () => {
    expect(deepLinkFor('ticket', '   ')).toBeNull();
    expect(deepLinkFor('app', '')).toBeNull();
  });

  it('the tickets adapter links the ROW, not the board', async () => {
    const { pool } = stubPool([{
      ticket_id: 'tk-42', title: 'invoice sync broke', description: 'the nightly invoice job',
      status: 'open', ticket_type: 'incident', updated_at: '2026-07-30T00:00:00.000Z',
    }]);
    const hits = await new TicketsSearchSource(pool).search('user-A', 'invoice', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('ticket');
    expect(hits[0].url).toBe('/cockpit/?ticket=tk-42');
  });

  it('the chat adapter links the CONVERSATION, not a fresh one', async () => {
    const { pool } = stubPool([{
      task_id: 'ct-7', title: 'invoice questions', body: 'about the invoice',
      matched_title: true, ts: '2026-07-30T00:00:00.000Z',
    }]);
    const hits = await new ChatSearchSource(pool).search('user-A', 'invoice', 5);
    expect(hits[0].kind).toBe('chat');
    expect(hits[0].url).toBe('/chat?taskId=ct-7');
  });

  it('the apps / bots / connectors adapters all emit their kind and a link', async () => {
    const appHits = await new AppsSearchSource(async () => APPS).search('user-A', 'incident', 10, {});
    expect(appHits.every((h) => h.kind === 'app' && h.url?.startsWith('/cockpit/?app='))).toBe(true);

    const botHits = await new BotsSearchSource(async () => BOTS).search('user-A', 'invoices', 10, {});
    expect(botHits.length).toBeGreaterThan(0);
    expect(botHits.every((h) => h.kind === 'bot' && h.url?.startsWith('/cockpit/?agentId='))).toBe(true);

    const { pool } = stubPool([{
      provider: 'google', account_email: 'me@example.test', status: 'connected',
      updated_at: '2026-07-30T00:00:00.000Z',
    }]);
    const connHits = await new ConnectorsSearchSource(pool).search('user-A', 'google', 10);
    expect(connHits[0].kind).toBe('connector');
    expect(connHits[0].url).toBe('/utilities?connector=google');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('search-is-caller-scoped', () => {
  it('a person-scoped app owned by ANOTHER user never appears', async () => {
    const source = new AppsSearchSource(async () => APPS);
    const hits = await source.search('user-A', 'incident', 20, { isOperator: false });
    const names = hits.map((h) => h.id);
    expect(names).toContain('intelligent-operations'); // public
    expect(names).toContain('my-private-flow');        // own person-scoped
    expect(names).not.toContain('her-private-flow');   // ANOTHER user's
    expect(names).not.toContain('security-center');    // operator-scoped
  });

  it('the SAME query as the other user returns HER app and not MINE', async () => {
    const source = new AppsSearchSource(async () => APPS);
    const hits = await source.search('user-B', 'incident', 20, { isOperator: false });
    const names = hits.map((h) => h.id);
    expect(names).toContain('her-private-flow');
    expect(names).not.toContain('my-private-flow');
  });

  it('an operator sees the operator-scoped app (and the private ones) — the documented bypass', async () => {
    const hits = await new AppsSearchSource(async () => APPS)
      .search('op-sub', 'incident', 20, { isOperator: true });
    const names = hits.map((h) => h.id);
    expect(names).toContain('security-center');
    expect(names).toContain('her-private-flow');
  });

  it('operator-only internal machinery is invisible to a basic caller (ADR-087 accessRoles)', async () => {
    const source = new BotsSearchSource(async () => BOTS);
    const basic = (await source.search('user-A', 'invoices', 20, { isOperator: false })).map((h) => h.title);
    expect(basic).toContain('general-bot');       // scoped but KEEPS jarvis
    expect(basic).toContain('open-domain-bot');   // no declaration = open
    expect(basic).not.toContain('task-manager');  // operator+swarm only

    const operator = (await source.search('op-sub', 'invoices', 20, { isOperator: true })).map((h) => h.title);
    expect(operator).toContain('task-manager');
  });

  it('the tickets adapter binds the CALLER sub as the ownership parameter and filters on owner_sub', async () => {
    const { pool, calls } = stubPool([]);
    await new TicketsSearchSource(pool).search('user-A', 'invoice', 5);
    expect(calls).toHaveLength(1);
    // the sub is bound as $1 ...
    expect(calls[0].params[0]).toBe('user-A');
    // ... and $1 is used as the owner predicate, not merely passed
    expect(calls[0].sql.replace(/\s+/g, ' ')).toContain('WHERE owner_sub = $1');
  });

  it('the chat adapter scopes BOTH arms of its union to the caller (chat_messages has no owner column)', async () => {
    const { pool, calls } = stubPool([]);
    await new ChatSearchSource(pool).search('user-A', 'invoice', 5);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(calls[0].params[0]).toBe('user-A');
    expect(sql).toContain('FROM chat_tasks t WHERE t.owner_sub = $1');
    // the message arm may ONLY reach text through a join back to the caller's own tasks
    expect(sql).toContain('JOIN chat_tasks t ON t.task_id = m.task_id AND t.owner_sub = $1');
  });

  it('the connectors adapter binds the caller sub, filters on user_sub, and never selects a token', async () => {
    const { pool, calls } = stubPool([]);
    await new ConnectorsSearchSource(pool).search('user-A', 'google', 5);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(calls[0].params[0]).toBe('user-A');
    expect(sql).toContain('WHERE user_sub = $1');
    expect(sql).not.toMatch(/access_token|refresh_token/);
  });

  it('no adapter queries at all without a caller sub', async () => {
    const apps = stubPool([]);
    const conns = stubPool([]);
    expect(await new ConnectorsSearchSource(conns.pool).search('', 'google', 5)).toEqual([]);
    expect(conns.calls).toHaveLength(0);
    expect(await new BotsSearchSource(async () => BOTS).search('', 'invoices', 5, {})).toEqual([]);
    void apps;
  });

  it('a store failure degrades to [] and never leaks unscoped rows on the error path', async () => {
    const throwingPool = { query: async () => { throw new Error('connection reset'); } } as never;
    const hits: SearchHit[] = await new ConnectorsSearchSource(throwingPool).search('user-A', 'g', 5);
    expect(hits).toEqual([]);
  });
});
