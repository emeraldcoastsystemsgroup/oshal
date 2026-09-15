/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the silent access check (operating-fluency-spec P2). A store or authority error thrown inside an access decision used to be returned as a plain `false` — indistinguishable from a real denial, with nothing logged — which is how a Jarvis ownership fault read as an empty history for three days with no log line anywhere. These cases drive a REAL throw through each guard in jarvis-result-access and protected-result-access and assert the pair that matters: the fail-closed return is preserved (nothing here weakens a gate) AND the undetermined case is reported at ERROR while a genuine denial stays quiet. A fix that logged on every denial, or that stopped failing closed, fails these cases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The distinguishing signal IS the log, so it has to be observable. Same capture shape the
// other route specs use (see a2a-harness-adapter.spec.ts).
const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

// Ownership middleware is the layer ABOVE the boundary under test; the boundary itself (a task
// store that throws, and the real protected-results authority) stays real.
const authzSpies = vi.hoisted(() => ({
  getTrustedServiceUserSub: vi.fn(() => undefined as string | undefined),
  canAccessResource: vi.fn(() => true),
}));
vi.mock('@/shared/middleware/authz', () => authzSpies);

import type { AppContext } from '@/app/composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import {
  canReadJarvisSession,
  filterJarvisResultRows,
  hasProtectedJarvisSource,
} from '@/app/routes/jarvis-result-access';
import { callerCanReadStoredTaskResult } from '@/app/routes/protected-result-access';

const OWNER = 'auth0|owner-1';
const TASK_ID = 'task-abc';
const STORE_FAULT = new Error('connection terminated unexpectedly');

/** Builds a context whose task store answers with the given task. */
function ctxWithTask(task: unknown): AppContext {
  return { taskStore: { get: vi.fn(async () => task) } } as unknown as AppContext;
}

/** Builds a context whose task store THROWS — the fault this guard exists for. */
function ctxWithThrowingStore(): AppContext {
  return {
    taskStore: {
      get: vi.fn(async () => {
        throw STORE_FAULT;
      }),
    },
  } as unknown as AppContext;
}

const actor = async (): Promise<AuthorizationActor> =>
  ({ sub: OWNER, issuer: 'https://issuer.example/', isActive: true }) as AuthorizationActor;

/** Every ERROR the module logged in this case. */
const errorCalls = () => logSpies.error.mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  authzSpies.getTrustedServiceUserSub.mockReturnValue(undefined);
  authzSpies.canAccessResource.mockReturnValue(true);
});

describe('canReadJarvisSession', () => {
  it('permits the owner and says nothing', async () => {
    const ctx = ctxWithTask({ taskId: TASK_ID, ownerSub: OWNER, metadata: {} });

    expect(await canReadJarvisSession(ctx, OWNER, null, TASK_ID, actor)).toBe(true);
    expect(errorCalls()).toHaveLength(0);
  });

  it('denies a foreign owner QUIETLY — a denial is not a fault', async () => {
    const ctx = ctxWithTask({ taskId: TASK_ID, ownerSub: 'auth0|someone-else', metadata: {} });

    expect(await canReadJarvisSession(ctx, OWNER, null, TASK_ID, actor)).toBe(false);
    expect(errorCalls()).toHaveLength(0);
  });

  it('denies a missing task QUIETLY', async () => {
    const ctx = ctxWithTask(undefined);

    expect(await canReadJarvisSession(ctx, OWNER, null, TASK_ID, actor)).toBe(false);
    expect(errorCalls()).toHaveLength(0);
  });

  it('still fails closed when the store throws, and REPORTS it', async () => {
    const ctx = ctxWithThrowingStore();

    // Fail-closed is preserved. This is the half that must never regress.
    expect(await canReadJarvisSession(ctx, OWNER, null, TASK_ID, actor)).toBe(false);

    // ...and the half that was missing: the fault is on the record, carrying the real error
    // and the task it was deciding, so it can be told apart from a refusal.
    expect(errorCalls()).toHaveLength(1);
    const [payload, message] = errorCalls()[0];
    expect(payload).toMatchObject({ err: STORE_FAULT, taskId: TASK_ID });
    expect(String(message)).toContain('undetermined');
  });

  it('returns the SAME value for a denial and a fault, and only the fault is reported', async () => {
    // This is the defect in one case: before the fix these two were indistinguishable to
    // every caller AND to every operator reading logs. The return staying equal is correct;
    // the silence was not.
    const denied = await canReadJarvisSession(
      ctxWithTask({ taskId: TASK_ID, ownerSub: 'auth0|someone-else', metadata: {} }),
      OWNER, null, TASK_ID, actor,
    );
    const deniedErrors = errorCalls().length;

    const faulted = await canReadJarvisSession(ctxWithThrowingStore(), OWNER, null, TASK_ID, actor);
    const faultedErrors = errorCalls().length;

    expect(denied).toBe(faulted);
    expect(deniedErrors).toBe(0);
    expect(faultedErrors).toBe(1);
  });
});

