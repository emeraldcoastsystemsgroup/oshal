/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the data-lifecycle slice: registry aggregation (honest per-store failure flagging, counts, section presence), the delete pass (deletable vs export-only skip vs failure isolation), the signed delete-token round-trip (sub binding, expiry, tamper resistance, fail-closed on no secret), and the operator-sub deletion refusal (OSHAL_OPERATOR_SUBS/EMAILS).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review-fix coverage: (1) multibyte-sig token no longer throws through timingSafeEqual (byte-length guard); (2) information_schema discovery — covered-table exclusion, retained-table export-only notes, secret-column redaction (string values only), children-first FK ordering, ownership-column priority; (3) knownGaps carried in the export manifest.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Registry-membership guard for the engine exporters: buildAllExporters must carry chromadb_collections + arangodb_person_graph (the 07-19 partial-land shipped the imports and removed the gap disclosure without appending the builders), the pg/vault/career-hunter stores must never regress, and store names stay unique.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | BEHAVIORAL guards for the two engine exporters (membership alone never proved they work): the Chroma exporter selects ONLY the caller's owner_sub docs across every collection (never another user's, and a blank sub refuses rather than widening scope) and returns an empty section — not a throw — when the engine's heartbeat fails or the transport errors; the Arango person-graph exporter returns the caller's nodes+edges (getPersonGraph/personGraphExists reached with exactly the caller's sub, never another user's) and returns empty — not a throw — when no engine is configured (connector null) or the caller never had a graph (existence checked WITHOUT provisioning), while a provisioned delete drops the DB and reports the record count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAllExporters,
  buildExportBundle,
  executeDeleteAll,
  isDeleteRefused,
  mintDeleteToken,
  verifyDeleteToken,
  discoverSubKeyedExporters,
  orderChildrenFirst,
  RETAINED_DISCOVERED_TABLES,
  buildChromaExporter,
  buildArangoPersonGraphExporter,
  type DataExporter,
  type PgLike,
  type PersonGraphConnectorLike,
} from '@/features/data-lifecycle';

const SUB = 'user-abc-123';
const SECRET = 'unit-test-signing-secret';

function fakeExporter(overrides: Partial<DataExporter> & { store: string }): DataExporter {
  return {
    describe: `fake store ${overrides.store}`,
    deletable: true,
    exportRows: async () => [{ a: 1 }],
    deleteRows: async () => 1,
    ...overrides,
  };
}

describe('buildExportBundle — registry aggregation', () => {
  it('aggregates every store with counts, in registry order', async () => {
    const exporters = [
      fakeExporter({ store: 'alpha', exportRows: async (sub) => [{ sub }, { sub }] }),
      fakeExporter({ store: 'beta', exportRows: async () => [] }),
    ];
    const bundle = await buildExportBundle(exporters, SUB);
    expect(bundle.manifest.userSub).toBe(SUB);
    expect(bundle.manifest.generatedAt).toBeTruthy();
    expect(bundle.manifest.stores.map((s) => s.store)).toEqual(['alpha', 'beta']);
    expect(bundle.manifest.counts).toEqual({ alpha: 2, beta: 0 });
    expect(bundle.stores.alpha).toEqual([{ sub: SUB }, { sub: SUB }]);
    expect(bundle.stores.beta).toEqual([]);
  });

  it('flags a failing store honestly instead of dropping it or failing the whole export', async () => {
    const exporters = [
      fakeExporter({ store: 'good' }),
      fakeExporter({ store: 'broken', exportRows: async () => { throw new Error('relation does not exist'); } }),
      fakeExporter({ store: 'also-good' }),
    ];
    const bundle = await buildExportBundle(exporters, SUB);
    const broken = bundle.manifest.stores.find((s) => s.store === 'broken');
    expect(broken?.ok).toBe(false);
    expect(broken?.error).toContain('relation does not exist');
    expect(bundle.stores.broken).toEqual([]); // section still present, honestly empty
    // The healthy stores are untouched by the failure.
    expect(bundle.manifest.stores.find((s) => s.store === 'good')?.ok).toBe(true);
    expect(bundle.manifest.stores.find((s) => s.store === 'also-good')?.ok).toBe(true);
  });

  it('carries the deletable flag + deleteNote into the manifest (the honesty contract)', async () => {
    const exporters = [
      fakeExporter({ store: 'audit-only', deletable: false, deleteRows: undefined, deleteNote: 'append-only audit retained' }),
    ];
    const bundle = await buildExportBundle(exporters, SUB);
    expect(bundle.manifest.stores[0].deletable).toBe(false);
    expect(bundle.manifest.stores[0].deleteNote).toBe('append-only audit retained');
  });

  it('declares knownGaps in the manifest (uncovered stores are disclosed, never implied covered)', async () => {
    const gaps = [{ store: 'chromadb_collections', holds: 'embeddings', status: 'not covered yet' }];
    const bundle = await buildExportBundle([fakeExporter({ store: 'alpha' })], SUB, gaps);
    expect(bundle.manifest.knownGaps).toEqual(gaps);
    // Default (no gaps passed) is an empty array, not undefined — the field is always present.
    const noGaps = await buildExportBundle([fakeExporter({ store: 'alpha' })], SUB);
    expect(noGaps.manifest.knownGaps).toEqual([]);
  });
});

