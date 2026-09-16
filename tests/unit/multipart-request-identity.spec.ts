/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The RUNNABLE half of the multipart request-identity guard. Its real-PostgreSQL companion, tests/unit/multipart-request-identity-postgres.spec.ts, resolves its cluster through specDatabaseUrl and therefore THROWS at module load in every gate this repo has: nothing sets OSHAL_TEST_DSN, so that file reports "Tests no tests" and cannot tell a re-bind regression from a healthy tree. This spec crosses the boundary that actually failed - the caller's AsyncLocalStorage identity being lost across multer's asynchronous completion - with real loopback HTTP, a body streamed in 64 KB chunks with gaps, the four production routers and their real multer parsers, the server.ts identity-middleware shape, and the real production GUC pool wrapper, which is the code that turns the request identity into the oshal.current_sub / oshal.is_operator stamp PostgreSQL receives. Only the pg driver is doubled: a recording pool captures the stamp each statement would have carried. It is deliberately NOT evidence that row-level security refuses an identity-less write - that claim belongs to the PostgreSQL companion and needs a real enforcing role.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import multer from 'multer';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { createRagRoutes } from '@/app/routes/rag-routes';
import { createSwarmAppRoutes } from '@/app/routes/swarm-app-routes';
import { createAmbientSpeakerRoutes, type AmbientSpeakerRouteOptions } from '@/app/routes/ambient-speaker-routes';
import { createAgentProfileRoutes } from '@/app/routes/agent-profile-routes';
import { AgentProfileController, AgentProfileService } from '@/features/agent-profile';

/** Home admission is not this suite's boundary: discovery always admits, so nothing here changes shape. */
const admitEveryApplication = {
  canDiscover: async () => true,
  resolveActor: async () => ({ sub: 'route-fixture-subject', issuer: 'https://route.fixture.test', isActive: true, isSwarmAdmin: false }),
};
const OWNER = 'auth0|multipart-owner';
const OPERATOR = 'auth0|multipart-operator';
const AGENT_ID = 'a0000000-0000-0000-0000-00000000c0de';
/** Several socket writes with gaps: the parser cannot finish on the chunk the identity ran on. */
const CHUNK_BYTES = 64 * 1024;
const GAP_MS = 10;
/** 768 KB: twelve chunks, and under the smallest route limit (swarm-app manifests cap at 1 MB). */
const UPLOAD_BYTES = 768 * 1024;
/** The stamp the production wrapper writes when NO identity is in scope under strict deny. */
const ANONYMOUS = { sub: '', operator: 'off' };

interface Stamp { sub: string; operator: string }
interface Executed extends Stamp { sql: string; values: unknown[] }

/** Every application statement the routers issued, with the identity stamp it would have carried. */
const executed: Executed[] = [];

/**
 * @description A recording stand-in for the pg driver. The REAL `wrapPoolWithGuc` proxies this, so
 * the `set_config` statements recorded here are the production wrapper's own output for whatever
 * identity was in scope when the statement ran. Infrastructure statements (the stamp, the reset,
 * the ambient advisory lock) are answered so the routers run unchanged; anything else is recorded
 * as an application statement together with the stamp its connection was carrying.
 * @returns A Pool-shaped object suitable for {@link wrapPoolWithGuc}.
 */
function recordingPool(): Pool {
  const connect = async () => {
    let stamp: Stamp = { sub: '<never stamped>', operator: '<never stamped>' };
    return {
      query: async (text: unknown, values?: unknown[]) => {
        const sql = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
        if (sql.includes('set_config')) {
          stamp = values && values.length >= 2
            ? { sub: String(values[0]), operator: String(values[1]) }
            : {
              sub: /set_config\('oshal\.current_sub',\s*'([^']*)'/.exec(sql)?.[1] ?? '',
              operator: /set_config\('oshal\.is_operator',\s*'([^']*)'/.exec(sql)?.[1] ?? '',
            };
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith('RESET ')) return { rows: [], rowCount: 0 };
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }], rowCount: 1 };
        executed.push({ sql, values: values ?? [], ...stamp });
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
  };
  return { connect, query: async () => ({ rows: [], rowCount: 0 }), end: async () => undefined } as unknown as Pool;
}

const gucPool = wrapPoolWithGuc(recordingPool());

/**
 * @description The owner-scoped write every post-upload handler's double performs, issued through
 * the production GUC pool so the wrapper stamps it exactly as it would in the api.
 * @param route - The route label recorded with the statement.
 * @param ownerSub - The subject the handler believes owns the row.
 * @returns Nothing; the statement and its stamp land in {@link executed}.
 */
async function probeWrite(route: string, ownerSub: string): Promise<void> {
  await gucPool.query('INSERT INTO multipart_identity_probe (route, owner_sub) VALUES ($1, $2)', [route, ownerSub]);
}

/**
 * @description The identity PostgreSQL would have been given for a route's post-upload write.
 * @param route - The route label passed to {@link probeWrite}.
 * @returns The recorded stamp, or undefined when the route never reached the pool.
 */
