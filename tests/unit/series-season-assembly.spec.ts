/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The season stage, against the real schema. The conductor used to mark a series 'done' the moment its last episode rendered, so a multi-episode series ended as a pile of separate files and the only artifact a viewer wants — the season cut — was never made. These cases drive `advanceVideoSeries` over a REAL PostgreSQL carrying the deployment's own migrations (066/067/068/098/153): the render→assembling edge, the ordinal order the stitch is dispatched in (episodes are INSERTED out of order, so a dropped `ORDER BY` shows up as a scrambled plan rather than as nothing), the single-in-flight rule the 20s reconciler would otherwise break, the owner-scoped node pick, and the four ways a stitch comes back. The database is the boundary: the ordering, the 'assembling' status and the season columns all live in PostgreSQL, and a mocked pool returns whatever the author expected.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const hoisted = vi.hoisted(() => ({
  enqueued: [] as Array<{ clientId: string; env: Record<string, unknown> }>,
  state: { clients: [] as Array<Record<string, unknown>>, results: new Map<string, unknown>() },
}));

// The remote node is doubled: a real desktop with a logged-in Chrome is not something a spec may
// own. Everything the node's ANSWER is turned into is real, and the node script itself is proven
// against real ffmpeg in tests/unit/season-assemble-node.spec.ts.
vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => hoisted.state.clients,
    enqueueTask: (clientId: string, env: Record<string, unknown>) => {
      hoisted.enqueued.push({ clientId, env });
      return { taskId: env.taskId };
    },
    getCompletedResult: (_clientId: string, taskId: string) => hoisted.state.results.get(taskId) ?? null,
  },
}));

vi.mock('@/app/vids-node-availability', () => ({
  checkVidsNodeAvailability: async () => ({ available: true, reason: '' }),
  nodePkgDir: () => 'C:\\oshal-vidsop',
  nodeExe: () => 'C:\\Program Files\\nodejs\\node.exe',
}));

const { advanceVideoSeries, runVideoSeries, reconcileSeasonResult, reconcilePendingRenders } = await import('@/app/series-orchestrator');
const { dispatchSeasonAssembly } = await import('@/app/series-dispatch');

const OWNER = 'season-owner-sub';
const STRANGER = 'someone-else-sub';

// A PostgreSQL this file owns. The migrations are the deployment's own: 066 creates the series and
// episode tables, 067 adds the storyboarded state, 068 the 'storyboarding' series state, 097 the pump
// run ledger and 120 the node-lease columns the availability check reads, 098 the intro clip, 153 the season columns this file is about.
const database = new DisposablePostgres({
  purpose: 'series-season-assembly',
  database: 'season_fixture',
  memory: '384m',
  // ONE connection, so the planner settings this file applies below really do govern every query
  // the production code makes through this pool.
  max: 1,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 30_000,
  migrations: [
    '066-video-series.sql',
    '067-video-episode-scenes.sql',
    '068-video-series-storyboarding-status.sql',
    '097-video-pump.sql',
    '120-shared-node-resource-leases.sql',
    '098-video-series-intro-clip.sql',
    '153-video-season-artifact.sql',
  ],
});

let pool: Pool;
/** The conductor takes an AppContext; only its pool is reached on these paths. */
const ctx = () => ({ pool } as unknown as Parameters<typeof advanceVideoSeries>[0]);

const CREDS = { resolveCredentials: async () => ({ driveToken: 'drive-token-for-the-owner' }) };

/** @description A registered node, owned by whoever is named. @param id client id @param ownerSub owner @returns the node row */
function node(id: string, ownerSub: string | null): Record<string, unknown> {
  return { clientId: id, agentId: `agent-${id}`, status: 'online', healthy: true, ownerSub, capabilities: ['shell.exec', 'content.produce'], tags: ['vids'] };
}

/**
 * @description Seed one series whose episodes are all rendered, INSERTED OUT OF ORDINAL ORDER on
 * purpose: insertion order is what a query without `ORDER BY ordinal` returns, so a season stitched
 * in "whatever order the rows came back" is visible here as a scrambled plan.
 * @param opts - How many episodes, the owner, and the series' starting status.
 * @returns The new series id.
 */
async function seedSeries(opts: { episodes: number; owner?: string; status?: string }): Promise<string> {
  const owner = opts.owner ?? OWNER;
  const { rows } = await pool.query(
    `INSERT INTO video_series (user_sub, ticket_id, title, premise, episode_count, status)
     VALUES ($1, 'ticket-1', 'The Breakfast Crew', 'jokes at breakfast', $2, $3) RETURNING series_id`,
    [owner, opts.episodes, opts.status ?? 'rendering'],
  );
  const seriesId = String(rows[0].series_id);
  const order = opts.episodes === 3 ? [3, 1, 2] : Array.from({ length: opts.episodes }, (_, i) => i + 1);
  for (const ordinal of order) {
    await pool.query(
      `INSERT INTO video_episodes (series_id, user_sub, ordinal, title, status, mp4_path)
       VALUES ($1, $2, $3, $4, 'rendered', $5)`,
      [seriesId, owner, ordinal, `Episode ${ordinal}`, `C:/content/breakfast/ep-${ordinal}.mp4`],
    );
  }
  return seriesId;
}

