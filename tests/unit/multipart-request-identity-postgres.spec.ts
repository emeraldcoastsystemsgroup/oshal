/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for multipart uploads losing the RLS request identity (docs/BACKLOG.md, 2026-09-14). Each core multer route whose post-upload handler writes through the GUC pool is driven over REAL loopback HTTP with its REAL router and REAL multer; the multipart body is written in 64 KB chunks with gaps so the parser finishes on a LATER socket chunk than the one the identity middleware ran on. The boundary that failed runs for real end to end: the server.ts identity middleware shape (runWithRequestIdentity -> next), multer streaming, the production GUC pool wrapper, and PostgreSQL row-level security evaluated for the real NOBYPASSRLS enforcing role (oshal_app) under OSHAL_DB_GUC_STRICT=deny. The fixture database is created and dropped by this spec on a loopback cluster; the operator's `oshal` database is never written. Doubled, and outside the boundary: the domain service each handler calls (RAG ingest, the knowledge-memory record, the swarm-app loader, the ambient receipt store and diarization orchestrator, the agent-profile repository). Each double performs the handler's owner-scoped write as a real INSERT through the real GUC pool into a FORCE-RLS probe table carrying the live owner-or-operator policy, and the probe's defaults record the identity PostgreSQL itself saw.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

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
import { specDatabaseUrl } from '../helpers/spec-database-url';

/** Same convention as the other enforcing-role specs: a cluster the run names, never a default. */
const ADMIN_DSN = specDatabaseUrl(['OSHAL_TEST_DSN']);

/** Home admission is not this suite's boundary: discovery always admits, so nothing here changes shape. */
const admitEveryApplication = {
  canDiscover: async () => true,
  resolveActor: async () => ({ sub: 'route-fixture-subject', issuer: 'https://route.fixture.test', isActive: true, isSwarmAdmin: false }),
};
const ENFORCING_ROLE = 'oshal_app';
const FIXTURE_DB = `oshal_multipart_identity_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const OWNER = 'auth0|multipart-owner';
const OPERATOR = 'auth0|multipart-operator';
const AGENT_ID = 'a0000000-0000-0000-0000-00000000c0de';
/** Several socket writes with gaps: the parser cannot finish on the chunk the identity ran on. */
const CHUNK_BYTES = 64 * 1024;
const GAP_MS = 10;
/** 768 KB: twelve chunks, and under the smallest route limit (swarm-app manifests cap at 1 MB). */
const UPLOAD_BYTES = 768 * 1024;

/** The live `ambient_speaker_*_owner_or_operator` policy, verbatim, on a FORCE-RLS probe table. */
const PROBE_DDL = `
  CREATE TABLE multipart_identity_probe (
    id BIGSERIAL PRIMARY KEY,
    route TEXT NOT NULL,
    owner_sub TEXT NOT NULL,
    stamped_sub TEXT NOT NULL DEFAULT coalesce(current_setting('oshal.current_sub', true), ''),
    stamped_operator TEXT NOT NULL DEFAULT coalesce(current_setting('oshal.is_operator', true), '')
  );
  ALTER TABLE multipart_identity_probe OWNER TO ${ENFORCING_ROLE};
  ALTER TABLE multipart_identity_probe ENABLE ROW LEVEL SECURITY;
  ALTER TABLE multipart_identity_probe FORCE ROW LEVEL SECURITY;
  CREATE POLICY multipart_identity_probe_owner_or_operator ON multipart_identity_probe
    USING ((owner_sub = current_setting('oshal.current_sub', true)) OR (current_setting('oshal.is_operator', true) = 'on'))
    WITH CHECK ((owner_sub = current_setting('oshal.current_sub', true)) OR (current_setting('oshal.is_operator', true) = 'on'));