function stampFor(route: string): Stamp | undefined {
  const row = executed.find((e) => e.values[0] === route);
  return row && { sub: row.sub, operator: row.operator };
}

let server: http.Server;
let port = 0;
let actingSub: string = OWNER;
const scratchRoot = mkdtempSync(join(tmpdir(), 'oshal-multipart-identity-'));
const savedEnv = { strict: process.env.OSHAL_DB_GUC_STRICT, operators: process.env.OSHAL_OPERATOR_SUBS };

/** Sign-in double: the ONLY thing standing in for the authentication rail. */
function signedIn(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { oidc?: unknown }).oidc = { user: { sub: actingSub }, isAuthenticated: () => true };
  next();
}

/** The identity middleware exactly as server.ts mounts it: the chain runs inside the caller's store. */
function requestIdentity(req: Request, _res: Response, next: NextFunction): void {
  runWithRequestIdentity({ sub: getCaller(req).sub, isOperator: isOperator(req) }, () => next());
}

/** RagService stays outside the boundary; the knowledge record is the owner-scoped write. */
function ragDoubles() {
  const ingest = { ingest: async () => ({ documentCount: 1, chunkCount: 1 }) };
  const memory = {
    recordKnowledgeDocument: async (input: { ownerSub?: string; collection: string }) => {
      await probeWrite('rag-upload', input.ownerSub ?? '');
      return { knowledgeId: randomUUID(), collection: input.collection };
    },
  };
  return { ingest: ingest as never, memory: memory as never };
}

/** SwarmAppService.loadApp upserts swarm_applications with the importer as owner. */
function swarmAppDouble() {
  return {
    loadApp: async (_manifestPath: string, options: { ownerSub: string | null }) => {
      await probeWrite('swarm-app-import', options.ownerSub ?? '');
      return { name: 'multipart-probe' };
    },
  } as never;
}

/** The ambient receipt claim (ambient_audio_chunk_receipts) is the first owner-scoped write. */
function ambientDoubles(): AmbientSpeakerRouteOptions {
  const settings = { ambientEnabled: true, speakerDiarizationEnabled: true, rememberSpeakers: false };
  const ambientService = {
    getSettings: async () => settings,
    claimAudioChunk: async (sub: string) => {
      await probeWrite('ambient-audio', sub);
      return { state: 'claimed' as const, claimToken: 'claim-1' };
    },
    completeAudioChunk: async () => undefined,
    releaseAudioChunk: async () => undefined,
    appendAttributedSegments: async () => ({ accepted: 0, duplicates: 0, segments: [] }),
  };
  const result = {
    source: 'sidecar_only', model: null, sttProviderId: null, durationSeconds: 2, timeline: [], turns: [],
    processing: { status: 'complete', transcription: 'unavailable', diarization: 'complete' },
  };
  return {
    ambientService: ambientService as unknown as AmbientSpeakerRouteOptions['ambientService'],
    store: { listProfiles: async () => [] } as unknown as AmbientSpeakerRouteOptions['store'],
    orchestrator: { process: async () => result } as unknown as AmbientSpeakerRouteOptions['orchestrator'],
  };
}