/** @description Decode the base64 season plan out of the PowerShell command that was enqueued. @param command the shell command @returns the plan */
function decodePlan(command: string): { seriesId: string; title: string; episodes: Array<{ ordinal: number; path: string }> } {
  const m = command.match(/season-assemble\.js '([A-Za-z0-9+/=]+)'/);
  if (!m) throw new Error(`no season plan in the enqueued command: ${command}`);
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

/** @description The shell command of the single enqueued task. @returns the command string */
function enqueuedCommand(): string {
  expect(hoisted.enqueued).toHaveLength(1);
  const input = hoisted.enqueued[0].env.input as { name: string; arguments: { command: string } };
  expect(input.name).toBe('shell.exec');
  return input.arguments.command;
}

describe('video series — season assembly', () => {
  beforeAll(async () => {
    pool = await database.start();
    // `video_episodes_series_idx` is on (series_id, ordinal), so an index or bitmap scan hands back
    // rows ALREADY sorted and a query that lost its `ORDER BY ordinal` still looks correct — the
    // guard would then be one the planner passes for it. Turning both off leaves a sequential scan,
    // which returns heap order (the order seedSeries inserted in), so the ORDER BY is the only thing
    // that can produce a correctly ordered season. Both are set on the database AND on the live
    // session: the first survives a reconnect, the second takes effect without one.
    await pool.query(`ALTER DATABASE season_fixture SET enable_indexscan = off`);
    await pool.query(`ALTER DATABASE season_fixture SET enable_bitmapscan = off`);
  }, 180_000);
  afterAll(async () => { await database.stop(); });

  beforeEach(async () => {
    await pool.query('SET enable_indexscan = off');
    await pool.query('SET enable_bitmapscan = off');
    hoisted.enqueued.length = 0;
    hoisted.state.clients = [node('the-owners-desktop', OWNER)];
    hoisted.state.results.clear();
  });

  afterEach(async () => { await pool.query('DELETE FROM video_series'); });

  it('the season columns exist — migration 153 is applied', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='video_series'
          AND column_name IN ('season_job_id','season_path','season_drive_url')`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(['season_drive_url', 'season_job_id', 'season_path']);
  });

  it('a fully rendered multi-episode series enters assembling instead of going straight to done', async () => {
    const seriesId = await seedSeries({ episodes: 3 });
    const step = await advanceVideoSeries(ctx(), seriesId, CREDS);
    expect(step.status).toBe('assembling');
    expect(step.detail).toContain('assembling the season');
    const { rows } = await pool.query(`SELECT status FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].status).toBe('assembling');
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('the season is dispatched with its episodes in ORDINAL order, not insertion order', async () => {
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    // The rows really are stored out of order — otherwise this case would pass for the wrong reason.
    const raw = await pool.query(`SELECT ordinal FROM video_episodes WHERE series_id=$1`, [seriesId]);
    expect(raw.rows.map((r) => Number(r.ordinal))).not.toEqual([1, 2, 3]);

    const step = await advanceVideoSeries(ctx(), seriesId, CREDS);
    expect(step.stage).toBe('assemble');
    expect(step.advanced).toBe(true);

    const plan = decodePlan(enqueuedCommand());
    expect(plan.seriesId).toBe(seriesId);
    expect(plan.episodes.map((e) => e.ordinal)).toEqual([1, 2, 3]);
    expect(plan.episodes.map((e) => e.path)).toEqual([
      'C:/content/breakfast/ep-1.mp4',
      'C:/content/breakfast/ep-2.mp4',
      'C:/content/breakfast/ep-3.mp4',
    ]);

    const { rows } = await pool.query(`SELECT season_job_id FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].season_job_id).toBe(hoisted.enqueued[0].env.taskId);
  });

  it('one run carries a finished series from the last episode to a dispatched season', async () => {
    // This is the loop the 20s reconciler relies on: a single advance would stop at 'assembling'
    // and leave the season undispatched until something else poked the series.
    const seriesId = await seedSeries({ episodes: 3 });
    const steps = await runVideoSeries(ctx(), seriesId, CREDS);
    expect(steps.map((s) => s.stage)).toEqual(['render', 'assemble', 'assemble']);
    expect(steps.at(-1)!.waiting).toBe(true);
    expect(hoisted.enqueued).toHaveLength(1);
    expect(decodePlan(enqueuedCommand()).episodes.map((e) => e.ordinal)).toEqual([1, 2, 3]);
  });

  it('a season already stitching is not dispatched a second time by the next sweep', async () => {
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    await advanceVideoSeries(ctx(), seriesId, CREDS);
    expect(hoisted.enqueued).toHaveLength(1);

    const again = await advanceVideoSeries(ctx(), seriesId, CREDS);
    expect(again.waiting).toBe(true);
    expect(again.detail).toContain('stitching on the node');
    expect(hoisted.enqueued).toHaveLength(1);

    // And the dispatcher itself refuses, whoever calls it.
    const direct = await dispatchSeasonAssembly(pool, seriesId, { driveToken: 't' });
    expect(direct.ok).toBe(false);
    expect(direct.error).toContain('already in flight');
    expect(hoisted.enqueued).toHaveLength(1);
  });

  it('a one-episode series goes straight to done — a season of one is that episode', async () => {
    const seriesId = await seedSeries({ episodes: 1 });
    const step = await advanceVideoSeries(ctx(), seriesId, CREDS);
    expect(step.status).toBe('done');
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('a series with an unfinished episode is refused rather than stitched partially', async () => {
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    await pool.query(`UPDATE video_episodes SET mp4_path=NULL WHERE series_id=$1 AND ordinal=2`, [seriesId]);
    const r = await dispatchSeasonAssembly(pool, seriesId, { driveToken: 't' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('episode(s) 2 have no finished file');
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('the stitch never lands on a node the series owner may not drive', async () => {
    hoisted.state.clients = [node('a-strangers-desktop', STRANGER)];
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    const step = await advanceVideoSeries(ctx(), seriesId, CREDS);
    expect(step.blocked).toBe(true);
    expect(hoisted.enqueued).toHaveLength(0);
    const { rows } = await pool.query(`SELECT season_job_id FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].season_job_id).toBeNull();
  });

  it('a finished stitch writes the artifact and completes the series', async () => {
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    await advanceVideoSeries(ctx(), seriesId, CREDS);
    const out = `[season] 1. Episode 1\nSEASON_OK ${JSON.stringify({
      seriesId, localPath: 'C:/content/breakfast/the-breakfast-crew-season.mp4',
      episodeCount: 3, seconds: 180.25, bytes: 42_000_000, driveUrl: 'https://drive.example/season', drivePending: false,
    })}`;
    const r = await reconcileSeasonResult(pool, seriesId, out);
    expect(r.ok).toBe(true);

    const { rows } = await pool.query(`SELECT status, season_path, season_drive_url, error FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].status).toBe('done');
    expect(rows[0].season_path).toBe('C:/content/breakfast/the-breakfast-crew-season.mp4');
    expect(rows[0].season_drive_url).toBe('https://drive.example/season');
    expect(rows[0].error).toBeNull();
  });

  it('a season that never uploaded records no Drive link', async () => {
    const seriesId = await seedSeries({ episodes: 2, status: 'assembling' });
    await reconcileSeasonResult(pool, seriesId, `SEASON_OK ${JSON.stringify({ localPath: 'C:/x/season.mp4', driveUrl: null, drivePending: true })}`);
    const { rows } = await pool.query(`SELECT status, season_path, season_drive_url FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].status).toBe('done');
    expect(rows[0].season_path).toBe('C:/x/season.mp4');
    expect(rows[0].season_drive_url).toBeNull();
  });

  it('a failed stitch fails the series and frees the slot for a retry', async () => {
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    await advanceVideoSeries(ctx(), seriesId, CREDS);
    const r = await reconcileSeasonResult(pool, seriesId, 'SEASON_ERR season cut is truncated: 12.00s of an expected 180.00s');
    expect(r.ok).toBe(false);

    const { rows } = await pool.query(`SELECT status, error, season_job_id, season_path FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('truncated');
    expect(rows[0].season_job_id).toBeNull();
    expect(rows[0].season_path).toBeNull();
  });

  it('a success line with no artifact is a failure, not a finished series', async () => {
    const seriesId = await seedSeries({ episodes: 2, status: 'assembling' });
    const r = await reconcileSeasonResult(pool, seriesId, 'SEASON_OK {"seriesId":"x","episodeCount":2}');
    expect(r.ok).toBe(false);
    const { rows } = await pool.query(`SELECT status, error, season_path FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('no artifact path');
    expect(rows[0].season_path).toBeNull();
  });

  it('the reconciler sweep completes a season nobody is watching', async () => {
    const seriesId = await seedSeries({ episodes: 3, status: 'assembling' });
    await advanceVideoSeries(ctx(), seriesId, CREDS);
    const taskId = String(hoisted.enqueued[0].env.taskId);
    hoisted.state.results.set(taskId, {
      status: 'completed',
      output: { stdout: `SEASON_OK ${JSON.stringify({ localPath: 'C:/x/season.mp4', driveUrl: null })}` },
    });

    const reconciled = await reconcilePendingRenders(ctx());
    expect(reconciled).toBe(1);
    const { rows } = await pool.query(`SELECT status, season_path FROM video_series WHERE series_id=$1`, [seriesId]);
    expect(rows[0].status).toBe('done');
    expect(rows[0].season_path).toBe('C:/x/season.mp4');
  });
});
