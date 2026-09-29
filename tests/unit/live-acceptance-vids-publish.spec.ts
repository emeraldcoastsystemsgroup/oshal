/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the vids-publish live-acceptance case's own logic over a doubled vids package (owner and anonymous route tables that keep jobs, export rows, files on disk and every token ever issued) and recording statement and file-probe ports: the mount gate's 401 on the job list and on a confirmed anonymous publish, exact public bytes, 404 for a malformed token and after revoke, then the export removed through the DELETE route, its MP4 proven gone, and exactly the tagged job deleted = pass. Red: a revoked link that still serves, a 401 from the package's own guard instead of the mount's gate, an anonymous publish that goes through, the wrong bytes, a served malformed token, media left on disk (a row cascade leaves the file), a file probe that never saw the export, a silent residue read. Unavailable without vids or its publication routes, writing nothing. The real companion is `node scripts/operations/live-acceptance.js vids-publish` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fakeApi, type FakeReply } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const vids = requireCjs('../../scripts/lib/live-acceptance-vids-publish.js');
const sql = requireCjs('../../scripts/lib/live-acceptance-sql.js');

const OWNER = 'fixture|vids-owner';
const MOUNT_401: FakeReply = { status: 401, json: { authenticated: false, error: 'unauthorized', loginPath: '/login' } };
const GUARD_401: FakeReply = { status: 401, json: { error: 'user_identity_required' } };
const TOKEN_RE = /^[a-f0-9]{64}$/;

interface WorldOptions {
  installed?: boolean; publication?: boolean; mountOpen?: boolean; anonymousPublishes?: boolean;
  servesAfterRevoke?: boolean; servesMalformed?: boolean; servedBytes?: (bytes: Buffer) => Buffer;
  deleteRefuses?: boolean; deleteLeavesFile?: boolean; probeBlind?: boolean; residueSilent?: boolean; insertNoId?: boolean;
}
interface Export { artifactId: string; bytes: Buffer; sha256: string; token: string | null }

