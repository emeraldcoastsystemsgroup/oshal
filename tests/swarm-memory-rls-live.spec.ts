/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: prove migration 117, the wrapped Pool, two-owner isolation, and operator approval/retrieval against real PostgreSQL.
 */

/**
 * SEC-05 swarm-memory live boundary proof.
 *
 * This test intentionally uses a real PostgreSQL Pool. A memory-only Pool double cannot prove
 * FORCE RLS, transaction-local broker state, startup-role posture, or identity GUC stamping. The
 * fixture applies migration 117 inside a unique disposable schema, grants a real NOSUPERUSER /
 * NOBYPASSRLS role only DML access, and drops the schema after the proof.
 */

import { expect, test } from '@playwright/test';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Pool } from 'pg';

import { createMemoryRoutes } from '@/app/extensions/swarm/routes/memory-routes';
import type { AgentMemoryService } from '@/features/agent-management';
import { SwarmMemoryService } from '@/features/agent-management';
import type { RagPermissionContext, RagSearchResult, RagService } from '@/features/rag';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';

const ADMIN_URL = process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';
const PROBE_URL = process.env.OSHAL_RLS_PROBE_DATABASE_URL
  ?? process.env.BOT_DATABASE_URL
  ?? '';
const PROBE_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';
const RUN = randomBytes(6).toString('hex');
const SCHEMA = `oshal_memory_rls_${RUN}`;
const OWNER_A = `Memory-Owner-A-${RUN}`;
const OWNER_B = `Memory-Owner-B-${RUN}`;
const OPERATOR = `Memory-Operator-${RUN}`;
const WORKSPACE_A = `memory-workspace-a-${RUN}`;
const WORKSPACE_B = `memory-workspace-b-${RUN}`;
const ITEM_A = `memory-item-a-${RUN}`;
const ITEM_B = `memory-item-b-${RUN}`;

const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_DB_GUC_STRICT', 'OSHAL_OPERATOR_SUBS'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

interface StoredRagDocument {
  text: string;
  metadata: Record<string, string>;
}

/** Minimal deterministic vector seam: PostgreSQL, not vector ranking, is the live boundary here. */
class LiveMemoryRag {
  private readonly documents = new Map<string, StoredRagDocument>();

  async ensureCollection(): Promise<void> {}

  async ingest(
    documents: string[],
    _collection: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    this.documents.set(metadata.work_item_id, { text: documents[0], metadata: { ...metadata } });
  }

  async search(
    _query: string,
    collection: string,
    limit: number,
    _context?: RagPermissionContext,
  ): Promise<RagSearchResult[]> {
    return [...this.documents.entries()].slice(0, limit).map(([id, value], index) => ({
      id,
      text: value.text,
      metadata: { ...value.metadata },
      score: 1 - (index / 100),
      collection,
    }));
  }

  document(workItemId: string): string {
    const found = this.documents.get(workItemId);
    if (!found) throw new Error(`Missing indexed memory ${workItemId}`);
    return found.text;
  }
}