/** The real controller + service; only the repository's UPDATE is replaced by the probe write. */
function agentProfileController(): AgentProfileController {
  const profile = { agentId: AGENT_ID, name: 'multipart-probe-bot', status: 'active', providerId: 'noop', metadata: {} };
  const repository = {
    getAgentProfile: async () => profile,
    updateAgentProfile: async () => {
      await probeWrite('agent-avatar', OPERATOR);
      return profile;
    },
  };
  const service = new AgentProfileService({ repository: repository as never, recomposeSelector: async () => undefined });
  return new AgentProfileController(service, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
}

/**
 * @description The control route: the SAME real multer, mounted WITHOUT `preserveRequestIdentity`.
 * It keeps the defect itself executable, so a green suite proves the fixture can still SEE the
 * failure rather than proving the chunking no longer detaches the async context.
 * @returns A router whose single upload records the stamp its post-upload write would carry.
 */
function unwrappedRouter(): express.Router {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
  router.post('/upload', upload.single('file'), async (_req, res) => {
    await probeWrite('unwrapped-control', OWNER);
    res.json({ ok: true });
  });
  return router;
}

/** Every affected router at its production mount path, behind the production identity shape. */
async function startServer(): Promise<void> {
  const rag = ragDoubles();
  const app = express();
  app.use(signedIn, requestIdentity);
  app.use('/api/rag', createRagRoutes(rag.ingest, rag.memory, gucPool));
  app.use('/api/swarm/apps', createSwarmAppRoutes(swarmAppDouble(), undefined, { authorization: admitEveryApplication }));
  app.use('/api/jarvis/ambient', createAmbientSpeakerRoutes({ pool: gucPool }, ambientDoubles()));
  app.use('/api/agents', createAgentProfileRoutes(agentProfileController()));
  app.use('/api/unwrapped', unwrappedRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

interface MultipartBody { boundary: string; body: Buffer }
interface FilePart { field: string; name: string; type: string; bytes: Buffer }

/**
 * @description Build one multipart/form-data body: text fields first, then a single binary file.
 * @param fields - Text form fields the route reads from `req.body`.
 * @param file - The file part, its field name, filename, content type and bytes.
 * @returns The boundary and the complete encoded body.
 */
function multipartBody(fields: Record<string, string>, file: FilePart): MultipartBody {
  const boundary = `----oshal-multipart-${randomUUID()}`;
  const text = Object.entries(fields)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');
  const head = Buffer.from(`${text}--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; `
    + `filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  return { boundary, body: Buffer.concat([head, file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

/**
 * @description POST the body in several socket writes with gaps, the way a browser streams a real
 * upload — this is what makes multer finish on a LATER async context than the identity ran on.
 * @param path - Request path on the fixture server.
 * @param form - The encoded multipart body.
 * @returns The response status and raw body.
 */
function postChunked(path: string, form: MultipartBody): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path, agent: false,
      headers: { 'Content-Type': `multipart/form-data; boundary=${form.boundary}`, 'Content-Length': form.body.length },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject);
    let offset = 0;
    const writeNext = (): void => {
      if (offset >= form.body.length) { req.end(); return; }
      req.write(form.body.subarray(offset, offset + CHUNK_BYTES));
      offset += CHUNK_BYTES;
      setTimeout(writeNext, GAP_MS);
    };
    writeNext();
  });
}

beforeAll(async () => {
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  await startServer();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratchRoot, { recursive: true, force: true });
  if (savedEnv.strict === undefined) delete process.env.OSHAL_DB_GUC_STRICT;
  else process.env.OSHAL_DB_GUC_STRICT = savedEnv.strict;
  if (savedEnv.operators === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = savedEnv.operators;
}, 60_000);

describe('multipart uploads keep the caller request identity across the parser (real HTTP, real multer)', () => {
  it('the fixture can go red: the same chunked upload WITHOUT the re-bind reaches the pool anonymous', async () => {
    actingSub = OWNER;
    const res = await postChunked('/api/unwrapped/upload', multipartBody({}, {
      field: 'file', name: 'control.bin', type: 'application/octet-stream', bytes: Buffer.alloc(UPLOAD_BYTES, 9),
    }));
    expect(res.status, String(res.body)).toBe(200);
    expect(stampFor('unwrapped-control')).toEqual(ANONYMOUS);
  });

  it('POST /api/rag/upload stamps the knowledge document write as the uploader', async () => {
    actingSub = OWNER;
    const text = Buffer.from('a line of uploaded knowledge\n'.repeat(Math.ceil(UPLOAD_BYTES / 29))).subarray(0, UPLOAD_BYTES);
    const res = await postChunked('/api/rag/upload', multipartBody(
      { collection: 'multipart-probe' }, { field: 'files', name: 'notes.txt', type: 'text/plain', bytes: text },
    ));
    expect(res.status, String(res.body)).toBe(200);
    expect(stampFor('rag-upload')).toEqual({ sub: OWNER, operator: 'off' });
  });

  it('POST /api/swarm/apps/import stamps the manifest registration as its importer', async () => {
    actingSub = OWNER;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(scratchRoot); // the route writes <cwd>/swarm-apps/
    try {
      const res = await postChunked('/api/swarm/apps/import', multipartBody({}, {
        field: 'manifest', name: 'multipart-probe.yaml', type: 'application/x-yaml', bytes: Buffer.alloc(UPLOAD_BYTES, 0x23),
      }));
      expect(res.status, String(res.body)).toBe(201);
    } finally {
      cwd.mockRestore();
    }
    expect(stampFor('swarm-app-import')).toEqual({ sub: OWNER, operator: 'off' });
  });

  it('POST /api/jarvis/ambient/audio stamps the audio receipt claim as the speaker-data owner', async () => {
    actingSub = OWNER;
    const res = await postChunked('/api/jarvis/ambient/audio', multipartBody({
      purpose: 'ambient', clientChunkId: 'multipart-chunk-1',
      capturedAt: '2026-09-14T12:00:00.000Z', endedAt: '2026-09-14T12:00:02.000Z',
    }, { field: 'audio', name: 'chunk.webm', type: 'audio/webm', bytes: Buffer.alloc(UPLOAD_BYTES, 1) }));
    expect(res.status, String(res.body)).toBe(201);
    expect(stampFor('ambient-audio')).toEqual({ sub: OWNER, operator: 'off' });
  });

  it('POST /api/agents/:agentId/profile/avatar stamps the avatar write as the operator', async () => {
    actingSub = OPERATOR;
    const res = await postChunked(`/api/agents/${AGENT_ID}/profile/avatar`, multipartBody({}, {
      field: 'avatar', name: 'avatar.png', type: 'image/png', bytes: Buffer.alloc(UPLOAD_BYTES, 7),
    }));
    expect(res.status, String(res.body)).toBe(200);
    expect(stampFor('agent-avatar')).toEqual({ sub: OPERATOR, operator: 'on' });
  });
});