/** A doubled vids package: the owner's routes, the anonymous routes, the statement set and the file probe. */
function world(o: WorldOptions = {}) {
  const jobs = new Map<string, { owner: string; idea: string; status: string }>();
  const exported = new Map<string, Export>();
  const files = new Set<string>();
  const issued = new Set<string>();
  const log: string[] = [];
  const uploads: Buffer[] = [];
  const statements: Array<{ name: string; params: unknown[] }> = [];
  const view = (jobId: string) => {
    const e = exported.get(jobId);
    return e ? { jobId, sha256: e.sha256, byteLength: e.bytes.length, publicUrl: e.token ? `/api/vids-public/${e.token}/video.mp4` : null } : null;
  };
  const owned = (jobId: string) => jobs.get(jobId)?.owner === OWNER;
  const publish = (jobId: string, body: { confirm?: boolean; sha256?: string }): FakeReply => {
    if (body?.confirm !== true) return { status: 428, json: { error: 'confirmation_required' } };
    const e = exported.get(jobId);
    if (!owned(jobId)) return { status: 404, json: { error: 'job_not_found' } };
    if (!e) return { status: 409, json: { error: 'finished_export_required' } };
    if (e.sha256 !== body.sha256) return { status: 409, json: { error: 'export_changed_review_again' } };
    if (!e.token) { e.token = randomBytes(32).toString('hex'); issued.add(e.token); log.push('publish'); }
    return { status: 200, json: { artifact: view(jobId) } };
  };
  const serve = (token: string): FakeReply => {
    const live = [...exported.values()].find((e) => (TOKEN_RE.test(token) ? e.token === token || (o.servesAfterRevoke && issued.has(token))
      : Boolean(o.servesMalformed && e.token && e.token.startsWith(token))));
    if (!live) return { status: 404 };
    return { status: 200, bytes: o.servedBytes ? o.servedBytes(live.bytes) : live.bytes, contentType: 'video/mp4' };
  };
  const owner = fakeApi({
    'GET /api/vids/jobs': () => (o.installed === false ? { status: 404 } : { status: 200, json: { jobs: [], workers: [] } }),
    'GET /api/vids/jobs/:job/artifact': ({ params }) => {
      if (o.publication === false) return { status: 404, json: { error: 'not_found' } };
      return owned(params.job) ? { status: 200, json: { artifact: view(params.job) } } : { status: 404, json: { error: 'job_not_found' } };
    },
    'POST /api/vids/jobs/:job/artifact/publish': ({ params, body }) => publish(params.job, body as { confirm?: boolean; sha256?: string }),
    'POST /api/vids/jobs/:job/artifact/unpublish': ({ params, body }) => {
      const e = exported.get(params.job);
      if ((body as { confirm?: boolean })?.confirm !== true) return { status: 428, json: { error: 'confirmation_required' } };
      if (!e) return { status: 404, json: { error: 'export_not_found' } };
      e.token = null;
      log.push('unpublish');
      return { status: 200, json: { artifact: view(params.job) } };
    },
    'DELETE /api/vids/jobs/:job/artifact': ({ params, body }) => {
      const e = exported.get(params.job);
      if ((body as { confirm?: boolean })?.confirm !== true) return { status: 428, json: { error: 'confirmation_required' } };
      if (!e) return { status: 404, json: { error: 'export_not_found' } };
      if (e.token) return { status: 409, json: { error: 'unpublish_before_removing' } };
      if (o.deleteRefuses) return { status: 503, json: { error: 'artifact_storage_unavailable' } };
      exported.delete(params.job);
      if (!o.deleteLeavesFile) files.delete(e.artifactId);
      log.push('delete-export');
      return { status: 200, json: { removed: true } };
    },
  });
  const anonymous = fakeApi({
    'GET /api/vids/jobs': () => (o.mountOpen ? GUARD_401 : MOUNT_401),
    'POST /api/vids/jobs/:job/artifact/publish': ({ params, body }) => (o.anonymousPublishes ? publish(params.job, body as { confirm?: boolean; sha256?: string })
      : o.mountOpen ? GUARD_401 : MOUNT_401),
    'GET /api/vids-public/:token/video.mp4': ({ params }) => serve(params.token),
  });
  const upload = async (route: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) => {
    const jobId = /^\/api\/vids\/jobs\/([^/]+)\/artifact$/.exec(route)?.[1] ?? '';
    uploads.push(file.bytes);
    expect(fields).toEqual({});
    expect(file.type).toBe('video/mp4');
    if (!owned(jobId) || exported.has(jobId)) return { status: 409, json: { error: 'export_already_attached' }, text: '', contentType: 'application/json', location: null };
    const e = { artifactId: randomUUID(), bytes: Buffer.from(file.bytes), sha256: createHash('sha256').update(file.bytes).digest('hex'), token: null };
    exported.set(jobId, e);
    files.add(e.artifactId);
    log.push('attach');
    return { status: 201, json: { artifact: view(jobId) }, text: '', contentType: 'application/json', location: null };
  };
  const statement = async (name: string, params: unknown[]) => {
    statements.push({ name, params });
    const [sub, jobId, tag] = params as string[];
    expect(sub).toBe(OWNER);
    if (name === 'vids.done-job-insert') {
      if (o.insertNoId) return { rows: [] };
      const id = randomUUID();
      jobs.set(id, { owner: sub, idea: jobId, status: 'done' });
      log.push('insert-job');
      return { rows: [{ job_id: id }] };
    }
    if (name === 'vids.job-delete') {
      const job = jobs.get(jobId);
      if (job && job.owner === sub && job.idea === tag && job.status === 'done') { jobs.delete(jobId); exported.delete(jobId); log.push('delete-job'); }
      return { rows: [] };
    }
    if (o.residueSilent) return { rows: [] };
    const e = exported.get(jobId);
    return { rows: [{ jobs: jobs.has(jobId) ? 1 : 0, exports: e ? 1 : 0, published: e?.token ? 1 : 0, artifact_id: e ? e.artifactId : null }] };
  };
  const probes: Array<{ name: string; id: string }> = [];
  const probe = { state: async (name: string, id: string) => { probes.push({ name, id }); return !o.probeBlind && files.has(id) ? 'present' : 'absent'; } };
  const ports = { api: owner.api, anonymous: anonymous.api, upload, sql: statement, files: probe, ownerSub: OWNER };
  return { ports, owner, anonymous, jobs, exported, files, log, uploads, statements, probes };
}

