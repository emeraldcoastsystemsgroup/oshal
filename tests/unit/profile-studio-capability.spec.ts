/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove Profile Studio callback capabilities reject missing, malformed, expired, replayed, mismatched, and stale ABA requests while preserving hostile opaque subjects as exact data and atomically accepting one strict result.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Split capability cases into bounded test groups while retaining the complete callback security matrix.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Align hostile-subject coverage with the shared control-free exact identity contract and reject control-bearing aliases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  PROFILE_CALLBACK_OPERATION,
  hashProfileDispatchCapability,
} from '@/features/profile-studio';

const hoisted = vi.hoisted(() => ({ cleanup: vi.fn(async () => undefined) }));
vi.mock('@/app/profile-studio-dispatch', () => ({
  cleanupProfileDispatchWorkspace: hoisted.cleanup,
}));

import { createProfileStudioIngestRoutes } from '@/app/routes/profile-studio-ingest-routes';

const TOKEN_A = `pscap_${'a'.repeat(43)}`;
const TOKEN_B = `pscap_${'b'.repeat(43)}`;
const HOSTILE_SUBJECT = ` auth0|'; $(Get-ChildItem Env:) # `;

interface DispatchRow {
  userSub: string;
  state: 'dispatched' | 'applied' | 'failed';
  generation: number;
  taskId: string;
  clientId: string;
  operation: string;
  hash: string | null;
  expiresAt: number;
}

let row: DispatchRow;
let lastConsumeSql = '';
let lastConsumeParams: unknown[] = [];

const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (!sql.includes('callback_capability_expires_at > now()')) return { rows: [], rowCount: 0 };
    lastConsumeSql = sql;
    lastConsumeParams = params;
    const matched = callbackMatches(params);
    if (matched) {
      row.state = params[6] as 'applied' | 'failed';
      row.hash = null;
    }
    return { rows: [], rowCount: matched ? 1 : 0 };
  },
};

beforeEach(() => {
  row = dispatchRow();
  lastConsumeSql = '';
  lastConsumeParams = [];
  hoisted.cleanup.mockClear();
});

describe('Profile Studio one-use callback capability', () => {
  it('rejects a missing capability before touching the owner row', async () => {
    const response = await postCallback(callbackBody(), null);
    expect(response.status).toBe(401);
    expect(lastConsumeSql).toBe('');
  });

  it('rejects every mismatched immutable binding without consuming the grant', async () => {
    const variants = [
      callbackBody({ userSub: 'someone-else' }),
      callbackBody({ generation: 2 }),
      callbackBody({ taskId: 'liprofile-other-task' }),
      callbackBody({ clientId: 'other-desktop' }),
      callbackBody({ operation: 'resolve-something-else' }),
    ];
    for (const body of variants) {
      const response = await postCallback(body, TOKEN_A);
      expect([400, 409]).toContain(response.status);
      expect(row.state).toBe('dispatched');
      expect(row.hash).toBe(hashProfileDispatchCapability(TOKEN_A));
    }
  });

  it('rejects expiry and accepts a live capability exactly once', async () => {
    row.expiresAt = Date.now() - 1;
    expect((await postCallback(callbackBody(), TOKEN_A)).status).toBe(409);
    row.expiresAt = Date.now() + 60_000;
    expect((await postCallback(callbackBody(), TOKEN_A)).status).toBe(200);
    expect(row.state).toBe('applied');
    expect((await postCallback(callbackBody(), TOKEN_A)).status).toBe(409);
    expect(hoisted.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('Profile Studio callback generation and result integrity', () => {
  it('rejects stale generation A after reset/retry B and accepts only B', async () => {
    row = dispatchRow({ generation: 2, taskId: 'liprofile-7-generation-b', hash: hashProfileDispatchCapability(TOKEN_B) });
    expect((await postCallback(callbackBody(), TOKEN_A)).status).toBe(409);
    expect(row.state).toBe('dispatched');
    const bodyB = callbackBody({ generation: 2, taskId: 'liprofile-7-generation-b' });
    expect((await postCallback(bodyB, TOKEN_B)).status).toBe(200);
    expect(row.state).toBe('applied');
  });

  it('strictly rejects invalid result vocabulary, extra fields, and oversized notes', async () => {
    const invalid = [
      { ...callbackBody(), result: { result: 'maybe', note: 'no' } },
      { ...callbackBody(), result: { result: 'applied', note: 'ok', extra: true } },
      { ...callbackBody(), result: { result: 'failed', note: 'x'.repeat(4001) } },
      callbackBody({ userSub: 'auth0|owner\nforged' }),
    ];
    for (const body of invalid) expect((await postCallback(body, TOKEN_A)).status).toBe(400);
    expect(row.state).toBe('dispatched');
  });

  it('preserves a hostile opaque subject exactly as a database parameter', async () => {
    row = dispatchRow({ userSub: HOSTILE_SUBJECT });
    const response = await postCallback(callbackBody({ userSub: HOSTILE_SUBJECT }), TOKEN_A);
    expect(response.status).toBe(200);
    expect(lastConsumeParams[0]).toBe(HOSTILE_SUBJECT);
    expect(lastConsumeSql).toContain('dispatch_generation = $2');
    expect(lastConsumeSql).toContain('dispatch_task_id = $3');
    expect(lastConsumeSql).toContain('callback_capability_expires_at > now()');
  });
});

/** Build one active dispatch row, optionally replacing immutable binding fields. */
function dispatchRow(overrides: Partial<DispatchRow> = {}): DispatchRow {
  return {
    userSub: 'auth0|profile-owner', state: 'dispatched', generation: 1,
    taskId: 'liprofile-7-generation-a', clientId: 'desktop-a',
    operation: PROFILE_CALLBACK_OPERATION, hash: hashProfileDispatchCapability(TOKEN_A),
    expiresAt: Date.now() + 60_000, ...overrides,
  };
}

/** Apply the same exact predicates as the production atomic UPDATE fixture boundary. */
function callbackMatches(params: unknown[]): boolean {
  return row.state === 'dispatched'
    && params[0] === row.userSub
    && params[1] === row.generation
    && params[2] === row.taskId
    && params[3] === row.clientId
    && params[4] === row.operation
    && params[5] === row.hash
    && row.expiresAt > Date.now();
}

/** Construct the strict nested callback body and permit individual binding overrides. */
function callbackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const context = {
    userSub: overrides.userSub ?? row.userSub,
    generation: overrides.generation ?? row.generation,
    clientId: overrides.clientId ?? row.clientId,
    operation: overrides.operation ?? row.operation,
  };
  return {
    taskId: overrides.taskId ?? row.taskId,
    context,
    result: { result: 'applied', note: 'Every planned field verified.' },
  };
}

/** Start the real router and post one callback request. */
async function postCallback(body: unknown, token: string | null): Promise<Response> {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/profile-studio', createProfileStudioIngestRoutes({ pool } as never));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-oshal-callback-capability'] = token;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/profile-studio/ingest`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