describe('executeDeleteAll — the delete pass', () => {
  it('deletes deletable stores, skips export-only stores with the reason, and isolates failures', async () => {
    const seen: string[] = [];
    const exporters = [
      fakeExporter({ store: 'wipe-me', deleteRows: async (sub) => { seen.push(sub); return 7; } }),
      fakeExporter({ store: 'audit-only', deletable: false, deleteRows: undefined, deleteNote: 'retained by design' }),
      fakeExporter({ store: 'explodes', deleteRows: async () => { throw new Error('locked'); } }),
      fakeExporter({ store: 'still-runs', deleteRows: async () => 2 }),
    ];
    const outcomes = await executeDeleteAll(exporters, SUB);
    expect(seen).toEqual([SUB]);
    expect(outcomes).toEqual([
      { store: 'wipe-me', action: 'deleted', deleted: 7 },
      { store: 'audit-only', action: 'skipped', reason: 'retained by design' },
      { store: 'explodes', action: 'failed', error: 'locked' },
      { store: 'still-runs', action: 'deleted', deleted: 2 }, // one bad store never halts the pass
    ]);
  });
});

describe('delete token — mint/verify round trip', () => {
  it('round-trips for the same sub within the TTL', () => {
    const minted = mintDeleteToken(SUB, { secret: SECRET });
    expect(minted).not.toBeNull();
    const claims = verifyDeleteToken(minted!.token, SUB, { secret: SECRET });
    expect(claims?.sub).toBe(SUB);
    expect(claims?.purpose).toBe('account-data-delete');
  });

  it('rejects a token presented by a DIFFERENT sub (sub binding)', () => {
    const minted = mintDeleteToken(SUB, { secret: SECRET });
    expect(verifyDeleteToken(minted!.token, 'someone-else', { secret: SECRET })).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const minted = mintDeleteToken(SUB, { secret: SECRET, ttlMs: 60_000, nowMs: now });
    expect(verifyDeleteToken(minted!.token, SUB, { secret: SECRET, nowMs: now + 61_000 })).toBeNull();
    expect(verifyDeleteToken(minted!.token, SUB, { secret: SECRET, nowMs: now + 30_000 })).not.toBeNull();
  });

  it('rejects a tampered payload and a wrong-secret signature', () => {
    const minted = mintDeleteToken(SUB, { secret: SECRET });
    const [payload, sig] = minted!.token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'evil', purpose: 'account-data-delete', iat: 0, exp: 9999999999, nonce: 'x' })).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifyDeleteToken(`${tamperedPayload}.${sig}`, 'evil', { secret: SECRET })).toBeNull();
    expect(verifyDeleteToken(`${payload}.${sig}`, SUB, { secret: 'a-different-secret' })).toBeNull();
  });

  it('rejects (never throws on) a sig whose CHAR count matches but whose BYTE count differs', () => {
    // Review finding repro: 43 JS chars (== expected b64url HMAC length) but 44 UTF-8 bytes.
    // The old string-length guard passed this through to timingSafeEqual, which threw a
    // RangeError that escaped the route try/catch as a 500 instead of the detail-free 403.
    const minted = mintDeleteToken(SUB, { secret: SECRET });
    const payload = minted!.token.slice(0, minted!.token.lastIndexOf('.'));
    const craftedSig = 'a'.repeat(42) + 'é'; // 43 chars, 44 bytes
    expect(() => verifyDeleteToken(`${payload}.${craftedSig}`, SUB, { secret: SECRET })).not.toThrow();
    expect(verifyDeleteToken(`${payload}.${craftedSig}`, SUB, { secret: SECRET })).toBeNull();
  });

  it('fails CLOSED when no signing secret exists (mint returns null, verify rejects)', () => {
    const saved = { s: process.env.SESSION_SECRET, a: process.env.AUTH_SESSION_SECRET, k: process.env.KEYCLOAK_CLIENT_SECRET };
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.KEYCLOAK_CLIENT_SECRET;
    try {
      expect(mintDeleteToken(SUB)).toBeNull();
      const minted = mintDeleteToken(SUB, { secret: SECRET });
      expect(verifyDeleteToken(minted!.token, SUB)).toBeNull(); // no ambient secret to verify with
    } finally {
      if (saved.s !== undefined) process.env.SESSION_SECRET = saved.s;
      if (saved.a !== undefined) process.env.AUTH_SESSION_SECRET = saved.a;
      if (saved.k !== undefined) process.env.KEYCLOAK_CLIENT_SECRET = saved.k;
    }
  });
});