describe('vids-publish live acceptance', () => {
  it('passes on the mount gate, exact public bytes and 404 after revoke, then removes export, file and job', async () => {
    const w = world();
    const result = await vids.run(w.ports);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('the /api/vids mount\'s sign-in gate refused an unauthenticated GET /api/vids/jobs and an unauthenticated confirmed publish (401 unauthorized)');
    expect(result.detail).toContain('served exactly the 868 uploaded bytes anonymously as video/mp4; a malformed token and the revoked link answered 404');
    const jobId = result.evidence.jobId as string;
    const tag = result.evidence.tag as string;
    expect(tag).toMatch(/^testlab-live-vids-publish-[0-9a-f]{8}$/);
    expect(result.evidence).toMatchObject({ anonymous: { jobs: { status: 401, error: 'unauthorized' }, control: { status: 401, error: 'unauthorized' } },
      publicStatus: 200, exactBytes: true, byteLength: 868, malformedStatus: 404, afterRevokeStatus: 404 });
    expect(w.log).toEqual(['insert-job', 'attach', 'publish', 'unpublish', 'delete-export', 'delete-job']);
    expect([w.jobs.size, w.exported.size, w.files.size]).toEqual([0, 0, 0]);
    expect(w.statements.map((s) => s.name)).toEqual(['vids.done-job-insert', 'vids.residue', 'vids.residue', 'vids.job-delete', 'vids.residue']);
    expect(w.statements[0].params).toEqual([OWNER, tag]);
    expect(w.statements[3].params).toEqual([OWNER, jobId, tag]);
    const artifactId = result.evidence.artifactId as string;
    expect(w.probes).toEqual([{ name: 'vids.export', id: artifactId }, { name: 'vids.export', id: artifactId }]);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [],
      removed: [`vids-job ${jobId}`, `vids-export ${artifactId}`, `vids-publication ${jobId}`] });
    expect(w.uploads).toEqual([vids.fixtureVideo(tag).bytes]);
    const anonymousRoutes = w.anonymous.calls.map((c) => `${c.method} ${c.path.replace(/[a-f0-9]{63,64}/, (t: string) => `<${t.length}>`)}`);
    expect(anonymousRoutes).toEqual(['GET /api/vids/jobs', `POST /api/vids/jobs/${jobId}/artifact/publish`, 'GET /api/vids-public/<64>/video.mp4',
      'GET /api/vids-public/<63>/video.mp4', 'GET /api/vids-public/<64>/video.mp4']);
    const token = w.anonymous.calls[2].path.split('/')[3];
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('fails when the revoked link still serves anonymously, and still cleans up', async () => {
    const w = world({ servesAfterRevoke: true });
    const result = await vids.run(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('after the revoke the anonymous read answered HTTP 200, not 404');
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect([w.jobs.size, w.exported.size, w.files.size]).toEqual([0, 0, 0]);
  });

  it('fails when a 401 comes from the package guard instead of the mount gate, or an anonymous publish goes through', async () => {
    const open = await vids.run(world({ mountOpen: true }).ports);
    expect(open.state).toBe('fail');
    expect(open.detail).toContain('an unauthenticated GET /api/vids/jobs answered 401 user_identity_required from the package\'s own guard, not the mount\'s sign-in gate');
    const w = world({ anonymousPublishes: true });
    const leaked = await vids.run(w.ports);
    expect(leaked.state).toBe('fail');
    expect(leaked.detail).toContain('an unauthenticated confirmed publish of the job answered HTTP 200, not 401');
    expect(leaked.detail).toContain('after the unauthenticated publish the owner\'s export read answered HTTP 200 with publicUrl set');
    expect(leaked.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect(w.files.size).toBe(0);
  });

  it('fails on bytes other than the upload, and on a served malformed token', async () => {
    const stale = await vids.run(world({ servedBytes: (bytes) => bytes.subarray(0, vids.FIXTURE_MP4.length) }).ports);
    expect(stale.state).toBe('fail');
    expect(stale.detail).toMatch(/the anonymous read returned 826 bytes with sha256 [a-f0-9]{64}, not the 868 uploaded bytes/);
    const malformed = await vids.run(world({ servesMalformed: true }).ports);
    expect(malformed.state).toBe('fail');
    expect(malformed.detail).toContain('an anonymous read with a malformed token answered HTTP 200, not 404');
  });

  it('turns media left on disk into a red cleanup, whatever removed the row', async () => {
    const leftFile = world({ deleteLeavesFile: true });
    const result = await vids.run(leftFile.ports);
    const artifactId = result.evidence.artifactId as string;
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: export file ${artifactId}.mp4 is still on disk after cleanup`);
    expect([leftFile.jobs.size, leftFile.exported.size, leftFile.files.size]).toEqual([0, 0, 1]);
    const refused = world({ deleteRefuses: true });
    const cascaded = await vids.run(refused.ports);
    expect(cascaded.state).toBe('fail');
    expect(cascaded.detail).toContain('artifact answered HTTP 503 (artifact_storage_unavailable)');
    expect(cascaded.detail).toContain('is still on disk after cleanup');
    expect(cascaded.cleanup.outstanding).toEqual([`vids-export ${cascaded.evidence.artifactId}`]);
    expect([refused.jobs.size, refused.exported.size, refused.files.size]).toEqual([0, 0, 1]);
  });

  it('fails when the file probe never saw the export, and never reads a silent residue as clean', async () => {
    const blind = await vids.run(world({ probeBlind: true }).ports);
    expect(blind.state).toBe('fail');
    expect(blind.detail).toMatch(/the vids\.export probe does not see export [0-9a-f-]{36} on disk, so its removal could not be proven/);
    const w = world({ residueSilent: true });
    const silent = await vids.run(w.ports);
    expect(silent.state).toBe('fail');
    expect(silent.detail).toContain('returned no counts');
    expect(silent.cleanup.outstanding).toContain(`vids-job ${silent.evidence.jobId}`);
  });

  it('is unavailable without vids or its publication routes, or a port, and writes nothing', async () => {
    for (const options of [{ installed: false }, { publication: false }]) {
      const w = world(options);
      const result = await vids.run(w.ports);
      expect(result.state).toBe('unavailable');
      expect(result.detail).toMatch(/vids (is not installed|with owner-controlled publication \(1\.5\.0 or later\) is not installed)/);
      expect(result.detail).toContain('Nothing was written.');
      expect(w.statements).toEqual([]);
      expect(w.uploads).toEqual([]);
    }
    const noFiles = world();
    const result = await vids.run({ ...noFiles.ports, files: undefined });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('This runner has no files port.');
    expect(noFiles.owner.calls).toEqual([]);
  });

  it('reports an insert that returned no job and touches nothing else', async () => {
    const w = world({ insertNoId: true });
    const result = await vids.run(w.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('The tagged finished-job insert returned no job id.');
    expect(w.uploads).toEqual([]);
    expect(w.anonymous.calls).toEqual([]);
  });

  it('uploads a real MP4 carrying the run tag, and deletes only the tagged finished job', () => {
    expect(createHash('sha256').update(vids.FIXTURE_MP4).digest('hex')).toBe('7eafbcdf5c8852002c3ba37f1bed958fe2e21934922e3f0ff07ae3f9cf076f57');
    const tag = 'testlab-live-vids-publish-0a1b2c3d';
    const { bytes, sha256, byteLength } = vids.fixtureVideo(tag);
    const top: Array<{ kind: string; start: number; end: number }> = [];
    for (let at = 0; at < bytes.length;) { const size = bytes.readUInt32BE(at); top.push({ kind: bytes.toString('ascii', at + 4, at + 8), start: at, end: at + size }); at += size; }
    expect(top.map((b) => b.kind)).toEqual(['ftyp', 'moov', 'free', 'mdat', 'free']);
    expect(top[top.length - 1].end).toBe(byteLength);
    expect(bytes.subarray(top[4].start + 8).toString('ascii')).toBe(tag);
    expect(bytes.includes(Buffer.from('vide'))).toBe(true);
    expect(bytes.includes(Buffer.from('avcC'))).toBe(true);
    expect(sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(sql.STATEMENTS['vids.job-delete']).toMatch(/user_sub = \$1 AND job_id = \$2::uuid AND idea = \$3 AND status = 'done'/);
    expect(sql.STATEMENTS['vids.done-job-insert']).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM vids_jobs WHERE user_sub = \$1 AND idea = \$2\)/);
  });
});
