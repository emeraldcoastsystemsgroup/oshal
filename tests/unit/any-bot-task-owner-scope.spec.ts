import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const TaskController = requireModule('../../any-bot/server/controllers/TaskController.js') as {
  assertTaskOwnerBinding: (
    task: { userSub?: unknown },
    requestedUserSub?: unknown,
  ) => { userSub?: unknown };
  normalizeTaskOwner: (value: unknown) => string | null;
  prototype: {
    createTask(
      text: string,
      mode: string,
      options: { ticketId: string; userSub?: string },
    ): Promise<Record<string, unknown>>;
  };
};
const anyBotConfig = requireModule('../../any-bot/server/utils/config.js') as {
  filesystem: { workspaceDir: string };
};
const TaskStore = requireModule('../../any-bot/server/stores/TaskStore.js') as new (
  dbPath: string,
) => {
  init(): void;
  saveTask(task: Record<string, unknown>): Record<string, unknown>;
  loadTask(taskId: string): Record<string, unknown> | null;
  listTasks(): Array<Record<string, unknown>>;
  close(): void;
};
const SqliteDatabase = requireModule('better-sqlite3') as new (dbPath: string) => {
  exec(sql: string): void;
  close(): void;
};

function expectOwnerMismatch(taskUserSub: unknown, requestedUserSub?: unknown): void {
  try {
    TaskController.assertTaskOwnerBinding({ userSub: taskUserSub }, requestedUserSub);
  } catch (error) {
    expect(error).toMatchObject({ message: 'Task owner mismatch', code: 'TASK_OWNER_MISMATCH' });
    return;
  }
  throw new Error('Expected task owner mismatch');
}

describe('any-bot durable task owner binding', () => {
  it('allows only the same normalized owner, including anonymous legacy task reuse', () => {
    const owned = { userSub: ' owner-a ' };
    expect(TaskController.assertTaskOwnerBinding(owned, 'owner-a')).toBe(owned);

    const anonymousLegacy = { userSub: null };
    expect(TaskController.assertTaskOwnerBinding(anonymousLegacy, undefined)).toBe(anonymousLegacy);
    expect(TaskController.normalizeTaskOwner('  owner-a  ')).toBe('owner-a');
    expect(TaskController.normalizeTaskOwner('   ')).toBeNull();
  });

  it('fails closed across owned, ownerless, and anonymous identity boundaries', () => {
    expectOwnerMismatch('owner-a', 'owner-b');
    expectOwnerMismatch('owner-a', undefined);
    expectOwnerMismatch(null, 'owner-a');
  });

  it('enforces the binding inside TaskController ticket-workspace reuse', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oshal-controller-owner-'));
    const ticketId = 'shared-ticket';
    const previousWorkspaceDir = anyBotConfig.filesystem.workspaceDir;
    mkdirSync(join(directory, ticketId));
    anyBotConfig.filesystem.workspaceDir = directory;
    const controller = Object.create(TaskController.prototype) as {
      taskStore: { loadTask(taskId: string): Promise<Record<string, unknown>> };
      createTask: typeof TaskController.prototype.createTask;
    };
    controller.taskStore = {
      loadTask: async () => ({ id: ticketId, userSub: 'owner-a' }),
    };

    try {
      await expect(controller.createTask('Reuse', 'act', {
        ticketId,
        userSub: 'owner-b',
      })).rejects.toMatchObject({ code: 'TASK_OWNER_MISMATCH' });
    } finally {
      anyBotConfig.filesystem.workspaceDir = previousWorkspaceDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migrates a legacy database and retains bindings after closing and reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'oshal-task-owner-'));
    const dbPath = join(directory, 'tasks.db');
    const legacyDb = new SqliteDatabase(dbPath);
    legacyDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT DEFAULT 'act',
        workspace_dir TEXT,
        gitlab_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        api_metrics TEXT,
        progress TEXT,
        checkpoint_id TEXT
      );
      INSERT INTO tasks (id, text, status, mode, created_at, updated_at)
      VALUES ('legacy-task', 'Legacy anonymous', 'created', 'act', 2, 2);
    `);
    legacyDb.close();
    let store = new TaskStore(dbPath);

    try {
      store.init();
      store.saveTask({
        id: 'owned-task',
        text: 'Owned',
        status: 'created',
        mode: 'act',
        userSub: 'owner-a',
        ts: 1,
      });
      store.close();

      store = new TaskStore(dbPath);
      store.init();
      expect(store.loadTask('owned-task')).toMatchObject({ userSub: 'owner-a' });
      expect(store.loadTask('legacy-task')).toMatchObject({ userSub: null });
      expect(store.listTasks()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'owned-task', userSub: 'owner-a' }),
        expect.objectContaining({ id: 'legacy-task', userSub: null }),
      ]));
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
