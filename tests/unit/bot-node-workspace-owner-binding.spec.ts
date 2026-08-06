/**
 * Bot-node workspace owner-binding guard — pins the ONE check that stops two users
 * sharing a task workspace directory (ADR-060's actual enforcement point).
 *
 * Every bot container mounts the SAME workspace volume read-write
 * (`oshal_workspace:/app/workspace-shared:rw`, docker-compose.oshal-local.yml), and a
 * task's directory is keyed by the workspace folder id alone — `<root>/<folderId>`
 * (any-bot TaskController.createTask, tool-executor-service.ensureWorkspacePath). The
 * per-user PATH layout ADR-060 proposed was reverted (see that ADR's status), so the
 * only thing preventing user B's bot from being handed user A's workspace directory is
 * `assertExistingTaskOwner` in bot-node-execution-handler: before a dispatch reuses an
 * existing workspace-folder task, the persisted owner must equal the caller's sub.
 *
 * This matters more here than in the any-bot controller (already pinned by
 * any-bot-task-owner-scope.spec.ts): the handler's `createTask({ forceTaskId })` branch
 * has NO owner assert of its own — it joins the flat root and, when the directory
 * already exists, works inside it and re-stamps the task record with the new caller. The
 * handler check is therefore the whole defense on the swarm path, and it was unguarded.
 *
 * A silent regression here — dropping the assert, dropping `userSub` from createTask (so
 * nothing is stamped for the NEXT dispatch to compare against), or normalizing owners
 * differently on the TS and JS sides so the comparison false-matches — is one user's bot
 * executing in another user's workspace, with that user's deliverables and brokered
 * credential drops in its cwd. This spec exists so any such change is a CONSCIOUS test
 * edit, never an accident.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — regression guard for the bot-node workspace owner binding left unpinned when ADR-060's per-user path layout was reverted: cross-owner reuse rejection (fail-closed across owned/ownerless/anonymous), no execution or task creation on mismatch, owner stamping on creation, workspace-folder-id derivation precedence and per-ticket distinctness, and TS/JS owner-normalization parity.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin exact-subject parity and canonical workspace ID propagation: valid padding/whitespace remain distinct while empty, control, malformed, and oversized assertions fail closed.
 */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';
import { normalizeBotNodeUserSub } from '../../src/app/bot-node-request-scope';

const requireModule = createRequire(import.meta.url);
const TaskController = requireModule('../../any-bot/server/controllers/TaskController.js') as {
  normalizeTaskOwner: (value: unknown) => string | null;
};

const OWNER_A = 'auth0|alice-123';
const OWNER_B = 'auth0|bob-456';

interface HarnessOptions {
  /** The task record the bot node already has for this workspace folder, if any. */
  existing?: { id: string; userSub?: string | null } | null;
}

/**
 * @description Build the handler under test with a fully stubbed any-bot controller so
 * the assertions can prove NOT-called as well as called. `processMessage` throws by
 * default: any execution at all on a rejected dispatch is itself the failure.
 */
function harness(options: HarnessOptions = {}) {
  const getTask = vi.fn(async () => options.existing ?? null);
  const createTask = vi.fn(async (_text: string, _mode: string, opts?: { forceTaskId?: string; userSub?: string }) => ({
    id: opts?.forceTaskId ?? 'generated-task',
  }));
  const processMessage = vi.fn(async () => ({
    messages: [{ say: 'completion_result', text: 'done' }],
    apiMetrics: { totalCost: 0, totalTokens: 0 },
  }));
  const handler = createBotNodeExecutionHandler({
    anyBotTaskController: { getTask, createTask, processMessage },
    providerName: 'noop',
    modelName: 'none',
  });
  return { handler, getTask, createTask, processMessage };
}

/**
 * @description Build a swarm dispatch envelope. `payload` overrides let a test change
 * exactly one id (or the caller's sub) and leave the rest of the shape realistic.
 */
function envelope(payload: Record<string, unknown>) {
  return {
    correlationId: 'owner-binding-correlation',
    fromAgentId: 'swarm-controller',
    toAgentId: 'worker-bot',
    channel: 'swarm.agent.worker-bot',
    messageType: 'request' as const,
    payload: {
      text: 'Do the work.',
      agenticMode: false,
      ...payload,
    },
  };
}

