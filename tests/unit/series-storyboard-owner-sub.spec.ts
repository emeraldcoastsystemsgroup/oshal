/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Video Studio series storyboard stage on the ADR-130 codex-cli rail. The conductor reached resolveStoryboardImageProvider with no caller identity, so under the demo default every series storyboard died at the SEC-05 carve hint. Pins: (1) advanceVideoSeries -> storyboardEpisode -> generateEpisodeStoryboard -> resolver -> codex-cli provider -> boot-registered executor carries the SERIES OWNER's sub, once per scene; (2) a direct storyboardEpisode call that threads nothing still renders, because the owner is read off the video_series row the stage already joins (the package's per-episode route); (3) a non-operator owner still fails closed with the carve hint and reaches no executor. The pg driver and the Drive upload are doubled OUTSIDE the boundary; the conductor, the pipeline, the frame generator, the resolver, the provider, the shared-workspace filesystem and the PNG validation are real.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => {
  const s = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  };
  s.child.mockReturnValue(s);
  return s;
});
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies, logger: logSpies }));

// Drive is OUTSIDE the boundary under test: where a finished frame is stored is not what failed,
// and a unit run must never reach Google. The upload records the name and hands back an id.
const drive = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('@/app/series-drive', () => ({
  uploadFrameToDrive: async (_png: Buffer, name: string): Promise<string> => {
    drive.names.push(name);
    return `drive:${name}`;
  },
}));

import type { Pool } from 'pg';
import type { AppContext } from '../../src/app/composition/app-context';
import { advanceVideoSeries } from '../../src/app/series-orchestrator';
import { storyboardEpisode } from '../../src/app/series-pipeline';
import {
  registerCliStoryboardImageExecutor,
  type CliStoryboardRenderRequest,
} from '../../src/features/video-generation/services/storyboard-cli-image-executor';

const OPERATOR_SUB = 'auth0|series-operator';
const OTHER_SUB = 'auth0|somebody-else';
const SERIES_ID = 'series-1';
const EPISODE_ID = 'episode-1';

const ENV_KEYS = [
  'STORYBOARD_IMAGE_PROVIDER',
  'DEMO_MODE',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_WORKSPACE_ROOT',
] as const;

/* ───────────────────────────── a real, decodable PNG ───────────────────────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): number[] => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @description CRC-32 of a PNG chunk. @param {Buffer} buf bytes @returns {number} crc */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @description One PNG chunk. @param {string} type 4-char type @param {Buffer} data payload @returns {Buffer} chunk */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * @description A 64x64 truecolour PNG drawn as a 16x16 checkerboard, so the frame generator's real
 * decoder, white-margin crop and 16x16 average-hash all see a structured image. `phase` flips the
 * board, which is how two scenes come back as genuinely different shots (a flat fill hashes to all
 * zeroes and would be rejected as a duplicate).
 * @param {number} phase 0 or 1 — the checkerboard's parity
 * @returns {Buffer} png bytes
 */
