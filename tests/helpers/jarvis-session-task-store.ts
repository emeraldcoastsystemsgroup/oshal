/**
 * The session task store a Jarvis `/ask` spec is allowed to hand `createJarvisRoutes`.
 *
 * `POST /api/jarvis/ask` refuses with 404 `session_not_found` unless BOTH halves of the ownership
 * gate agree: `ensureSessionTask` has to get an owner-bound task back from `ITaskStore.create`, and
 * `canReadJarvisSession` has to read that same task back out of `ITaskStore.get`. A hand-rolled
 * double that answers `undefined` to `create` and `null` to `get` forever cannot satisfy either, and
 * because the fake context is passed as `never` the compiler never says so. That is what left two
 * guards answering 404 with no explanation.
 *
 * So the honest double is the REAL store. `InMemoryTaskStore` reaches Postgres only when the
 * environment names one, so `createMemoryOnlyTaskStore` withholds that naming across construction:
 * the store is memory-backed by construction, cannot open a connection, and obeys the `ITaskStore`
 * contract because it IS the implementation of it. The refusal shapes below stay explicit doubles
 * (a store cannot be asked to hand back a foreign owner), but each is typed against `ITaskStore`
 * so a contract change breaks them at the type level instead of silently at runtime.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | One session-task store for the Jarvis /ask guards: the real InMemoryTaskStore with Postgres configuration withheld across construction (so no spec can reach a deployment's database), plus the typed refusal doubles the 404 branch needs — a store that hands back a foreign owner, one whose create throws, and one that forgets what it just created.
 */
import type { CreateTaskInput, StoredTask } from '@/shared/types';
import type { ITaskStore } from '@/entities/task';
import { InMemoryTaskStore } from '@/entities/task';

/** The env vars `createOptionalPostgresPool` consults; with none of them set the pool is null. */
const POSTGRES_ENV_KEYS = ['DATABASE_URL', 'PGHOST', 'POSTGRES_HOST'] as const;

/** The slice of `ITaskStore` the Jarvis `/ask` ownership gate actually calls. */
export type JarvisSessionTaskStore = Pick<
  ITaskStore,
  'get' | 'create' | 'updateStatus' | 'incrementMessageCount' | 'incrementTurnCount'
>;

/**
 * @description Build the real task store with Postgres configuration withheld for the length of the
 * constructor, so the store is memory-backed and holds no pool. A spec that uses it exercises the
 * shipped `create`/`get` contract — the one the ownership gate is written against — and still cannot
 * open a connection to a running deployment, whatever the runner's environment happens to carry.
 * @returns A memory-only task store obeying the shipped `ITaskStore` contract.
 */
export function createMemoryOnlyTaskStore(): InMemoryTaskStore {
  const saved = POSTGRES_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const [key] of saved) delete process.env[key];
  try {
    return new InMemoryTaskStore();
  } finally {
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
}

/**
 * @description The refusal a guessed session id has to produce: the store answers with a task that
 * belongs to somebody else, so `ensureSessionTask` must report that the caller does not own it.
 * @param ownerSub - The owner the store insists the session belongs to.
 * @returns A task store that always reports the session as foreign-owned.
 */
export function createForeignOwnerTaskStore(ownerSub: string): JarvisSessionTaskStore {
  const foreign = (taskId: string): StoredTask => buildStoredTask(taskId, ownerSub);
  return {
    get: async (taskId) => foreign(taskId),
    create: async (input: CreateTaskInput) => foreign(input.taskId ?? 'foreign-session'),
    updateStatus: async () => undefined,
    incrementMessageCount: async () => undefined,
    incrementTurnCount: async () => undefined,
  };
}

/**
 * @description The refusal an unavailable store has to produce: registration throws, so ownership is
 * UNDETERMINED rather than denied. The gate still fails closed; what the guard checks is that the
 * cause is reported instead of being swallowed into an unexplained 404.
 * @param error - The failure the store raises.
 * @returns A task store whose create rejects.
 */
export function createUnavailableTaskStore(error: Error): JarvisSessionTaskStore {
  return {
    get: async () => null,
    create: async () => { throw error; },
    updateStatus: async () => undefined,
    incrementMessageCount: async () => undefined,
    incrementTurnCount: async () => undefined,
  };
}

/**
 * @description The refusal a half-working store has to produce: `create` succeeds and owner-binds the
 * session, but the read-back never finds it, so `canReadJarvisSession` denies. This is the second
 * half of the gate and it fails with the same status as the first — the guard is what keeps the two
 * halves distinguishable.
 * @param ownerSub - The owner `create` binds the session to.
 * @returns A task store that writes the session but never reads it back.
 */
export function createAmnesiacTaskStore(ownerSub: string): JarvisSessionTaskStore {
  return {
    get: async () => null,
    create: async (input: CreateTaskInput) => buildStoredTask(input.taskId ?? 'amnesiac-session', ownerSub),
    updateStatus: async () => undefined,
    incrementMessageCount: async () => undefined,
    incrementTurnCount: async () => undefined,
  };
}

/** A minimal owner-bound `StoredTask` for the refusal doubles; the real store builds its own. */
function buildStoredTask(taskId: string, ownerSub: string): StoredTask {
  const now = new Date().toISOString();
  return {
    taskId,
    title: 'Jarvis chat',
    status: 'created',
    processingMode: 'agentic',
    messageCount: 0,
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalInputCost: 0,
    totalOutputCost: 0,
    totalCost: 0,
    totalRequests: 0,
    costCurrency: 'USD',
    usageByModel: {},
    metadata: { origin: 'jarvis-chat' },
    ownerSub,
    createdAt: now,
    updatedAt: now,
  };
}