describe('isDeleteRefused — operator accounts can never self-delete', () => {
  const savedSubs = process.env.OSHAL_OPERATOR_SUBS;
  const savedEmails = process.env.OSHAL_OPERATOR_EMAILS;

  beforeEach(() => {
    process.env.OSHAL_OPERATOR_SUBS = 'op-sub-1, op-sub-2';
    process.env.OSHAL_OPERATOR_EMAILS = 'maintainer@emeraldcoastsystemsgroup.com';
  });

  afterEach(() => {
    if (savedSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = savedSubs;
    if (savedEmails === undefined) delete process.env.OSHAL_OPERATOR_EMAILS; else process.env.OSHAL_OPERATOR_EMAILS = savedEmails;
  });

  it('refuses an allowlisted operator sub with a clear reason', () => {
    const reason = isDeleteRefused('op-sub-1', null);
    expect(reason).toBeTruthy();
    expect(reason).toContain('operator');
  });

  it('refuses by operator email as well', () => {
    expect(isDeleteRefused('random-sub', 'maintainer@emeraldcoastsystemsgroup.com')).toBeTruthy();
  });

  it('allows a normal user', () => {
    expect(isDeleteRefused('regular-user-sub', 'user@example.com')).toBeNull();
  });

  it('an empty allowlist refuses nobody (fail-closed operator model: nobody is an operator)', () => {
    process.env.OSHAL_OPERATOR_SUBS = '';
    process.env.OSHAL_OPERATOR_EMAILS = '';
    expect(isDeleteRefused('op-sub-1', null)).toBeNull();
  });
});

describe('discovered exporters — information_schema-driven full coverage', () => {
  /** Fake PgLike that answers the catalog queries and records every per-table SQL issued. */
  function fakeCatalogPool(opts: {
    columns: Array<{ table_name: string; column_name: string }>;
    fks?: Array<{ child: string; parent: string }>;
    data?: Record<string, Array<Record<string, unknown>>>;
    deletedCounts?: Record<string, number>;
  }) {
    const issued: Array<{ text: string; params?: unknown[] }> = [];
    const pool: PgLike = {
      async query(text: string, params?: unknown[]) {
        issued.push({ text, params });
        if (text.includes('information_schema.columns')) return { rows: opts.columns };
        if (text.includes("constraint_type = 'FOREIGN KEY'")) return { rows: opts.fks ?? [] };
        const m = text.match(/^(SELECT \* FROM|DELETE FROM) "([a-z0-9_]+)"/);
        if (m && m[1] === 'SELECT * FROM') return { rows: opts.data?.[m[2]] ?? [] };
        if (m) return { rows: [], rowCount: opts.deletedCounts?.[m[2]] ?? 0 };
        throw new Error(`unexpected SQL in fake pool: ${text}`);
      },
    };
    return { pool, issued };
  }

  it('discovers every sub-keyed table, excludes explicitly-covered ones, and scopes by the ownership column', async () => {
    const { pool, issued } = fakeCatalogPool({
      columns: [
        { table_name: 'ambient_transcript_segments', column_name: 'user_sub' },
        { table_name: 'tickets', column_name: 'owner_sub' }, // explicitly covered — must be excluded
        { table_name: 'workspaces', column_name: 'owner_sub' },
      ],
      data: { ambient_transcript_segments: [{ user_sub: SUB, transcript_text: 'hello' }] },
    });
    const exporters = await discoverSubKeyedExporters(pool, new Set(['tickets']));
    expect(exporters.map((e) => e.store).sort()).toEqual(['ambient_transcript_segments', 'workspaces']);
    const ambient = exporters.find((e) => e.store === 'ambient_transcript_segments')!;
    expect(ambient.deletable).toBe(true);
    await ambient.exportRows(SUB);
    await ambient.deleteRows!(SUB);
    const perTable = issued.filter((q) => q.text.includes('"ambient_transcript_segments"'));
    expect(perTable[0].text).toBe('SELECT * FROM "ambient_transcript_segments" WHERE "user_sub"=$1');
    expect(perTable[0].params).toEqual([SUB]);
    expect(perTable[1].text).toBe('DELETE FROM "ambient_transcript_segments" WHERE "user_sub"=$1');
    // owner_sub-keyed table scopes by owner_sub.
    const ws = exporters.find((e) => e.store === 'workspaces')!;
    await ws.exportRows(SUB);
    expect(issued[issued.length - 1].text).toBe('SELECT * FROM "workspaces" WHERE "owner_sub"=$1');
  });

  it('keeps retained (append-only / security) tables EXPORT-ONLY with the retention reason', async () => {
    const { pool } = fakeCatalogPool({
      columns: [
        { table_name: 'access_audit_log', column_name: 'actor_sub' },
        { table_name: 'tv_token_revocations', column_name: 'user_sub' },
        { table_name: 'connector_action_audit', column_name: 'user_sub' },
        { table_name: 'data_lifecycle_audit', column_name: 'user_sub' },
      ],
    });
    const exporters = await discoverSubKeyedExporters(pool, new Set());
    for (const e of exporters) {
      expect(e.deletable).toBe(false);
      expect(e.deleteRows).toBeUndefined();
      expect(e.deleteNote).toBe(RETAINED_DISCOVERED_TABLES[e.store]);
    }
    const outcomes = await executeDeleteAll(exporters, SUB);
    expect(outcomes.every((o) => o.action === 'skipped')).toBe(true);
  });

  it('redacts secret-shaped STRING columns but leaves numeric token counters intact', async () => {
    const { pool } = fakeCatalogPool({
      columns: [{ table_name: 'channel_link_codes', column_name: 'user_sub' }],
      data: {
        channel_link_codes: [
          { user_sub: SUB, refresh_token: 'live-secret', api_key: 'k-123', wrapped_dek: 'AAAA==', prompt_tokens: 42, note: 'plain' },
        ],
      },
    });
    const exporters = await discoverSubKeyedExporters(pool, new Set());
    const rows = (await exporters[0].exportRows(SUB)) as Array<Record<string, unknown>>;
    expect(rows[0].refresh_token).toBe('[redacted: secret-shaped column]');
    expect(rows[0].api_key).toBe('[redacted: secret-shaped column]');
    expect(rows[0].wrapped_dek).toBe('[redacted: secret-shaped column]'); // oshal_user_deks shape
    expect(rows[0].prompt_tokens).toBe(42); // numeric usage counter, not a secret
    expect(rows[0].note).toBe('plain');
  });

  it('orders deletes children-before-parents from the FK graph (non-cascading FKs never wedge a parent)', async () => {
    const tables = [
      { table: 'eats_conversations', ownerColumn: 'user_sub' },
      { table: 'eats_messages', ownerColumn: 'user_sub' },
      { table: 'eats_profile', ownerColumn: 'user_sub' },
    ];
    const ordered = orderChildrenFirst(tables, [
      { child: 'eats_messages', parent: 'eats_conversations' },
      { child: 'unrelated_child', parent: 'unrelated_parent' }, // edges outside the set are ignored
    ]);
    const names = ordered.map((t) => t.table);
    expect(names.indexOf('eats_messages')).toBeLessThan(names.indexOf('eats_conversations'));
    expect(names).toHaveLength(3); // nothing dropped
  });

  it('an FK cycle still emits every table (name order) instead of dropping it from the inventory', () => {
    const tables = [
      { table: 'b_cycle', ownerColumn: 'user_sub' },
      { table: 'a_cycle', ownerColumn: 'user_sub' },
    ];
    const ordered = orderChildrenFirst(tables, [
      { child: 'a_cycle', parent: 'b_cycle' },
      { child: 'b_cycle', parent: 'a_cycle' },
    ]);
    expect(ordered.map((t) => t.table).sort()).toEqual(['a_cycle', 'b_cycle']);
  });

  it('prefers user_sub over owner_sub when a table carries both', async () => {
    const { pool, issued } = fakeCatalogPool({
      columns: [
        { table_name: 'dual_keyed', column_name: 'owner_sub' },
        { table_name: 'dual_keyed', column_name: 'user_sub' },
      ],
    });
    const exporters = await discoverSubKeyedExporters(pool, new Set());
    expect(exporters).toHaveLength(1);
    await exporters[0].exportRows(SUB);
    expect(issued.pop()!.text).toBe('SELECT * FROM "dual_keyed" WHERE "user_sub"=$1');
  });
});

describe('buildAllExporters registry membership', () => {
  // Regression guard for the 2026-07-19 partial-land: the Chroma + Arango person-graph
  // exporters were imported and their KNOWN_EXPORT_GAPS disclosure removed, but the
  // builders were never appended to the registry — /api/me export/delete silently
  // skipped both engines while claiming coverage. The registry must carry them.
  /** Minimal PgLike: empty catalog, so discovery contributes nothing and the
   *  static registry membership is what's under test. */
  const emptyCatalogPool: PgLike = { query: async () => ({ rows: [] }) };

  it('includes the chroma and arango person-graph engine exporters', async () => {
    const stores = (await buildAllExporters(emptyCatalogPool)).map((e) => e.store);
    expect(stores).toContain('chromadb_collections');
    expect(stores).toContain('arangodb_person_graph');
  });

  it('never regresses the pg/vault/career-hunter membership while adding engines', async () => {
    const stores = (await buildAllExporters(emptyCatalogPool)).map((e) => e.store);
    for (const required of ['oshal_connections', 'personal_data_vault', 'career_hunter']) {
      expect(stores, `missing required store ${required}`).toContain(required);
    }
    expect(new Set(stores).size).toBe(stores.length);
  });
});

// ===========================================================================
// Engine exporter BEHAVIOR — Chroma (vector / RAG memory)
// Membership alone (above) never proves the exporter selects the RIGHT rows or
// survives an absent engine; these pin the caller-scoping security boundary and
// the graceful-degradation contract with a faked Chroma REST endpoint.
// ===========================================================================

/** One doc in the fake Chroma store; owner_sub metadata is the ACL the exporter scopes on. */
interface FakeChromaDoc {
  id: string;
  document: string;
  metadata: Record<string, unknown> & { owner_sub: string };
}

/**
 * Fake Chroma REST endpoint. It models SERVER-SIDE owner_sub scoping: the /get + /delete handlers
 * filter the store by the `where.owner_sub` the exporter sends, so a cross-user leak could only
 * happen if the exporter asked for the wrong owner. Every /get body is recorded so the test can
 * assert exactly which owner was requested. `throwAll` simulates a dead transport; `heartbeatStatus`
 * simulates an engine whose heartbeat answers non-OK.
 */
function fakeChromaFetch(
  collections: Record<string, FakeChromaDoc[]>,
  opts: { throwAll?: boolean; heartbeatStatus?: number } = {},
) {
  const getBodies: Array<{ collection: string; whereOwner: unknown }> = [];
  const resp = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (opts.throwAll) throw new Error('ECONNREFUSED: chroma unreachable');
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/api/v1/heartbeat')) return resp(opts.heartbeatStatus ?? 200, { 'nanosecond heartbeat': 1 });
    if (url.endsWith('/api/v1/collections') && method === 'GET') {
      return resp(200, Object.keys(collections).map((name) => ({ id: `id-${name}`, name })));
    }
    const getMatch = url.match(/\/api\/v1\/collections\/id-(.+)\/get$/);
    if (getMatch && method === 'POST') {
      const name = getMatch[1];
      const body = JSON.parse(String(init?.body ?? '{}')) as { where?: { owner_sub?: unknown } };
      const whereOwner = body.where?.owner_sub;
      getBodies.push({ collection: name, whereOwner });
      const docs = (collections[name] ?? []).filter((d) => d.metadata.owner_sub === whereOwner);
      return resp(200, {
        ids: docs.map((d) => d.id),
        documents: docs.map((d) => d.document),
        metadatas: docs.map((d) => d.metadata),
      });
    }
    const delMatch = url.match(/\/api\/v1\/collections\/id-(.+)\/delete$/);
    if (delMatch && method === 'POST') {
      const name = delMatch[1];
      const body = JSON.parse(String(init?.body ?? '{}')) as { where?: { owner_sub?: unknown } };
      const owner = body.where?.owner_sub;
      const before = collections[name]?.length ?? 0;
      collections[name] = (collections[name] ?? []).filter((d) => d.metadata.owner_sub !== owner);
      const removed = before - collections[name].length;
      return resp(200, Array.from({ length: removed }, (_, i) => `deleted-${i}`));
    }
    throw new Error(`unexpected chroma call: ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, getBodies };
}

describe('chroma exporter — caller-scoped export + absent-engine degrades empty', () => {
  const OTHER = 'user-other-999';

  it("returns ONLY the caller's owner_sub docs across every collection, never another user's", async () => {
    const collections: Record<string, FakeChromaDoc[]> = {
      'private-rag': [
        { id: 'a', document: 'mine 1', metadata: { owner_sub: SUB, source: 'upload' } },
        { id: 'b', document: 'theirs', metadata: { owner_sub: OTHER, source: 'upload' } },
      ],
      'user-model': [{ id: 'c', document: 'mine 2', metadata: { owner_sub: SUB } }],
      'shared-corpus': [{ id: 'd', document: 'no owner', metadata: { owner_sub: '' } }],
    };
    const { fetchImpl, getBodies } = fakeChromaFetch(collections);
    const exporter = buildChromaExporter({ chromaUrl: 'http://chroma.test', fetchImpl });
    const rows = (await exporter.exportRows(SUB)) as Array<{ collection: string; id: string; metadata: { owner_sub: string } }>;
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(rows.every((r) => r.metadata.owner_sub === SUB)).toBe(true);
    // The where filter the exporter sent was the CALLER's sub on every collection scanned — never OTHER,
    // never an absent filter (which would have widened scope to unowned + everyone-else's docs).
    expect(getBodies).toHaveLength(3);
    expect(getBodies.every((b) => b.whereOwner === SUB)).toBe(true);
  });

  it('returns an empty section (never throws) when the engine heartbeat is down', async () => {
    const { fetchImpl } = fakeChromaFetch(
      { 'private-rag': [{ id: 'a', document: 'x', metadata: { owner_sub: SUB } }] },
      { heartbeatStatus: 503 },
    );
    const exporter = buildChromaExporter({ chromaUrl: 'http://chroma.test', fetchImpl });
    await expect(exporter.exportRows(SUB)).resolves.toEqual([]);
    await expect(exporter.deleteRows!(SUB)).resolves.toBe(0);
  });

  it('returns an empty section (never throws) when the transport itself errors', async () => {
    const { fetchImpl } = fakeChromaFetch({}, { throwAll: true });
    const exporter = buildChromaExporter({ chromaUrl: 'http://chroma.test', fetchImpl });
    await expect(exporter.exportRows(SUB)).resolves.toEqual([]);
  });

  it('refuses a blank sub rather than widening scope to unowned docs', async () => {
    const { fetchImpl } = fakeChromaFetch({});
    const exporter = buildChromaExporter({ chromaUrl: 'http://chroma.test', fetchImpl });
    await expect(exporter.exportRows('')).rejects.toThrow(/non-empty user sub/);
  });

  it("delete removes ONLY the caller's docs and reports the count", async () => {
    const collections: Record<string, FakeChromaDoc[]> = {
      'private-rag': [
        { id: 'a', document: 'mine', metadata: { owner_sub: SUB } },
        { id: 'b', document: 'theirs', metadata: { owner_sub: OTHER } },
      ],
    };
    const { fetchImpl } = fakeChromaFetch(collections);
    const exporter = buildChromaExporter({ chromaUrl: 'http://chroma.test', fetchImpl });
    await expect(exporter.deleteRows!(SUB)).resolves.toBe(1);
    expect(collections['private-rag'].map((d) => d.id)).toEqual(['b']); // the other user's doc survives
  });
});

// ===========================================================================
// Engine exporter BEHAVIOR — Arango (per-person graph, ADR-045)
// Scoping here is STRUCTURAL: the connector derives the isolated database name
// only from the caller's sub, so the guard proves the connector is only ever
// reached with the caller's sub, plus the absent-engine / never-provisioned
// degrade-to-empty contract.
// ===========================================================================

/**
 * A fake per-person graph store: sub -> its nodes+edges. Because the real connector derives the
 * database name only from the sub, scoping is structural — this fake only ever exposes the graph
 * for the sub it is asked about, and records every method's sub argument so the test can prove the
 * exporter never reaches for another user's graph. `getPersonGraph` is deliberately kept out of the
 * exists-check path so the "never provisioned" test can assert no DB was opened as a side effect.
 */
function fakePersonGraphConnector(graphs: Record<string, { nodes: unknown[]; edges: unknown[] }>) {
  const calls = { exists: [] as string[], get: [] as string[], drop: [] as string[] };
  const connector: PersonGraphConnectorLike = {
    async personGraphExists(sub: string): Promise<boolean> {
      calls.exists.push(sub);
      return Object.prototype.hasOwnProperty.call(graphs, sub);
    },
    async getPersonGraph(sub: string) {
      calls.get.push(sub);
      const g = graphs[sub] ?? { nodes: [], edges: [] };
      return {
        async rawQuery(query: string): Promise<unknown[]> {
          if (query.includes('FOR n IN')) return g.nodes;
          if (query.includes('FOR e IN')) return g.edges;
          if (query.startsWith('RETURN LENGTH')) return [g.nodes.length + g.edges.length];
          return [];
        },
      };
    },
    async dropPersonGraph(sub: string): Promise<boolean> {
      calls.drop.push(sub);
      delete graphs[sub];
      return true;
    },
  };
  return { connector, calls };
}

describe('arango person-graph exporter — caller-scoped export + absent-engine degrades empty', () => {
  const OTHER = 'user-other-999';

  it("returns the caller's nodes+edges and only ever touches the caller's graph", async () => {
    const { connector, calls } = fakePersonGraphConnector({
      [SUB]: {
        nodes: [{ id: 'n1', labels: ['Person'], props: { name: 'me' } }],
        edges: [{ from: 'a', to: 'b', type: 'KNOWS', props: {} }],
      },
      [OTHER]: { nodes: [{ id: 'nX', labels: ['Person'], props: { name: 'them' } }], edges: [] },
    });
    const exporter = buildArangoPersonGraphExporter(() => connector);
    const rows = (await exporter.exportRows(SUB)) as Array<{ kind: string; id?: string }>;
    expect(rows.map((r) => r.kind).sort()).toEqual(['edge', 'node']);
    expect(rows.find((r) => r.kind === 'node')).toMatchObject({ id: 'n1' });
    // Structural scoping: the exporter reached the connector with EXACTLY the caller's sub, never OTHER.
    expect(calls.exists).toEqual([SUB]);
    expect(calls.get).toEqual([SUB]);
  });

  it('returns an empty section (never throws) when no graph engine is configured (connector null)', async () => {
    const exporter = buildArangoPersonGraphExporter(() => null);
    await expect(exporter.exportRows(SUB)).resolves.toEqual([]);
    await expect(exporter.deleteRows!(SUB)).resolves.toBe(0);
  });

  it('returns empty WITHOUT provisioning a database when the caller never had a graph', async () => {
    const { connector, calls } = fakePersonGraphConnector({}); // no graph for anyone
    const exporter = buildArangoPersonGraphExporter(() => connector);
    await expect(exporter.exportRows(SUB)).resolves.toEqual([]);
    expect(calls.exists).toEqual([SUB]);
    expect(calls.get).toEqual([]); // existence checked WITHOUT opening/creating a database
  });

  it('refuses a blank sub rather than resolving an ambiguous graph', async () => {
    const { connector } = fakePersonGraphConnector({ [SUB]: { nodes: [], edges: [] } });
    const exporter = buildArangoPersonGraphExporter(() => connector);
    await expect(exporter.exportRows('')).rejects.toThrow(/non-empty user sub/);
  });

  it("delete drops the caller's database and reports the record count", async () => {
    const graphs: Record<string, { nodes: unknown[]; edges: unknown[] }> = {
      [SUB]: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ from: 'a', to: 'b' }] },
    };
    const { connector, calls } = fakePersonGraphConnector(graphs);
    const exporter = buildArangoPersonGraphExporter(() => connector);
    await expect(exporter.deleteRows!(SUB)).resolves.toBe(3); // 2 nodes + 1 edge
    expect(calls.drop).toEqual([SUB]);
    expect(graphs[SUB]).toBeUndefined();
  });
});