`;

let adminPool: Pool;
let fixtureAdmin: Pool;
let appPool: Pool;
let gucPool: Pool;
let server: http.Server;
let port = 0;
let actingSub: string = OWNER;
let fixtureCreated = false;
const scratchRoot = mkdtempSync(join(tmpdir(), 'oshal-multipart-identity-'));
const savedEnv = { strict: process.env.OSHAL_DB_GUC_STRICT, operators: process.env.OSHAL_OPERATOR_SUBS };

/** The fixture database's DSN on the same cluster; refuses anything but a loopback host. */
function fixtureDsn(): string {
  const url = new URL(ADMIN_DSN);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`refusing to create a fixture database on non-loopback host ${url.hostname}; point OSHAL_TEST_DSN at a local cluster`);
  }
  url.pathname = `/${FIXTURE_DB}`;
  return url.toString();
}

/** Create the throwaway database, the probe table owned by the enforcing role, and the GUC pool. */
async function openFixture(): Promise<void> {
  adminPool = new Pool({ connectionString: ADMIN_DSN, max: 1, connectionTimeoutMillis: 5_000 });
  const role = await adminPool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ENFORCING_ROLE]);
  if (role.rowCount !== 1) {
    throw new Error(`enforcing role ${ENFORCING_ROLE} is missing on this cluster; provision it with docs/governance/app-role-provisioning.sql`);
  }
  await adminPool.query(`CREATE DATABASE ${FIXTURE_DB}`);
  fixtureCreated = true;
  fixtureAdmin = new Pool({ connectionString: fixtureDsn(), max: 1 });
  await fixtureAdmin.query(PROBE_DDL);
  // The session starts AS the enforcing role, exactly the production posture; the self-check
  // below proves it is neither superuser nor RLS-bypassing before any route case can pass.
  appPool = new Pool({ connectionString: fixtureDsn(), max: 6, options: `-c role=${ENFORCING_ROLE}` });
  gucPool = wrapPoolWithGuc(appPool);
}

/** The owner-scoped write every handler's double performs, through the production GUC pool. */
async function probeWrite(route: string, ownerSub: string): Promise<void> {
  await gucPool.query('INSERT INTO multipart_identity_probe (route, owner_sub) VALUES ($1, $2)', [route, ownerSub]);
}

/** Probe rows as the superuser sees them (past RLS), including the identity Postgres stamped. */
async function probeRows(route: string): Promise<Array<Record<string, string>>> {
  const { rows } = await fixtureAdmin.query(
    'SELECT owner_sub, stamped_sub, stamped_operator FROM multipart_identity_probe WHERE route = $1 ORDER BY id',
    [route],
  );
  return rows;
}

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

/** Every affected router at its production mount path, behind the production identity shape. */
async function startServer(): Promise<void> {
  const rag = ragDoubles();
  const app = express();
  app.use(signedIn, requestIdentity);
  app.use('/api/rag', createRagRoutes(rag.ingest, rag.memory, gucPool));
  app.use('/api/swarm/apps', createSwarmAppRoutes(swarmAppDouble(), undefined, { authorization: admitEveryApplication }));
  app.use('/api/jarvis/ambient', createAmbientSpeakerRoutes({ pool: gucPool }, ambientDoubles()));
  app.use('/api/agents', createAgentProfileRoutes(agentProfileController()));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

interface MultipartBody { boundary: string; body: Buffer }
interface FilePart { field: string; name: string; type: string; bytes: Buffer }

/** One multipart/form-data body: text fields first, then a single binary file part. */
function multipart(fields: Record<string, string>, file: FilePart): MultipartBody {
  const boundary = `----oshal-multipart-${randomUUID()}`;
  const text = Object.entries(fields)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');
  const head = Buffer.from(`${text}--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; `
    + `filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  return { boundary, body: Buffer.concat([head, file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

/** POST the body in several socket writes with gaps, the way a browser streams a real upload. */
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
  await openFixture();
  await startServer();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool?.end();
  await fixtureAdmin?.end();
  if (fixtureCreated) await adminPool.query(`DROP DATABASE IF EXISTS ${FIXTURE_DB} WITH (FORCE)`);
  await adminPool?.end();
  rmSync(scratchRoot, { recursive: true, force: true });
  if (savedEnv.strict === undefined) delete process.env.OSHAL_DB_GUC_STRICT;
  else process.env.OSHAL_DB_GUC_STRICT = savedEnv.strict;
  if (savedEnv.operators === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = savedEnv.operators;
}, 60_000);

describe('multipart uploads keep the caller\'s RLS identity (real PostgreSQL, enforcing role)', () => {
  it('the fixture can go red: the GUC pool runs as NOBYPASSRLS oshal_app and RLS refuses an identity-less owner write', async () => {
    const posture = await runWithRequestIdentity({ sub: OWNER, isOperator: false }, () => gucPool.query(
      'SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user',
    ));
    expect(posture.rows[0]).toEqual({ role: ENFORCING_ROLE, superuser: false, bypass: false });
    await expect(probeWrite('fixture', OWNER)).rejects.toThrow(/row-level security policy/);
    await runWithRequestIdentity({ sub: OWNER, isOperator: false }, () => probeWrite('fixture', OWNER));
    expect(await probeRows('fixture')).toEqual([{ owner_sub: OWNER, stamped_sub: OWNER, stamped_operator: 'off' }]);
  });

  it('POST /api/rag/upload records the knowledge document as the uploader', async () => {
    actingSub = OWNER;
    const text = Buffer.from('a line of uploaded knowledge\n'.repeat(Math.ceil(UPLOAD_BYTES / 29))).subarray(0, UPLOAD_BYTES);
    const res = await postChunked('/api/rag/upload', multipart(
      { collection: 'multipart-probe' }, { field: 'files', name: 'notes.txt', type: 'text/plain', bytes: text },
    ));
    expect(res.status, String(res.body)).toBe(200);
    expect(await probeRows('rag-upload')).toEqual([{ owner_sub: OWNER, stamped_sub: OWNER, stamped_operator: 'off' }]);
  });

  it('POST /api/swarm/apps/import registers the manifest as its importer', async () => {
    actingSub = OWNER;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(scratchRoot); // the route writes <cwd>/swarm-apps/
    try {
      const res = await postChunked('/api/swarm/apps/import', multipart({}, {
        field: 'manifest', name: 'multipart-probe.yaml', type: 'application/x-yaml', bytes: Buffer.alloc(UPLOAD_BYTES, 0x23),
      }));
      expect(res.status, String(res.body)).toBe(201);
    } finally {
      cwd.mockRestore();
    }
    expect(existsSync(join(scratchRoot, 'swarm-apps', 'multipart-probe.yaml'))).toBe(true);
    expect(await probeRows('swarm-app-import')).toEqual([{ owner_sub: OWNER, stamped_sub: OWNER, stamped_operator: 'off' }]);
  });

  it('POST /api/jarvis/ambient/audio claims the audio receipt as the speaker-data owner', async () => {
    actingSub = OWNER;
    const res = await postChunked('/api/jarvis/ambient/audio', multipart({
      purpose: 'ambient', clientChunkId: 'multipart-chunk-1',
      capturedAt: '2026-09-14T12:00:00.000Z', endedAt: '2026-09-14T12:00:02.000Z',
    }, { field: 'audio', name: 'chunk.webm', type: 'audio/webm', bytes: Buffer.alloc(UPLOAD_BYTES, 1) }));
    expect(res.status, String(res.body)).toBe(201);
    expect(await probeRows('ambient-audio')).toEqual([{ owner_sub: OWNER, stamped_sub: OWNER, stamped_operator: 'off' }]);
  });

  it('POST /api/agents/:agentId/profile/avatar persists the avatar as the operator', async () => {
    actingSub = OPERATOR;
    const res = await postChunked(`/api/agents/${AGENT_ID}/profile/avatar`, multipart({}, {
      field: 'avatar', name: 'avatar.png', type: 'image/png', bytes: Buffer.alloc(UPLOAD_BYTES, 7),
    }));
    expect(res.status, String(res.body)).toBe(200);
    expect(await probeRows('agent-avatar')).toEqual([{ owner_sub: OPERATOR, stamped_sub: OPERATOR, stamped_operator: 'on' }]);
  });
});
