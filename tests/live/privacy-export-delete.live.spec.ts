/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live proof for user-scoped privacy export/delete.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fail (not skip) when CI runs without MOCK_OIDC_ALLOW_HEADER — passing-by-skipping in the nightly green set is the guard-that-isn't. Local runs still skip politely.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL host pinned to 127.0.0.1 — "localhost" resolves to ::1 where a stale wslrelay squats the port (ECONNREFUSED ::1:3456, 2026-07-23 ci-local --head run); same change as playwright.config.ts BASE_URL. Port resolution unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | In nightly evidence mode, prove export/delete fixtures were database-backed and the other owner's Postgres rows survive deletion.
 */

import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test';
import { PRIVACY_DELETE_CONFIRMATION } from '../../src/app/routes/privacy-routes';
import { readOwnDataDatabaseEvidence } from '../helpers/own-data-database-evidence';

const HEADER_GATE_ENABLED = ['true', '1', 'yes'].includes(
  (process.env.MOCK_OIDC_ALLOW_HEADER ?? '').toLowerCase().trim(),
);
const BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '4458'}`;
const PROOF_ID = `privacy-export-delete-${Date.now()}`;

const USER_A = {
  sub: `auth0|${PROOF_ID}-user-a`,
  email: `${PROOF_ID}-a@example.test`,
  name: 'Privacy User A',
};
const USER_B = {
  sub: `auth0|${PROOF_ID}-user-b`,
  email: `${PROOF_ID}-b@example.test`,
  name: 'Privacy User B',
};

type PrivacyExportBody = {
  counts: { tasks: number; messages: number; tickets: number; auditEvents: number };
  tasks: Array<{ taskId?: string; id?: string; title?: string }>;
  tickets: Array<{ ticketId?: string; id?: string; title?: string }>;
};

test('MOCK_OIDC live: user can export and delete own operational data only', async ({}, testInfo) => {
  if (!HEADER_GATE_ENABLED && (process.env.CI ?? '') !== '') {
    // In CI a skip here is indistinguishable from a pass — the export/delete ownership
    // proof would silently stop existing. The gate env must enable it, or this reddens.
    throw new Error('CI ran without MOCK_OIDC_ALLOW_HEADER=true — the privacy export/delete proof must RUN in CI, never skip.');
  }
  test.skip(!HEADER_GATE_ENABLED, 'Set MOCK_OIDC_ALLOW_HEADER=true to run the privacy export/delete proof.');
  test.setTimeout(120_000);

  const userA = await apiRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: mockUserHeaders(USER_A) });
  const userB = await apiRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: mockUserHeaders(USER_B) });

  try {
    const taskA = await createTask(userA, `user A export/delete task ${PROOF_ID}`);
    const taskB = await createTask(userB, `user B retained task ${PROOF_ID}`);
    const ticketA = await createTicket(userA, `user A export/delete ticket ${PROOF_ID}`);
    const ticketB = await createTicket(userB, `user B retained ticket ${PROOF_ID}`);

    const databaseBeforeA = await readOwnDataDatabaseEvidence(USER_A.sub, {
      taskIds: [taskA.taskId, taskB.taskId],
      ticketIds: [ticketA.ticketId, ticketB.ticketId],
    });
    const databaseBeforeB = await readOwnDataDatabaseEvidence(USER_B.sub, {
      taskIds: [taskA.taskId, taskB.taskId],
      ticketIds: [ticketA.ticketId, ticketB.ticketId],
    });
    if (databaseBeforeA && databaseBeforeB) {
      expect(databaseBeforeA.role).toBe('oshal_app');
      expect(databaseBeforeA.superuser).toBe(false);
      expect(databaseBeforeA.bypassRls).toBe(false);
      expect(databaseBeforeA.tasks.map((row) => row.taskId)).toEqual([taskA.taskId]);
      expect(databaseBeforeA.tickets.map((row) => row.ticketId)).toEqual([ticketA.ticketId]);
      expect(databaseBeforeB.tasks.map((row) => row.taskId)).toEqual([taskB.taskId]);
      expect(databaseBeforeB.tickets.map((row) => row.ticketId)).toEqual([ticketB.ticketId]);
    }

    const exportA = await exportPrivacy(userA);
    expect(ids(exportA.tasks, 'task')).toContain(taskA.taskId);
    expect(ids(exportA.tasks, 'task')).not.toContain(taskB.taskId);
    expect(ids(exportA.tickets, 'ticket')).toContain(ticketA.ticketId);
    expect(ids(exportA.tickets, 'ticket')).not.toContain(ticketB.ticketId);

    const missingConfirm = await userA.delete('/api/privacy/me', { data: { confirm: 'delete' } });
    expect(missingConfirm.status(), 'delete requires exact confirmation').toBe(400);

    const deleteA = await userA.delete('/api/privacy/me', {
      data: { confirm: PRIVACY_DELETE_CONFIRMATION },
    });
    expect(deleteA.status(), 'delete user A data').toBe(200);
    const deleteBody = await deleteA.json() as { deleted: { tasks: number; tickets: number } };
    expect(deleteBody.deleted.tasks).toBe(1);
    expect(deleteBody.deleted.tickets).toBe(1);

    const exportAfterDeleteA = await exportPrivacy(userA);
    expect(ids(exportAfterDeleteA.tasks, 'task')).not.toContain(taskA.taskId);
    expect(ids(exportAfterDeleteA.tickets, 'ticket')).not.toContain(ticketA.ticketId);

    const exportB = await exportPrivacy(userB);
    expect(ids(exportB.tasks, 'task')).toContain(taskB.taskId);
    expect(ids(exportB.tickets, 'ticket')).toContain(ticketB.ticketId);

    const databaseAfterA = await readOwnDataDatabaseEvidence(USER_A.sub, {
      taskIds: [taskA.taskId, taskB.taskId],
      ticketIds: [ticketA.ticketId, ticketB.ticketId],
    });
    const databaseAfterB = await readOwnDataDatabaseEvidence(USER_B.sub, {
      taskIds: [taskA.taskId, taskB.taskId],
      ticketIds: [ticketA.ticketId, ticketB.ticketId],
    });
    if (databaseAfterA && databaseAfterB) {
      expect(databaseAfterA.tasks).toEqual([]);
      expect(databaseAfterA.tickets).toEqual([]);
      expect(databaseAfterB.tasks.map((row) => row.taskId)).toEqual([taskB.taskId]);
      expect(databaseAfterB.tickets.map((row) => row.ticketId)).toEqual([ticketB.ticketId]);
    }

    await testInfo.attach('privacy-export-delete-proof.json', {
      body: JSON.stringify({
        proofId: PROOF_ID,
        userA: { sub: USER_A.sub, deletedTask: taskA.taskId, deletedTicket: ticketA.ticketId },
        userB: { sub: USER_B.sub, retainedTask: taskB.taskId, retainedTicket: ticketB.ticketId },
        databaseEvidence: databaseBeforeA && databaseBeforeB && databaseAfterA && databaseAfterB
          ? { before: { userA: databaseBeforeA, userB: databaseBeforeB }, after: { userA: databaseAfterA, userB: databaseAfterB } }
          : null,
        result: 'user A export/delete removed only user A operational data; user B data remained exportable',
      }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await userA.delete('/api/privacy/me', { data: { confirm: PRIVACY_DELETE_CONFIRMATION } }).catch(() => {});
    await userB.delete('/api/privacy/me', { data: { confirm: PRIVACY_DELETE_CONFIRMATION } }).catch(() => {});
    await userA.dispose();
    await userB.dispose();
  }
});

async function createTask(api: APIRequestContext, title: string): Promise<{ taskId: string }> {
  const res = await api.post('/api/tasks', {
    data: {
      title,
      processingMode: 'agentic',
      metadata: { source: 'privacy-export-delete-live', proofId: PROOF_ID },
    },
  });
  expect(res.status(), `create task ${title}`).toBe(201);
  const body = await res.json() as { taskId?: string; id?: string };
  const taskId = body.taskId || body.id;
  expect(taskId, `created task id for ${title}`).toBeTruthy();
  return { taskId: taskId! };
}

async function createTicket(api: APIRequestContext, title: string): Promise<{ ticketId: string }> {
  const res = await api.post('/api/tickets', {
    data: {
      title,
      description: 'Live privacy export/delete proof ticket.',
      ticketType: 'task',
      status: 'approved',
      priority: 'low',
      labels: ['live-e2e', 'privacy-export-delete'],
      metadata: { source: 'privacy-export-delete-live', proofId: PROOF_ID },
    },
  });
  expect(res.status(), `create ticket ${title}`).toBe(201);
  const body = await res.json() as { ticketId?: string; id?: string };
  const ticketId = body.ticketId || body.id;
  expect(ticketId, `created ticket id for ${title}`).toBeTruthy();
  return { ticketId: ticketId! };
}

async function exportPrivacy(api: APIRequestContext): Promise<PrivacyExportBody> {
  const res = await api.get('/api/privacy/export');
  expect(res.status(), 'export privacy data').toBe(200);
  return await res.json() as PrivacyExportBody;
}

function ids(items: PrivacyExportBody['tasks'] | PrivacyExportBody['tickets'], kind: 'task' | 'ticket'): string[] {
  return items.map((item) => kind === 'task' ? item.taskId || item.id || '' : item.ticketId || item.id || '');
}

function mockUserHeaders(user: { sub: string; email: string; name: string }): Record<string, string> {
  return {
    'x-mock-oidc-sub': user.sub,
    'x-mock-oidc-email': user.email,
    'x-mock-oidc-name': user.name,
  };
}
