/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted verbatim from tests/unit/jarvis-delayed-visual-lifecycle.integration.spec.ts (931 code lines, near the 1000-line cap) so the JVV-003 queue-backed lifecycle spec reuses the same Jarvis task/artifact SQL fake, owner-aware session task store, test user-auth rail and poll helper instead of a drifting copy. No behaviour change.
 */
import type { RequestHandler } from 'express';
import { vi } from 'vitest';

export interface StoredTask {
  id: string;
  user_sub: string;
  session_id: string;
  principal_issuer?: string | null;
  briefing_source_id?: string | null;
  title: string;
  status: string;
  result: string | null;
  error: string | null;
  kind: string;
  ticket_id: string | null;
  visual: Record<string, unknown> | null;
  files?: Record<string, unknown>[] | null;
  delivered: boolean;
  created_at: string;
  finished_at: string | null;
  summarize_started_at: string | null;
}

export interface StoredArtifact {
  artifact_id: string;
  mime_type: 'image/svg+xml';
  width: number;
  height: number;
  alt_text: string;
  content: Buffer;
  content_sha256: string;
  provenance: Record<string, unknown>;
  created_at: string;
  user_sub: string;
  source_surface: string;
  source_job_id: string;
}

export interface StoredMessage {
  taskId: string;
  role: 'user' | 'assistant';
  type: 'task' | 'say';
  text: string;
  metadata?: Record<string, unknown>;
}

export class DelayedLifecyclePool {
  readonly tasks = new Map<string, StoredTask>();
  readonly artifacts = new Map<string, StoredArtifact>();