describe('filterJarvisResultRows', () => {
  it('drops a foreign row QUIETLY', async () => {
    const ctx = ctxWithTask({ taskId: TASK_ID, ownerSub: OWNER, metadata: {} });
    const rows = [{ id: 'row-1', user_sub: 'auth0|someone-else' }];

    expect(await filterJarvisResultRows(ctx, OWNER, rows, actor)).toEqual([]);
    expect(errorCalls()).toHaveLength(0);
  });

  it('withholds a row whose authority threw, and REPORTS it', async () => {
    const ctx = ctxWithThrowingStore();
    const rows = [{ id: 'row-1', user_sub: OWNER }];

    expect(await filterJarvisResultRows(ctx, OWNER, rows, actor)).toEqual([]);
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0][0]).toMatchObject({ err: STORE_FAULT, rowId: 'row-1' });
  });

  it('reports every undetermined row rather than one summary line', async () => {
    const ctx = ctxWithThrowingStore();
    const rows = [{ id: 'row-1', user_sub: OWNER }, { id: 'row-2', user_sub: OWNER }];

    expect(await filterJarvisResultRows(ctx, OWNER, rows, actor)).toEqual([]);
    expect(errorCalls()).toHaveLength(2);
  });
});

describe('hasProtectedJarvisSource', () => {
  it('classifies an ordinary source as unprotected and says nothing', async () => {
    const ctx = ctxWithTask({ taskId: TASK_ID, ownerSub: OWNER, metadata: {} });

    expect(await hasProtectedJarvisSource(ctx, [TASK_ID])).toBe(false);
    expect(errorCalls()).toHaveLength(0);
  });

  it('treats an unclassifiable source as protected, and REPORTS why', async () => {
    const ctx = ctxWithThrowingStore();

    // The conservative answer is kept — this guard withholds, it never widens.
    expect(await hasProtectedJarvisSource(ctx, [TASK_ID])).toBe(true);
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0][0]).toMatchObject({ err: STORE_FAULT });
  });
});

describe('callerCanReadStoredTaskResult', () => {
  const req = {} as never;

  it('permits a task the caller owns and says nothing', async () => {
    const ctx = ctxWithTask({ taskId: TASK_ID, ownerSub: OWNER, metadata: {} });

    expect(await callerCanReadStoredTaskResult(ctx, req, TASK_ID)).toBe(true);
    expect(errorCalls()).toHaveLength(0);
  });

  it('denies a foreign task QUIETLY', async () => {
    authzSpies.canAccessResource.mockReturnValue(false);
    const ctx = ctxWithTask({ taskId: TASK_ID, ownerSub: 'auth0|someone-else', metadata: {} });

    expect(await callerCanReadStoredTaskResult(ctx, req, TASK_ID)).toBe(false);
    expect(errorCalls()).toHaveLength(0);
  });

  it('denies a missing task QUIETLY', async () => {
    const ctx = ctxWithTask(undefined);

    expect(await callerCanReadStoredTaskResult(ctx, req, TASK_ID)).toBe(false);
    expect(errorCalls()).toHaveLength(0);
  });

  it('still fails closed when the store throws, and REPORTS it', async () => {
    const ctx = ctxWithThrowingStore();

    // The return MUST stay false rather than throw: this runs as the per-event callback
    // registered with streamManager, where a rejection would land once per streamed event.
    expect(await callerCanReadStoredTaskResult(ctx, req, TASK_ID)).toBe(false);

    expect(errorCalls()).toHaveLength(1);
    const [payload, message] = errorCalls()[0];
    expect(payload).toMatchObject({ err: STORE_FAULT, taskId: TASK_ID });
    expect(String(message)).toContain('undetermined');
  });
});
