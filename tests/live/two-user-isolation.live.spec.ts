/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live mock-OIDC two-user isolation proof for
 *                     |               | task and message API object guards.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fail (not skip) when CI runs without MOCK_OIDC_ALLOW_HEADER — this proof sat in the e2e-green set passing-by-skipping every night (the guard-that-isn't). Local runs still skip politely.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL host pinned to 127.0.0.1 — "localhost" resolves to ::1 where a stale wslrelay squats the port (ECONNREFUSED ::1:3456, 2026-07-23 ci-local --head run); same change as playwright.config.ts BASE_URL. Port resolution unchanged.
 */

import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test';

const HEADER_GATE_ENABLED = ['true', '1', 'yes'].includes(
  (process.env.MOCK_OIDC_ALLOW_HEADER ?? '').toLowerCase().trim(),
);
const BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '4458'}`;
const PROOF_ID = `live-two-user-isolation-${Date.now()}`;

const USER_A = {
  sub: `auth0|${PROOF_ID}-user-a`,
  email: `${PROOF_ID}-a@example.test`,
  name: 'Live User A',
};
const USER_B = {
  sub: `auth0|${PROOF_ID}-user-b`,
  email: `${PROOF_ID}-b@example.test`,
  name: 'Live User B',
};

type TaskBody = {
  taskId?: string;
  id?: string;
  title?: string;
  ownerSub?: string | null;
  tasks?: Array<{ taskId?: string; id?: string; title?: string; ownerSub?: string | null }>;
};

test('MOCK_OIDC live: user A and user B cannot read each other task or message surfaces', async ({
  browser,
}, testInfo) => {
  if (!HEADER_GATE_ENABLED && (process.env.CI ?? '') !== '') {
    // In CI a skip here is indistinguishable from a pass — the cross-user isolation
    // proof would silently stop existing. The gate env must enable it, or this reddens.
    throw new Error('CI ran without MOCK_OIDC_ALLOW_HEADER=true — the two-user isolation proof must RUN in CI, never skip.');
  }
  test.skip(!HEADER_GATE_ENABLED, 'Set MOCK_OIDC_ALLOW_HEADER=true to run the two-user mock-OIDC isolation proof.');
  test.setTimeout(120_000);

  const userA = await apiRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: mockUserHeaders(USER_A) });
  const userB = await apiRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: mockUserHeaders(USER_B) });
  const createdTaskIds: Array<{ api: APIRequestContext; taskId: string }> = [];

  try {
    const taskA = await createTask(userA, `user A private task ${PROOF_ID}`);
    const taskB = await createTask(userB, `user B private task ${PROOF_ID}`);
    createdTaskIds.push({ api: userA, taskId: taskA.taskId });
    createdTaskIds.push({ api: userB, taskId: taskB.taskId });

    const userAList = await listTasks(userA, USER_B.sub);
    const userBList = await listTasks(userB, USER_A.sub);

    expect(userAList.map((task) => task.taskId || task.id)).toContain(taskA.taskId);
    expect(userAList.map((task) => task.taskId || task.id)).not.toContain(taskB.taskId);
    expect(userBList.map((task) => task.taskId || task.id)).toContain(taskB.taskId);
    expect(userBList.map((task) => task.taskId || task.id)).not.toContain(taskA.taskId);

    await expectStatus(userA.get(`/api/tasks/${encodeURIComponent(taskA.taskId)}`), 200, 'user A can read user A task');
    await expectStatus(userB.get(`/api/tasks/${encodeURIComponent(taskB.taskId)}`), 200, 'user B can read user B task');
    await expectStatus(userA.get(`/api/tasks/${encodeURIComponent(taskB.taskId)}`), 404, 'user A cannot read user B task');
    await expectStatus(userB.get(`/api/tasks/${encodeURIComponent(taskA.taskId)}`), 404, 'user B cannot read user A task');

    await expectStatus(userA.get(`/api/${encodeURIComponent(taskA.taskId)}/messages`), 200, 'user A can read user A message surface');
    await expectStatus(userB.get(`/api/${encodeURIComponent(taskB.taskId)}/messages`), 200, 'user B can read user B message surface');
    await expectStatus(userA.get(`/api/${encodeURIComponent(taskB.taskId)}/messages`), 404, 'user A cannot read user B message surface');
    await expectStatus(userB.get(`/api/${encodeURIComponent(taskA.taskId)}/messages`), 404, 'user B cannot read user A message surface');

    const browserA = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: mockUserHeaders(USER_A) });
    const browserB = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: mockUserHeaders(USER_B) });
    try {
      const pageA = await browserA.newPage();
      const pageB = await browserB.newPage();
      const browserAOwn = await pageA.goto(`/api/tasks/${encodeURIComponent(taskA.taskId)}`);
      const browserACross = await pageA.goto(`/api/tasks/${encodeURIComponent(taskB.taskId)}`);
      const browserBOwn = await pageB.goto(`/api/tasks/${encodeURIComponent(taskB.taskId)}`);
      const browserBCross = await pageB.goto(`/api/tasks/${encodeURIComponent(taskA.taskId)}`);
      expect(browserAOwn?.status(), 'browser user A can read own task').toBe(200);
      expect(browserACross?.status(), 'browser user A cannot read user B task').toBe(404);
      expect(browserBOwn?.status(), 'browser user B can read own task').toBe(200);
      expect(browserBCross?.status(), 'browser user B cannot read user A task').toBe(404);
    } finally {
      await browserA.close();
      await browserB.close();
    }

    await testInfo.attach('two-user-isolation-proof.json', {
      body: JSON.stringify({
        proofId: PROOF_ID,
        userA: { sub: USER_A.sub, taskId: taskA.taskId },
        userB: { sub: USER_B.sub, taskId: taskB.taskId },
        result: 'user A and user B cannot read each other task or message API surfaces',
      }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await Promise.allSettled(createdTaskIds.map(({ api, taskId }) => api.delete(`/api/tasks/${encodeURIComponent(taskId)}`)));
    await userA.dispose();
    await userB.dispose();
  }
});

async function createTask(api: APIRequestContext, title: string): Promise<{ taskId: string }> {
  const res = await api.post('/api/tasks', {
    data: {
      title,
      processingMode: 'agentic',
      metadata: {
        source: 'live-two-user-isolation',
        proofId: PROOF_ID,
      },
    },
  });
  expect(res.status(), `create ${title}`).toBe(201);
  const body = await res.json() as TaskBody;
  const taskId = body.taskId || body.id;
  expect(taskId, `created task id for ${title}`).toBeTruthy();
  return { taskId: taskId! };
}

async function listTasks(api: APIRequestContext, requestedOwnerSub: string): Promise<NonNullable<TaskBody['tasks']>> {
  const res = await api.get(`/api/tasks?scope=all&ownerSub=${encodeURIComponent(requestedOwnerSub)}`);
  expect(res.status(), 'list tasks').toBe(200);
  const body = await res.json() as TaskBody;
  return body.tasks || [];
}

async function expectStatus(responsePromise: Promise<{ status: () => number }>, status: number, message: string): Promise<void> {
  const response = await responsePromise;
  expect(response.status(), message).toBe(status);
}

function mockUserHeaders(user: { sub: string; email: string; name: string }): Record<string, string> {
  return {
    'x-mock-oidc-sub': user.sub,
    'x-mock-oidc-email': user.email,
    'x-mock-oidc-name': user.name,
  };
}