  async query(sqlValue: string, values: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = String(sqlValue).replace(/\s+/g, ' ').trim();

    if (sql.startsWith('SELECT DISTINCT provider FROM oshal_connections')
      || sql.startsWith('SELECT preferred_provider, preferred_model FROM oshal_user_llm_prefs WHERE user_sub = $1')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT id, user_sub, session_id, ticket_id, briefing_source_id, principal_issuer, title, status, kind, result, created_at FROM jarvis_tasks WHERE user_sub = $1')) {
      const rows = [...this.tasks.values()]
        .filter((task) => task.user_sub === values[0])
        .map(({ id, user_sub, session_id, ticket_id, briefing_source_id, principal_issuer, title, status, kind, result, created_at }) => (
          { id, user_sub, session_id, ticket_id, briefing_source_id, principal_issuer, title, status, kind, result, created_at }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO jarvis_tasks')) {
      const [id, userSub, sessionId, title, status, kind, ticketId, issuer] = values.map((value) => value == null ? null : String(value));
      const previous = this.tasks.get(String(id));
      this.tasks.set(String(id), {
        id: String(id), user_sub: String(userSub), session_id: String(sessionId), title: String(title),
        principal_issuer: issuer, briefing_source_id: null,
        status: String(status), result: null, error: null, kind: String(kind), ticket_id: ticketId,
        visual: null, files: null, delivered: previous?.delivered ?? false,
        created_at: previous?.created_at ?? '2026-07-10T15:00:00.000Z', finished_at: null,
        summarize_started_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, user_sub, session_id, briefing_source_id, principal_issuer, title, status, result, error, kind, ticket_id, visual, files, delivered')) {
      const rows = [...this.tasks.values()].filter((task) => task.user_sub === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id, visual FROM jarvis_tasks WHERE user_sub = $1')) {
      // Match the production schema: jarvis_tasks.id is TEXT even when this bounded join happens
      // to contain UUID-shaped task ids. A UUID[] cast makes real Postgres reject text = uuid.
      if (!sql.includes('id = ANY($2::text[])')) {
        throw new Error('jarvis_tasks.id lookup must bind a text[] array');
      }
      const ids = new Set((values[1] as unknown[] || []).map(String));
      const rows = [...this.tasks.values()]
        .filter((task) => task.user_sub === values[0] && ids.has(task.id))
        .map((task) => ({ id: task.id, visual: task.visual }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE jarvis_tasks SET status = 'summarizing'")) {
      const task = this.tasks.get(String(values[0]));
      if (!task) return { rows: [], rowCount: 0 };
      task.status = 'summarizing';
      task.summarize_started_at = new Date().toISOString();
      return { rows: [{ id: task.id }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT session_id FROM jarvis_tasks')) {
      const task = this.tasks.get(String(values[0]));
      const rows = task && task.user_sub === values[1] ? [{ session_id: task.session_id }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE jarvis_tasks SET status = $2,')) {
      const task = this.tasks.get(String(values[0]));
      if (!task) return { rows: [], rowCount: 0 };
      task.status = String(values[1]);
      if (task.status === 'done') task.result = String(values[2]);
      else task.error = String(values[2]);
      task.visual = values[3] ? JSON.parse(String(values[3])) as Record<string, unknown> : null;
      // $5 is the captured-deliverables slot. Mirrored here (rather than ignored) so the fake pool
      // keeps modelling the real write: finishTask always sets it, and a null must overwrite a
      // previous run's files rather than leave them attached to a fresh result.
      task.files = values[4] ? JSON.parse(String(values[4])) as Record<string, unknown>[] : null;
      task.finished_at = new Date().toISOString();
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE jarvis_tasks SET visual = $3::jsonb')) {
      const task = this.tasks.get(String(values[0]));
      if (!task || task.user_sub !== values[1] || task.visual || task.status !== 'done') {
        return { rows: [], rowCount: 0 };
      }
      task.visual = JSON.parse(String(values[2])) as Record<string, unknown>;
      return { rows: [{ id: task.id }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE jarvis_tasks SET delivered = TRUE')) {
      const task = this.tasks.get(String(values[0]));
      if (task && task.user_sub === values[1]) task.delivered = true;
      return { rows: [], rowCount: task ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO visual_response_artifacts')) {
      const artifact: StoredArtifact = {
        artifact_id: String(values[0]), user_sub: String(values[1]), source_surface: String(values[2]),
        source_job_id: String(values[4]), mime_type: values[5] as 'image/svg+xml', width: Number(values[6]),
        height: Number(values[7]), alt_text: String(values[8]), content: values[9] as Buffer,
        content_sha256: String(values[10]), provenance: JSON.parse(String(values[11])) as Record<string, unknown>,
        created_at: '2026-07-10T15:05:00.000Z',
      };
      this.artifacts.set(artifact.artifact_id, artifact);
      return { rows: [{ artifact_id: artifact.artifact_id, created_at: artifact.created_at }], rowCount: 1 };
    }
    if (sql.includes('FROM visual_response_artifacts') && sql.includes('WHERE artifact_id = $1 AND user_sub = $2')) {
      const artifact = this.artifacts.get(String(values[0]));
      const rows = artifact && artifact.user_sub === values[1] ? [artifact] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM visual_response_artifacts') && sql.includes('source_job_id = $3')) {
      const artifact = [...this.artifacts.values()].find((item) => (
        item.user_sub === values[0] && item.source_surface === values[1] && item.source_job_id === values[2]
      ));
      return { rows: artifact ? [artifact] : [], rowCount: artifact ? 1 : 0 };
    }
    if (sql.includes('FROM swarm_applications') || sql.includes('FROM chat_tasks')) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unhandled delayed-lifecycle SQL: ${sql}`);
  }
}

/** Test-only user-auth rail mirroring the req.oidc shape produced by OIDC and PAT middleware. */
export const testUserAuth: RequestHandler = (req, res, next) => {
  const sub = req.header('x-test-authenticated-sub');
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  (req as unknown as { oidc: unknown }).oidc = {
    isAuthenticated: () => true,
    user: { sub },
  };
  next();
};

export function createOwnerAwareTaskStore(initial: Array<{ taskId: string; ownerSub: string }> = []) {
  const tasks = new Map(initial.map((task) => [task.taskId, { ...task }]));
  return {
    tasks,
    store: {
      get: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
      create: vi.fn(async (input: { taskId: string; ownerSub?: string }) => {
        const existing = tasks.get(input.taskId);
        if (existing) return existing;
        const created = { taskId: input.taskId, ownerSub: input.ownerSub || '' };
        tasks.set(input.taskId, created);
        return created;
      }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      incrementMessageCount: vi.fn().mockResolvedValue(undefined),
      incrementTurnCount: vi.fn().mockResolvedValue(undefined),
    },
  };
}

export async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for delayed Jarvis lifecycle state');
}
