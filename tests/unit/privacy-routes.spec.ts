/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Covered owner identity-label export/erasure and audio receipt deletion.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covered owner-scoped Jarvis task and visual artifact export/erasure.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMessageStore } from '../../src/entities/message';
import { InMemoryTaskStore } from '../../src/entities/task';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { createPrivacyRoutes, PRIVACY_DELETE_CONFIRMATION } from '../../src/app/routes/privacy-routes';

const ENV_KEYS = ['DATABASE_URL', 'PGHOST', 'POSTGRES_HOST'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('privacy export/delete routes', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  it('exports only the authenticated caller data', async () => {
    const fixture = await createFixture('auth0|user-a');

    const response = await fetch(`${fixture.baseUrl}/api/privacy/export`);
    const body = await response.json() as PrivacyExportBody;

    expect(response.status).toBe(200);
    expect(body.subject.sub).toBe('auth0|user-a');
    expect(body.counts.tasks).toBe(1);
    expect(body.counts.messages).toBe(1);
    expect(body.counts.tickets).toBe(1);
    expect(body.tasks.map((task) => task.taskId)).toEqual([fixture.userATaskId]);
    expect(body.tickets.map((ticket) => ticket.title)).toEqual(['User A ticket']);
    expect(JSON.stringify(body)).not.toContain('User B');
    expect(JSON.stringify(body)).not.toContain('hidden from A');
  });

  it('requires confirmation and deletes only authenticated caller operational data', async () => {
    const fixture = await createFixture('auth0|user-a');

    const missingConfirm = await fetch(`${fixture.baseUrl}/api/privacy/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete' }),
    });
    expect(missingConfirm.status).toBe(400);

    const deleted = await fetch(`${fixture.baseUrl}/api/privacy/me`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: PRIVACY_DELETE_CONFIRMATION }),
    });
    const deleteBody = await deleted.json() as {
      deleted: {
        tasks: number; messages: number; tickets: number; jarvisTasks: number;
        visualResponseArtifacts: number; ephemeralJarvisAnswers: number;
      };
    };
    expect(deleted.status).toBe(200);
    expect(deleteBody.deleted).toEqual({
      tasks: 1, messages: 1, tickets: 1, jarvisTasks: 0, visualResponseArtifacts: 0,
      ephemeralJarvisAnswers: 0,
    });

    const exportAfterDelete = await fetch(`${fixture.baseUrl}/api/privacy/export`);
    const afterBody = await exportAfterDelete.json() as PrivacyExportBody;
    expect(afterBody.counts.tasks).toBe(0);
    expect(afterBody.counts.messages).toBe(0);
    expect(afterBody.counts.tickets).toBe(0);

    expect(await fixture.taskStore.get(fixture.userBTaskId)).toBeTruthy();
    expect(await fixture.messageStore.getByTask(fixture.userBTaskId)).toHaveLength(1);
    const userBTickets = await fixture.ticketService.listTickets({ ownerSub: 'auth0|user-b' });
    expect(userBTickets.map((ticket) => ticket.title)).toEqual(['User B ticket']);
  });

  it('exports ambient metadata without biometric ciphertext and erases every owner speaker table', async () => {
    const ambient = ambientPool();
    const fixture = await createFixture('auth0|user-a', ambient.pool);

    const exported = await fetch(`${fixture.baseUrl}/api/privacy/export`);
    const body = await exported.json() as PrivacyExportBody & {
      ambient: {
        transcriptSegments: Array<{ text: string }>;
        speakerProfiles: Array<{ profileId: string }>;
        speakerAssignments: Array<{ customName: string }>;
        speakerObservations: Array<{ clientChunkId: string }>;
        speakerTargetReferences: Array<{ tenantId: string }>;
        membershipDisplayNames: Array<{ tenantId: string; displayName: string }>;
        sensitiveFieldsOmitted: string[];
      };
    };
    expect(body.ambient.transcriptSegments[0].text).toBe('private ambient words');
    expect(body.ambient.speakerProfiles[0].profileId).toBe('profile-a');
    expect(body.ambient.speakerAssignments[0].customName).toBe('the operator');
    expect(body.ambient.speakerObservations[0].clientChunkId).toBe('chunk-a');
    expect(body.ambient.speakerTargetReferences[0].tenantId).toBe('tenant-a');
    expect(body.ambient.membershipDisplayNames).toEqual([
      { tenantId: 'tenant-a', displayName: 'oshal maintainers' },
    ]);
    expect(body.ambient.sensitiveFieldsOmitted).toContain('speakerProfiles.embeddingCiphertext');
    expect(JSON.stringify(body.ambient)).not.toContain('ciphertext-secret');

    const deleted = await fetch(`${fixture.baseUrl}/api/privacy/me`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: PRIVACY_DELETE_CONFIRMATION }),
    });
    const deleteBody = await deleted.json() as {
      ambientDeleted: {
        speakerProfiles: number;
        transcriptSegments: number;
        audioChunkReceipts: number;
        membershipDisplayNamesCleared: number;
        speakerObservations: number;
        targetSpeakerReferences: number;
      };
    };
    expect(deleteBody.ambientDeleted).toMatchObject({
      speakerProfiles: 1,
      transcriptSegments: 1,
      audioChunkReceipts: 1,
      membershipDisplayNamesCleared: 1,
      speakerObservations: 1,
      targetSpeakerReferences: 1,
    });
    for (const table of [
      'ambient_daily_reviews', 'ambient_transcript_segments', 'ambient_speaker_assignments',
      'ambient_speaker_profiles', 'ambient_speaker_ordinal_counters', 'ambient_audio_chunk_receipts',
      'ambient_speaker_observations',
      'ambient_user_settings',
    ]) expect(ambient.deletes.some((sql) => sql.includes(`DELETE FROM ${table}`))).toBe(true);
    expect(ambient.identityClears).toHaveLength(1);
  });

  it('exports and erases only the caller-owned Jarvis tasks and visual artifacts', async () => {
    const jarvis = jarvisPool();
    const fixture = await createFixture('auth0|user-a', jarvis.pool);

    const exported = await fetch(`${fixture.baseUrl}/api/privacy/export`);
    const body = await exported.json() as PrivacyExportBody & {
      counts: PrivacyExportBody['counts'] & { jarvisTasks: number; visualResponseArtifacts: number };
      jarvis: {
        tasks: Array<{ id: string; title: string }>;
        visualResponseArtifacts: Array<{ artifactId: string; contentBase64: string; provenance: { factLocked: boolean } }>;
      };
    };
    expect(exported.status).toBe(200);
    expect(body.counts.jarvisTasks).toBe(1);
    expect(body.counts.visualResponseArtifacts).toBe(1);
    expect(body.jarvis.tasks).toEqual([{ id: 'jarvis-task-a', title: 'Private Jarvis task' }]);
    expect(body.jarvis.visualResponseArtifacts[0]).toMatchObject({
      artifactId: 'artifact-a', contentBase64: 'PHN2Zy8+', provenance: { factLocked: true },
    });
    expect(JSON.stringify(body.jarvis)).not.toContain('artifact-b');

    const deleted = await fetch(`${fixture.baseUrl}/api/privacy/me`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: PRIVACY_DELETE_CONFIRMATION }),
    });
    const deleteBody = await deleted.json() as {
      deleted: { jarvisTasks: number; visualResponseArtifacts: number };
    };
    expect(deleted.status).toBe(200);
    expect(deleteBody.deleted).toMatchObject({ jarvisTasks: 1, visualResponseArtifacts: 1 });
    expect(jarvis.deletes.some((sql) => sql.includes('DELETE FROM jarvis_tasks WHERE user_sub=$1'))).toBe(true);
    expect(jarvis.deletes.some((sql) => sql.includes('DELETE FROM visual_response_artifacts WHERE user_sub=$1'))).toBe(true);
  });

  async function createFixture(sub: string, pool = fakePool()) {
    const taskStore = new InMemoryTaskStore();
    const messageStore = new InMemoryMessageStore();
    const ticketService = new TicketService(new InMemoryTicketStore());

    const userATask = await taskStore.create({
      title: 'User A task',
      processingMode: 'agentic',
      ownerSub: 'auth0|user-a',
    });
    const userBTask = await taskStore.create({
      title: 'User B task',
      processingMode: 'agentic',
      ownerSub: 'auth0|user-b',
    });
    await messageStore.save({ taskId: userATask.taskId, role: 'user', type: 'task', text: 'visible to A' });
    await messageStore.save({ taskId: userBTask.taskId, role: 'user', type: 'task', text: 'hidden from A' });
    await ticketService.createTicket({
      title: 'User A ticket',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'auth0|user-a',
    });
    await ticketService.createTicket({
      title: 'User B ticket',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'auth0|user-b',
    });

    const app = express();
    app.use(express.json());
    app.use(mockOidc(sub));
    app.use('/api/privacy', createPrivacyRoutes({
      taskStore,
      messageStore,
      ticketService,
      pool,
    } as never));

    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      taskStore,
      messageStore,
      ticketService,
      userATaskId: userATask.taskId,
      userBTaskId: userBTask.taskId,
    };
  }
});

type PrivacyExportBody = {
  subject: { sub: string };
  counts: { tasks: number; messages: number; tickets: number; auditEvents: number };
  tasks: Array<{ taskId: string; title: string }>;
  tickets: Array<{ ticketId: string; title: string }>;
};

function mockOidc(sub: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test` },
    };
    next();
  };
}

function jarvisPool() {
  const deletes: string[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (values?.length) expect(values[0]).toBe('auth0|user-a');
    if (sql.includes("to_regclass('ambient_speaker_assignments')")) {
      return { rows: [{ assignments: null }], rowCount: 1 };
    }
    if (sql.includes('FROM jarvis_tasks') && sql.startsWith('SELECT')) {
      return { rows: [{ id: 'jarvis-task-a', title: 'Private Jarvis task' }], rowCount: 1 };
    }
    if (sql.includes('FROM visual_response_artifacts') && sql.startsWith('SELECT')) {
      return {
        rows: [{
          artifactId: 'artifact-a', contentBase64: 'PHN2Zy8+',
          provenance: { factLocked: true },
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('DELETE FROM jarvis_tasks') || sql.startsWith('DELETE FROM visual_response_artifacts')) {
      deletes.push(sql);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) }, deletes };
}

function fakePool() {
  const query = async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) };
}

function ambientPool() {
  const deletes: string[] = [];
  const identityClears: string[] = [];
  const query = async (sql: string, values?: unknown[]) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
      if (sql.includes('ambient_') && values?.length) expect(values[0]).toBe('auth0|user-a');
      if (sql.includes("to_regclass('ambient_speaker_assignments')")) {
        return { rows: [{ assignments: 'ambient_speaker_assignments' }], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM ambient_')) {
        deletes.push(sql);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE oshal_tenant_memberships SET display_name=NULL')) {
        expect(values?.[0]).toBe('auth0|user-a');
        identityClears.push(sql);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM oshal_tenant_memberships')) {
        expect(values?.[0]).toBe('auth0|user-a');
        return { rows: [{ tenantId: 'tenant-a', displayName: 'oshal maintainers' }], rowCount: 1 };
      }
      if (sql.includes('speaker_diarization_enabled AS')) {
        return { rows: [{ speakerDiarizationEnabled: true, rememberSpeakers: true }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_user_settings')) {
        return { rows: [{ assistantName: 'Jarvis', ambientEnabled: true }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_transcript_segments')) {
        return { rows: [{ segmentId: 'segment-a', text: 'private ambient words' }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_daily_reviews')) {
        return { rows: [{ reviewId: 'review-a', summary: 'private summary' }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_speaker_profiles')) {
        return { rows: [{ profileId: 'profile-a', ordinal: 1 }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_speaker_observations')) {
        return { rows: [{ clientChunkId: 'chunk-a', speakerKey: 'SPEAKER_00' }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_speaker_assignments WHERE member_sub=$1')) {
        return { rows: [{ tenantId: 'tenant-a', assignedAt: '2026-07-09T23:00:00.000Z' }], rowCount: 1 };
      }
      if (sql.includes('FROM ambient_speaker_assignments')) {
        return { rows: [{ profileId: 'profile-a', kind: 'custom', customName: 'the operator' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool, deletes, identityClears };
}