function checkerPng(phase: number): Buffer {
  const GRID = 16; const CELL = 4; const W = GRID * CELL; const stride = W * 3;
  const raw = Buffer.alloc(W * (stride + 1));
  for (let y = 0; y < W; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const light = (Math.floor(x / CELL) + Math.floor(y / CELL) + phase) % 2 === 0;
      const v = light ? 160 : 20; // never >= 244, so the white-margin crop leaves it alone
      const i = y * (stride + 1) + 1 + x * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour, non-interlaced
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ───────────────────────────── the doubled pg driver ───────────────────────────── */

interface SeriesRow { status: string; user_sub: string; ticket_id: string | null }
interface EpisodeRow { episode_id: string; ordinal: number; status: string; scenes: unknown[]; title: string; frame_ids: string[] | null; error: string | null }

/**
 * @description A pool that answers exactly the statements this stage issues. It is a scoped double
 * OUTSIDE the boundary under test — what PostgreSQL does with these statements is not this claim.
 * @param {SeriesRow} series the series row
 * @param {EpisodeRow} episode the one episode row
 * @returns {Pool} the doubled pool
 */
function makePool(series: SeriesRow, episode: EpisodeRow): Pool {
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (/SELECT status, user_sub, ticket_id.* FROM video_series/.test(sql)) {
      return { rows: params[0] === SERIES_ID ? [series] : [], rowCount: 1 };
    }
    if (/SELECT episode_id, ordinal, status FROM video_episodes/.test(sql)) {
      return { rows: [{ episode_id: episode.episode_id, ordinal: episode.ordinal, status: episode.status }], rowCount: 1 };
    }
    if (/FROM video_episodes e JOIN video_series s/.test(sql)) {
      return {
        rows: params[0] === episode.episode_id
          ? [{
            scenes: episode.scenes,
            title: episode.title,
            ordinal: episode.ordinal,
            style_lock: 'flat 2D cartoon, thick outlines',
            cast_bible: [{ name: 'Ada', description: 'a tall engineer in a red coat' }],
            user_sub: series.user_sub,
          }]
          : [],
        rowCount: 1,
      };
    }
    if (/UPDATE video_episodes SET frame_ids/.test(sql)) {
      episode.frame_ids = JSON.parse(String(params[1])) as string[];
      episode.status = 'storyboarded';
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE video_episodes SET status='failed'/.test(sql)) {
      episode.status = 'failed'; episode.error = String(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE video_series SET status='rendering'/.test(sql)) {
      series.status = 'rendering';
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected statement in this spec: ${sql.slice(0, 120)}`);
  };
  return { query } as unknown as Pool;
}

describe('Video Studio series storyboards on the demo codex-cli rail (ADR-130)', () => {
  let tempDir: string;
  let captured: CliStoryboardRenderRequest[];
  let anchorSeen: boolean[];
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  /** Register an executor that renders a distinct checkerboard per call into the task workspace. */
  const registerRenderingExecutor = (): void => {
    let n = 0;
    registerCliStoryboardImageExecutor(async (request) => {
      captured.push(request);
      const dir = path.join(process.env.OSHAL_WORKSPACE_ROOT as string, request.workspaceFolderId);
      anchorSeen.push(fs.existsSync(path.join(dir, 'anchor.png')));
      await fs.promises.writeFile(path.join(dir, 'output.png'), checkerPng(n % 2));
      n += 1;
      return { success: true, responseText: 'RENDERED output.png', model: 'gpt-5.5' };
    });
  };

  const twoScenes = [
    { n: 1, camera: 'WIDE establishing shot of the workshop, Ada at the bench' },
    { n: 2, camera: 'CLOSE UP on Ada, hands lifting the finished part' },
  ];

  const newEpisode = (): EpisodeRow => ({
    episode_id: EPISODE_ID, ordinal: 1, status: 'scripted', title: 'Pilot',
    scenes: twoScenes, frame_ids: null, error: null,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'series-sb-'));
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.OSHAL_WORKSPACE_ROOT = tempDir;
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
    delete process.env.STORYBOARD_IMAGE_PROVIDER;
    captured = [];
    anchorSeen = [];
    drive.names = [];
    registerCliStoryboardImageExecutor(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerCliStoryboardImageExecutor(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('the conductor storyboards an episode on the codex-cli rail with the series owner on every render', async () => {
    registerRenderingExecutor();
    const series: SeriesRow = { status: 'storyboarding', user_sub: OPERATOR_SUB, ticket_id: null };
    const episode = newEpisode();
    const pool = makePool(series, episode);
    const ctx = { pool } as unknown as AppContext;

    const step = await advanceVideoSeries(ctx, SERIES_ID, {
      // The Google token is the conductor's declared injection seam and is outside this boundary.
      resolveCredentials: async () => ({ driveToken: 'drive-token' }),
    });

    expect(step.stage).toBe('storyboard');
    expect(step.advanced).toBe(true);
    expect(step.blocked).toBe(false);
    expect(step.detail).toContain('2 frames');

    // The whole point: the SEC-05 gates at the bot node see the series owner, once per scene.
    expect(captured).toHaveLength(2);
    expect(captured.map((r) => r.userSub)).toEqual([OPERATOR_SUB, OPERATOR_SUB]);
    // Scene 1 anchors scene 2 — the anchor really reached the task workspace on disk.
    expect(anchorSeen).toEqual([false, true]);
    expect(captured[1].prompt).toContain('./anchor.png');

    expect(episode.status).toBe('storyboarded');
    expect(episode.frame_ids).toEqual(['drive:ep1-scene-01.png', 'drive:ep1-scene-02.png']);
    expect(drive.names).toEqual(['ep1-scene-01.png', 'ep1-scene-02.png']);
  }, 60_000);

  it('a stage call that threads nothing still renders as the owner, because the owner is on the series row', async () => {
    registerRenderingExecutor();
    const series: SeriesRow = { status: 'storyboarding', user_sub: OPERATOR_SUB, ticket_id: null };
    const episode = newEpisode();
    const pool = makePool(series, episode);

    const r = await storyboardEpisode(pool, EPISODE_ID, async (_png, name) => `drive:${name}`, {});

    expect(r.ok).toBe(true);
    expect(r.frameIds).toHaveLength(2);
    expect(captured.map((c) => c.userSub)).toEqual([OPERATOR_SUB, OPERATOR_SUB]);
  }, 60_000);

  it('a non-operator owner still fails closed with the carve hint and reaches no bot node', async () => {
    registerRenderingExecutor();
    const series: SeriesRow = { status: 'storyboarding', user_sub: OTHER_SUB, ticket_id: null };
    const episode = newEpisode();
    const pool = makePool(series, episode);
    const ctx = { pool } as unknown as AppContext;

    const err = await advanceVideoSeries(ctx, SERIES_ID, {
      resolveCredentials: async () => ({ driveToken: 'drive-token' }),
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/demo-mode CLI rendering needs/);
    expect((err as Error).message).toMatch(/Refusing to fall back/);
    expect(captured).toHaveLength(0);
    expect(episode.status).toBe('scripted');
  }, 60_000);
});
