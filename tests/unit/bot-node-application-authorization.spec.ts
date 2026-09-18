/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the bot posture check that refused without saying why (live-board fault B4). readProtectedBotApplication ended in a bare `catch { throw ... }`, so a 42501 from the ownership read — the exact failure migration 140 exists for — reached the operator as a bare 503 authorization_bot_posture_unavailable with nothing logged and no cause attached. These cases assert the pair that matters: every refusal still fails closed with its EXACT existing code (nothing here widens execution authority) AND an undetermined posture is now reported, while a posture the guard genuinely DECIDED is distinguishable from one it could not determine. A fix that logged on every path, or that stopped failing closed, fails these cases.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Same correction as the module: the live comment named migration 140, which this change deletes. The case itself is unchanged - it still pins that a 42501 from the ownership read is reported as UNDETERMINED rather than swallowed.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The pool-less refusal names its cause. A missing pool, and an ownership read whose wrapped cause is a socket refusal, refuse with database_pool_unavailable / 503; a database that ANSWERS with 42501 keeps the authorization code, so the two outages stop reading as one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

const ownership = vi.hoisted(() => ({ readApplicationExecutionOwnership: vi.fn() }));
vi.mock('@/app/application-execution-ownership', () => ownership);

import {
  BotApplicationAuthorizationError,
  assertBotNodeApplicationTransport,
  readProtectedBotApplication,
} from '@/app/bot-node-application-authorization';

const POOL = { query: vi.fn() } as never;
const LOCAL = 'agent-local-1';
const TARGET = 'agent-target-2';

/** The shape the derived helper exists to prevent: the bot cannot read what its guard reads. */
const PERMISSION_DENIED = Object.assign(new Error('permission denied for table oshal_authorization_applications'), {
  code: '42501',
});

const errorCalls = () => logSpies.error.mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  ownership.readApplicationExecutionOwnership.mockReset();
});

describe('readProtectedBotApplication — the decided cases stay quiet', () => {
  it('returns null for an unprotected execution and logs nothing', async () => {
    ownership.readApplicationExecutionOwnership.mockResolvedValue({ app: 'demo', protected: false });

    expect(await readProtectedBotApplication(POOL, LOCAL, TARGET)).toBeNull();
    expect(errorCalls()).toHaveLength(0);
  });

  it('returns the owning application for a protected execution and logs nothing', async () => {
    ownership.readApplicationExecutionOwnership.mockResolvedValue({ app: 'trading', protected: true });

    expect(await readProtectedBotApplication(POOL, LOCAL, TARGET)).toBe('trading');
    expect(errorCalls()).toHaveLength(0);
  });
});

describe('readProtectedBotApplication — the refusals still refuse, and now say why', () => {
  it('fails closed when the pool is absent, NAMES the database as the cause, and REPORTS it', async () => {
    const raised = await readProtectedBotApplication(null, LOCAL, TARGET).catch(err => err);
    expect(raised).toBeInstanceOf(BotApplicationAuthorizationError);
    expect(raised).toMatchObject({ code: 'database_pool_unavailable', status: 503 });
    expect(ownership.readApplicationExecutionOwnership).not.toHaveBeenCalled();

    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0][0]).toMatchObject({ hasPool: false });
  });

  it('fails closed with the exact code when the identity is absent, and REPORTS it', async () => {
    await expect(readProtectedBotApplication(POOL, '', TARGET)).rejects.toBeInstanceOf(BotApplicationAuthorizationError);
    expect(errorCalls()).toHaveLength(1);
  });

  it('names the database when the ownership read failed because nothing answered the socket', async () => {
    // The shape the real reader throws: its own error class, the driver failure carried as cause.
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const wrapped = new Error('Application execution ownership is unavailable', { cause: refused });
    ownership.readApplicationExecutionOwnership.mockRejectedValue(wrapped);

    const raised = await readProtectedBotApplication(POOL, LOCAL, TARGET).catch(err => err);
    expect(raised).toBeInstanceOf(BotApplicationAuthorizationError);
    expect(raised).toMatchObject({ code: 'database_pool_unavailable', status: 503, reason: wrapped });
    expect(errorCalls()).toHaveLength(1);
  });

  it('keeps the code on a 42501 and carries the CAUSE instead of discarding it', async () => {
    ownership.readApplicationExecutionOwnership.mockRejectedValue(PERMISSION_DENIED);

    // Fail-closed and the contract are unchanged. This half must never regress.
    const raised = await readProtectedBotApplication(POOL, LOCAL, TARGET).catch(err => err);
    expect(raised).toBeInstanceOf(BotApplicationAuthorizationError);
    expect(raised.code).toBe('authorization_bot_posture_unavailable');
    expect(raised.status).toBe(503);

    // ...and the half that was missing: the real error survives, on the error and in the log.
    expect(raised.reason).toBe(PERMISSION_DENIED);
    expect(errorCalls()).toHaveLength(1);
    const [payload, message] = errorCalls()[0];
    expect(payload).toMatchObject({ err: PERMISSION_DENIED, conflicting: false });
    expect(String(message)).toContain('undetermined');
  });

  it('marks a conflicting-ownership refusal as DECIDED, not undetermined', async () => {
    ownership.readApplicationExecutionOwnership
      .mockResolvedValueOnce({ app: 'trading', protected: true })
      .mockResolvedValueOnce({ app: 'identity', protected: true });

    await expect(readProtectedBotApplication(POOL, LOCAL, TARGET)).rejects.toMatchObject({
      code: 'authorization_bot_posture_unavailable',
    });

    expect(errorCalls()).toHaveLength(1);
    const [payload, message] = errorCalls()[0];
    expect(payload).toMatchObject({ conflicting: true });
    expect(String(message)).toContain('conflicting');
  });

  it('returns the SAME code for a decided refusal and an undetermined one, and only the reason differs', async () => {
    // The defect stated in one case. Before the fix both were a bare code with no log and no
    // cause, so an outage and a policy conflict were the same event to every reader.
    ownership.readApplicationExecutionOwnership
      .mockResolvedValueOnce({ app: 'trading', protected: true })
      .mockResolvedValueOnce({ app: 'identity', protected: true });
    const decided = await readProtectedBotApplication(POOL, LOCAL, TARGET).catch(err => err);
    const decidedPayload = errorCalls()[0][0];

    vi.clearAllMocks();
    ownership.readApplicationExecutionOwnership.mockRejectedValue(PERMISSION_DENIED);
    const faulted = await readProtectedBotApplication(POOL, LOCAL, TARGET).catch(err => err);
    const faultedPayload = errorCalls()[0][0];

    expect(decided.code).toBe(faulted.code);
    expect(decidedPayload).toMatchObject({ conflicting: true });
    expect(faultedPayload).toMatchObject({ conflicting: false });
    expect(faulted.reason).toBe(PERMISSION_DENIED);
  });
});

describe('assertBotNodeApplicationTransport', () => {
  it('permits an unprotected execution on this transport', async () => {
    ownership.readApplicationExecutionOwnership.mockResolvedValue({ app: 'demo', protected: false });

    await expect(assertBotNodeApplicationTransport(POOL, LOCAL, TARGET)).resolves.toBeUndefined();
    expect(errorCalls()).toHaveLength(0);
  });

  it('keeps a protected execution off this transport', async () => {
    ownership.readApplicationExecutionOwnership.mockResolvedValue({ app: 'trading', protected: true });

    await expect(assertBotNodeApplicationTransport(POOL, LOCAL, TARGET)).rejects.toMatchObject({
      code: 'authorization_bot_transport_unavailable',
      status: 503,
    });
  });
});