describe('bot-node workspace owner binding (ADR-060 enforcement point)', () => {
  describe('cross-owner reuse of an existing workspace folder', () => {
    it("rejects a dispatch for another owner's workspace without creating or executing anything", async () => {
      const workspaceTaskId = '11111111-2222-3333-4444-555555555555';
      const { handler, createTask, processMessage } = harness({
        existing: { id: workspaceTaskId, userSub: OWNER_A },
      });

      const result = await handler(envelope({ workspaceTaskId, userSub: OWNER_B }));

      expect(result).toMatchObject({ success: false, error: 'Task owner mismatch' });
      // No output: a rejected dispatch must not leak a response shape either.
      expect((result as { output?: unknown }).output).toBeUndefined();
      // The two things that would put owner B inside owner A's directory.
      expect(createTask).not.toHaveBeenCalled();
      expect(processMessage).not.toHaveBeenCalled();
    });

    it('fails closed across the owned / ownerless / anonymous boundaries in both directions', async () => {
      const workspaceTaskId = 'ticket-uuid-under-test';
      const boundaries: Array<{ taskOwner: string | null; caller: string | undefined }> = [
        { taskOwner: OWNER_A, caller: OWNER_B },
        // An anonymous/system dispatch must not inherit an OWNED workspace.
        { taskOwner: OWNER_A, caller: undefined },
        // A user must not inherit a legacy ownerless (system/swarm) workspace either.
        { taskOwner: null, caller: OWNER_A },
      ];

      for (const { taskOwner, caller } of boundaries) {
        const { handler, createTask, processMessage } = harness({
          existing: { id: workspaceTaskId, userSub: taskOwner },
        });
        const result = await handler(envelope({ workspaceTaskId, userSub: caller }));
        expect(result, `taskOwner=${taskOwner} caller=${caller}`).toMatchObject({
          success: false,
          error: 'Task owner mismatch',
        });
        expect(createTask).not.toHaveBeenCalled();
        expect(processMessage).not.toHaveBeenCalled();
      }
    });

    it('lets the SAME owner resume its own workspace (the binding must not break reuse)', async () => {
      const workspaceTaskId = 'ticket-uuid-under-test';
      const { handler, createTask, processMessage } = harness({
        existing: { id: workspaceTaskId, userSub: OWNER_A },
      });

      const result = await handler(envelope({ workspaceTaskId, userSub: OWNER_A }));

      expect(result).toMatchObject({ success: true });
      // Reuse, not re-create — and the LLM path does run for the rightful owner.
      expect(createTask).not.toHaveBeenCalled();
      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(processMessage.mock.calls[0][0]).toBe(workspaceTaskId);
    });
  });

  describe('owner stamping on creation (what makes the next dispatch checkable)', () => {
    it('threads the caller sub into createTask alongside the workspace folder id', async () => {
      const workspaceTaskId = 'brand-new-ticket-uuid';
      const { handler, createTask } = harness({ existing: null });

      await handler(envelope({ workspaceTaskId, userSub: OWNER_A }));

      // Dropping userSub here would leave every workspace unowned, so the assert above
      // could never fire on a later dispatch — the binding would be silently dead.
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask.mock.calls[0][2]).toEqual({ forceTaskId: workspaceTaskId, userSub: OWNER_A });
    });

    it('stamps no owner for a genuine system dispatch (ownerless stays ownerless)', async () => {
      const { handler, createTask } = harness({ existing: null });

      await handler(envelope({ workspaceTaskId: 'system-swarm-folder' }));

      expect(createTask.mock.calls[0][2]).toEqual({
        forceTaskId: 'system-swarm-folder',
        userSub: undefined,
      });
    });
  });

  describe('workspace folder id derivation (the directory two users could collide in)', () => {
    /**
     * The folder id is what `<root>/<folderId>` resolves to. On the swarm path the
     * controller sets `workspaceTaskId` to the ROOT TICKET UUID
     * (queue-manager-service.ts), and `tickets(external_provider, external_id)` carries a
     * UNIQUE index (ticket-schema.ts), so every fallback id is globally unique across
     * users too. Precedence changing — e.g. preferring a caller-supplied externalId over
     * the ticket UUID — is what would reopen a cross-user collision, so pin the order.
     */
    it('prefers workspaceTaskId, then originalTicket.externalId, then payload.externalId, then the correlation id', async () => {
      const cases: Array<{ payload: Record<string, unknown>; folder: string }> = [
        {
          payload: {
            workspaceTaskId: 'ws-id',
            externalId: 'ext-id',
            originalTicket: { externalId: 'orig-ext-id' },
          },
          folder: 'ws-id',
        },
        {
          payload: { externalId: 'ext-id', originalTicket: { externalId: 'orig-ext-id' } },
          folder: 'orig-ext-id',
        },
        { payload: { externalId: 'ext-id' }, folder: 'ext-id' },
        { payload: {}, folder: 'swarm-owner-binding-correlation' },
      ];

      for (const { payload, folder } of cases) {
        const { handler, createTask } = harness({ existing: null });
        await handler(envelope({ ...payload, userSub: OWNER_A }));
        expect(createTask.mock.calls[0][2]).toMatchObject({ forceTaskId: folder });
      }
    });

    it('gives two different tickets two different folders for the same owner', async () => {
      const folders: string[] = [];
      for (const workspaceTaskId of ['ticket-one', 'ticket-two']) {
        const { handler, createTask } = harness({ existing: null });
        await handler(envelope({ workspaceTaskId, userSub: OWNER_A }));
        folders.push((createTask.mock.calls[0][2] as { forceTaskId: string }).forceTaskId);
      }
      expect(folders[0]).not.toBe(folders[1]);
    });
  });

  describe('exact owner parity across the TS handler and the any-bot JS controller', () => {
    /**
     * The handler normalizes the dispatch sub (normalizeBotNodeUserSub) and the any-bot
     * controller normalizes the PERSISTED sub (normalizeTaskOwner). The owner comparison
     * spans both. If they ever disagree — one trimming, one not; one truncating at a
     * different length; one lowercasing — the check either false-matches (cross-user
     * access) or false-mismatches (every resume breaks). Pin that they agree.
     */
    const VALID_INPUTS: unknown[] = [
      OWNER_A,
      OWNER_B,
      ' padded-sub ',
      '../../etc/passwd',
      '/absolute/path/sub',
      '..',
      'unicode-sübé-é',
      '   ',
      null,
      undefined,
    ];

    it('produces the same exact owner string (or absent owner) for every valid input', () => {
      for (const input of VALID_INPUTS) {
        const ts = normalizeBotNodeUserSub(input);
        const js = TaskController.normalizeTaskOwner(input);
        // undefined (TS "absent") and null (JS "absent") are the same state.
        expect(ts ?? null, `input=${String(input)}`).toBe(js);
      }
    });

    it('rejects the same invalid supplied assertions in both runtimes', () => {
      const invalid = ['', 'control\u0000alias', 'control\u0085alias', 'x'.repeat(513), '\ud800', 42, {}];
      for (const input of invalid) {
        expect(() => normalizeBotNodeUserSub(input), `TS input=${String(input)}`).toThrow(/exact UTF-8/);
        expect(() => TaskController.normalizeTaskOwner(input), `JS input=${String(input)}`).toThrow(/exact UTF-8/);
      }
    });

    it('keeps traversal-shaped and unicode subs distinct instead of folding them together', () => {
      // The sub is no longer a path segment, but it IS the ownership key. A normalizer
      // that stripped/collapsed these (an easy "sanitize for the filesystem" mistake)
      // would map distinct users onto one owner — worse than the layout it protected.
      const tricky = ['../../etc/passwd', '/absolute/path/sub', '..', 'unicode-sübé-é', OWNER_A];
      const owners = tricky.map((value) => normalizeBotNodeUserSub(value));
      expect(new Set(owners).size).toBe(tricky.length);
      for (const owner of owners) expect(owner).toBeTruthy();
    });

    it('keeps whitespace as an exact owner and rejects empty input before task lookup', async () => {
      expect(normalizeBotNodeUserSub('   ')).toBe('   ');
      expect(() => normalizeBotNodeUserSub('')).toThrow(/non-empty/);
      const { handler, processMessage } = harness({
        existing: { id: 'owned-folder', userSub: OWNER_A },
      });
      const result = await handler(envelope({ workspaceTaskId: 'owned-folder', userSub: '   ' }));
      expect(result).toMatchObject({ success: false, error: 'Task owner mismatch' });
      expect(processMessage).not.toHaveBeenCalled();
    });
  });
});