let adminPool: Pool;
let probePool: Pool;
let wrappedPool: Pool;
let server: Server;
let baseUrl: string;
let rag: LiveMemoryRag;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) {
    throw new TypeError(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

async function adminLedgerQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.swarm_memory_ledger_broker', 'on', true)");
    const result = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function inspectWrappedIdentity(
  sub: string,
  isOperator: boolean,
): Promise<{ currentSub: string; operator: string }> {
  return runWithRequestIdentity({ sub, isOperator }, async () => {
    const client = await wrappedPool.connect();
    try {
      const result = await client.query<{ current_sub: string; is_operator: string }>(
        `SELECT current_setting('oshal.current_sub', true) AS current_sub,
                current_setting('oshal.is_operator', true) AS is_operator`,
      );
      return {
        currentSub: result.rows[0].current_sub,
        operator: result.rows[0].is_operator,
      };
    } finally {
      client.release();
    }
  });
}

async function request(
  path: string,
  subject: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'x-test-sub': subject,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

async function closeServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test.beforeAll(async () => {
  expect(
    ADMIN_URL,
    'DATABASE_URL (or OSHAL_RLS_ADMIN_DATABASE_URL) is required; SEC-05 needs a real PostgreSQL proof.',
  ).not.toBe('');
  quotedIdentifier(PROBE_ROLE);
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedEnv[key] = value;
  }
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;

  adminPool = new Pool({ connectionString: ADMIN_URL });
  const attributes = await adminPool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1', [PROBE_ROLE]);
  expect(attributes.rows, `${PROBE_ROLE} must exist before the live proof`).toHaveLength(1);
  expect(attributes.rows[0].rolsuper, 'the live proof role must be NOSUPERUSER').toBe(false);
  expect(attributes.rows[0].rolbypassrls, 'the live proof role must be NOBYPASSRLS').toBe(false);

  const migration = readFileSync('scripts/migrations/117-swarm-memory-provenance.sql', 'utf8');
  const admin = await adminPool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await admin.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await admin.query(migration);
    await admin.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(PROBE_ROLE)}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quotedIdentifier(SCHEMA)}.oshal_swarm_memory TO ${quotedIdentifier(PROBE_ROLE)}`,
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    admin.release();
  }

  const roleOption = PROBE_URL ? '' : `-c role=${PROBE_ROLE} `;
  probePool = new Pool({
    connectionString: PROBE_URL || ADMIN_URL,
    options: `${roleOption}-c search_path=${SCHEMA},public`,
  });
  const identity = await probePool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0].current_user, 'the proof must execute as the non-bypass role').toBe(PROBE_ROLE);
  wrappedPool = wrapPoolWithGuc(probePool);

  rag = new LiveMemoryRag();
  const memory = new SwarmMemoryService(rag as unknown as RagService, wrappedPool);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const subject = req.header('x-test-sub') || '';
    (req as unknown as { oidc: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub: subject },
    };
    runWithRequestIdentity({ sub: subject, isOperator: subject === OPERATOR }, () => next());
  });
  app.use('/api/swarm/memory', createMemoryRoutes({} as AgentMemoryService, memory));
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await closeServer().catch(() => undefined);
  await probePool?.end().catch(() => undefined);
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(SCHEMA)} CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
  }
  for (const key of ENV_KEYS) {
    const original = savedEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test('real Pool enforces broker RLS, exact owners/workspaces, and operator authority', async () => {
  await expect(inspectWrappedIdentity(OWNER_A, false)).resolves.toEqual({
    currentSub: OWNER_A,
    operator: 'off',
  });
  await expect(inspectWrappedIdentity(OPERATOR, true)).resolves.toEqual({
    currentSub: OPERATOR,
    operator: 'on',
  });

  for (const item of [
    { subject: OWNER_A, workItemId: ITEM_A, workspaceId: WORKSPACE_A, marker: `owner-a-secret-${RUN}` },
    { subject: OWNER_B, workItemId: ITEM_B, workspaceId: WORKSPACE_B, marker: `owner-b-secret-${RUN}` },
  ]) {
    const response = await request('/api/swarm/memory/shared/store', item.subject, {
      method: 'POST',
      body: JSON.stringify({
        workItemId: item.workItemId,
        title: `Memory ${item.workItemId}`,
        agentId: 'sec05-live-proof',
        executionOutput: item.marker,
        workspaceId: item.workspaceId,
      }),
    });
    expect(response.status).toBe(201);
  }

  const ownerA = await request(
    `/api/swarm/memory/shared/query?q=memory&workspaceId=${encodeURIComponent(WORKSPACE_A)}&limit=10`,
    OWNER_A,
  );
  const ownerAResult = await ownerA.json() as { results: Array<{ metadata: Record<string, string>; text: string }> };
  expect(ownerA.status).toBe(200);
  expect(ownerAResult.results.map((entry) => entry.metadata.work_item_id)).toEqual([ITEM_A]);
  expect(ownerAResult.results[0].text).toContain(`owner-a-secret-${RUN}`);
  expect(ownerAResult.results[0].text).not.toContain(`owner-b-secret-${RUN}`);

  const ownerB = await request(
    `/api/swarm/memory/shared/query?q=memory&workspaceId=${encodeURIComponent(WORKSPACE_B)}&limit=10`,
    OWNER_B,
  );
  const ownerBResult = await ownerB.json() as { results: Array<{ metadata: Record<string, string> }> };
  expect(ownerBResult.results.map((entry) => entry.metadata.work_item_id)).toEqual([ITEM_B]);

  const wrongWorkspace = await request(
    `/api/swarm/memory/shared/query?q=memory&workspaceId=${encodeURIComponent(WORKSPACE_B)}&limit=10`,
    OWNER_A,
  );
  expect((await wrongWorkspace.json() as { results: unknown[] }).results).toEqual([]);

  const operatorRead = await request('/api/swarm/memory/shared/query?q=memory&limit=10', OPERATOR);
  const operatorResult = await operatorRead.json() as { results: Array<{ metadata: Record<string, string> }> };
  expect(new Set(operatorResult.results.map((entry) => entry.metadata.work_item_id)))
    .toEqual(new Set([ITEM_A, ITEM_B]));

  const digest = createHash('sha256').update(rag.document(ITEM_A)).digest('hex');
  const deniedApproval = await request(`/api/swarm/memory/shared/${ITEM_A}/approve`, OWNER_B, {
    method: 'POST', body: JSON.stringify({ contentSha256: digest }),
  });
  expect(deniedApproval.status).toBe(403);

  const approved = await request(`/api/swarm/memory/shared/${ITEM_A}/approve`, OPERATOR, {
    method: 'POST', body: JSON.stringify({ contentSha256: digest }),
  });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({
    provenance: {
      trustLevel: 'approved',
      approvedBySub: OPERATOR,
      approvalContentSha256: digest,
    },
  });

  const durableRows = await adminLedgerQuery<{
    work_item_id: string;
    owner_sub: string;
    workspace_id: string;
    trust_level: string;
    approved_by_sub: string | null;
  }>(
    `SELECT work_item_id, owner_sub, workspace_id, trust_level, approved_by_sub
       FROM ${quotedIdentifier(SCHEMA)}.oshal_swarm_memory ORDER BY work_item_id`,
  );
  expect(durableRows).toEqual([
    {
      work_item_id: ITEM_A,
      owner_sub: OWNER_A,
      workspace_id: WORKSPACE_A,
      trust_level: 'approved',
      approved_by_sub: OPERATOR,
    },
    {
      work_item_id: ITEM_B,
      owner_sub: OWNER_B,
      workspace_id: WORKSPACE_B,
      trust_level: 'untrusted',
      approved_by_sub: null,
    },
  ]);

  const unbrokeredRead = await probePool.query('SELECT work_item_id FROM oshal_swarm_memory');
  expect(unbrokeredRead.rowCount, 'FORCE RLS must hide every ledger row without the broker marker').toBe(0);
  await expect(probePool.query(
    `INSERT INTO oshal_swarm_memory
       (work_item_id,title,document,content_sha256,owner_sub,visibility,trust_level,source,created_by_workload)
     VALUES ($1,'forged','forged',$2,$3,'private','untrusted','forged','forged')`,
    [`forged-${RUN}`, '0'.repeat(64), OWNER_B],
  )).rejects.toThrow(/row-level security/i);
});
