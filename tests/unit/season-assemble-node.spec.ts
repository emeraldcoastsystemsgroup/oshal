/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The node-side season stitch, against REAL ffmpeg. Two claims here are about media and cannot be made by a double: that the season plays its episodes in ordinal order (proved by decoding the finished cut and reading the pixels back at each episode's timestamp, not by inspecting the argument list), and that the output is validated rather than assumed (a stitch with no audio, no picture or a short duration is a failure, not an upload). The Drive/controller side is absent by construction: this runs the shipped `season-assemble.js` as the node runs it, with its home and credential paths pointed at a temp dir so nothing reaches an account.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG = resolve(__dirname, '../../packages/oshal-vids-operator');
const SCRIPT = join(PKG, 'season-assemble.js');

// The same resolver the production stitch uses. If it cannot produce a working ffmpeg this file
// FAILS rather than skipping: a media guard that quietly does not run is a guard that does not exist.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveFfmpeg, probeStreams } = require(join(PKG, 'src', 'media', 'assemble')) as {
  resolveFfmpeg: () => string;
  probeStreams: (file: string) => { ok: boolean; video: boolean; audio: boolean; seconds: number; error?: string };
};

let work: string;
let ffmpeg: string;

/** One second of a solid colour with a tone, so a finished cut can be read back a segment at a time. */
interface Clip { path: string; rgb: [number, number, number] }
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];

/**
 * @description Render one second of a solid colour (with or without a tone) through real ffmpeg.
 * @param name - File name inside the work dir.
 * @param colour - An ffmpeg colour name.
 * @param withAudio - false renders a silent clip, to prove the audio check is not vacuous.
 * @returns The absolute path of the clip.
 */
function makeClip(name: string, colour: string, withAudio = true): string {
  const out = join(work, name);
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:d=1:r=24`];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest');
  args.push('-t', '1', out);
  execFileSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return out;
}

/**
 * @description Render an MP4 that carries sound but no picture — a real file the stream validator
 * must reject as an episode.
 * @param name - File name inside the work dir.
 * @returns The absolute path of the file.
 */
function makeAudioOnly(name: string): string {
  const out = join(work, name);
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'aac', '-b:a', '128k', '-t', '1', out], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return out;
}

/**
 * @description Decode one frame of a finished file and read its dominant colour. This is what makes
 * the ordering claim real: the assertion is on the pixels the viewer would see at that second.
 * @param file - The finished season cut.
 * @param atSec - The timestamp to sample.
 * @returns The frame's [r, g, b].
 */
function colourAt(file: string, atSec: number): [number, number, number] {
  const raw = join(work, `probe-${String(atSec).replace('.', '_')}.raw`);
  execFileSync(ffmpeg, ['-y', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-s', '2x2', raw], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const b = readFileSync(raw);
  return [b[0], b[1], b[2]];
}

/** @description Which of red/green/blue a sampled frame is, or 'other'. @param rgb sampled pixel @returns the colour name */
function nameOf(rgb: [number, number, number]): string {
  const [r, g, b] = rgb;
  if (r > 140 && g < 110 && b < 110) return 'red';
  if (g > 100 && r < 110 && b < 110) return 'green';
  if (b > 140 && r < 110 && g < 110) return 'blue';
  return `other(${r},${g},${b})`;
}

/**
 * @description Run the SHIPPED season-assemble.js exactly as the render node runs it.
 * @param plan - The base64-encoded plan object.
 * @returns The script's stdout and exit status.
 */
function runSeason(plan: unknown): { stdout: string; status: number | null } {
  const b64 = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
  const r = spawnSync(process.execPath, [SCRIPT, b64], {
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      VIDS_DATA_DIR: join(work, 'data'),
      VIDS_CONTENT_DIR: join(work, 'content'),
      // No account is reachable from this spec: no token, and the credentials file it would
      // otherwise look for on this machine is pointed at a path that does not exist.
      VIDS_DRIVE_ACCESS_TOKEN: '',
      VIDS_DRIVE_CREDS: join(work, 'no-such-drive-creds.json'),
      OSHAL_FFMPEG: ffmpeg,
    },
  });
  return { stdout: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

/** @description The JSON the node prints on its SEASON_OK line. @param stdout the run's output @returns the parsed payload */
function seasonOk(stdout: string): { localPath: string; episodeCount: number; seconds: number; driveUrl: string | null } {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('SEASON_OK'));
  expect(line, `no SEASON_OK line in:\n${stdout}`).toBeTruthy();
  return JSON.parse(line!.slice('SEASON_OK'.length).trim());
}

describe('season-assemble.js on the render node', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'oshal-season-'));
    ffmpeg = resolveFfmpeg();
    // Fail loudly, never skip: this whole file's value is that ffmpeg really ran.
    const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
    expect(probe.status, `no working ffmpeg at "${ffmpeg}" — season validation cannot be proven without one`).toBe(0);
  }, 120_000);

  afterAll(() => { rmSync(work, { recursive: true, force: true }); });

  it('stitches the episodes in ORDINAL order, whatever order the plan lists them in', () => {
    const clips: Clip[] = [
      { path: makeClip('ep1.mp4', 'red'), rgb: RED },
      { path: makeClip('ep2.mp4', 'green'), rgb: GREEN },
      { path: makeClip('ep3.mp4', 'blue'), rgb: BLUE },
    ];
    // Deliberately scrambled, and ep3 first: a stitch that trusts the list order plays blue first.
    const out = runSeason({
      seriesId: 'series-1', title: 'The Breakfast Crew', orientation: 'Landscape',
      episodes: [
        { ordinal: 3, title: 'Three', path: clips[2].path },
        { ordinal: 1, title: 'One', path: clips[0].path },
        { ordinal: 2, title: 'Two', path: clips[1].path },
      ],
    });

    const ok = seasonOk(out.stdout);
    expect(out.status).toBe(0);
    expect(ok.episodeCount).toBe(3);
    expect(existsSync(ok.localPath)).toBe(true);
    expect(statSync(ok.localPath).size).toBeGreaterThan(10_000);

    // The proof: read the pixels back one episode at a time.
    expect([nameOf(colourAt(ok.localPath, 0.5)), nameOf(colourAt(ok.localPath, 1.5)), nameOf(colourAt(ok.localPath, 2.5))])
      .toEqual(['red', 'green', 'blue']);
  }, 300_000);

  it('the finished cut carries picture, sound and the full running time', () => {
    const paths = [makeClip('a1.mp4', 'red'), makeClip('a2.mp4', 'green')];
    const out = runSeason({
      seriesId: 'series-2', title: 'Two Parter',
      episodes: [{ ordinal: 1, title: 'A', path: paths[0] }, { ordinal: 2, title: 'B', path: paths[1] }],
    });
    const ok = seasonOk(out.stdout);
    const probe = probeStreams(ok.localPath);
    expect(probe.video).toBe(true);
    expect(probe.audio).toBe(true);
    expect(probe.seconds).toBeGreaterThanOrEqual(1.8);
    // Nothing was uploaded, and the script says so instead of inventing a link.
    expect(ok.driveUrl).toBeNull();
  }, 300_000);

  it('probeStreams really can tell a silent file from a sounded one', () => {
    const silent = makeClip('silent.mp4', 'red', false);
    const sounded = makeClip('sounded.mp4', 'green', true);
    const s = probeStreams(silent);
    expect(s.video).toBe(true);
    expect(s.audio).toBe(false);
    expect(probeStreams(sounded).audio).toBe(true);

    // ...and a season containing that silent episode still ends up with an audio stream, because
    // the concat normalizes a silent input rather than dropping the track.
    const out = runSeason({
      seriesId: 'series-3', title: 'Quiet One',
      episodes: [{ ordinal: 1, title: 'silent', path: silent }, { ordinal: 2, title: 'sounded', path: sounded }],
    });
    expect(probeStreams(seasonOk(out.stdout).localPath).audio).toBe(true);
  }, 300_000);

  it('refuses a plan whose episodes claim the same slot', () => {
    const p = makeClip('d1.mp4', 'red');
    const out = runSeason({
      seriesId: 'series-4', title: 'Ambiguous',
      episodes: [{ ordinal: 1, title: 'A', path: p }, { ordinal: 1, title: 'B', path: p }],
    });
    expect(out.stdout).toContain('SEASON_ERR duplicate episode ordinals');
    expect(out.stdout).not.toContain('SEASON_OK');
    expect(out.status).not.toBe(0);
  }, 120_000);

  it('refuses a season whose episode file is not on this node', () => {
    const present = makeClip('m1.mp4', 'red');
    const out = runSeason({
      seriesId: 'series-5', title: 'Missing',
      episodes: [
        { ordinal: 1, title: 'A', path: present },
        { ordinal: 2, title: 'B', path: join(work, 'never-rendered.mp4') },
      ],
    });
    expect(out.stdout).toContain('SEASON_ERR');
    expect(out.stdout).toContain('missing on this node');
    expect(out.stdout).not.toContain('SEASON_OK');
  }, 120_000);

  it('refuses an episode that is not a video, before paying for a stitch', () => {
    const real = makeClip('v1.mp4', 'red');
    const pictureless = makeAudioOnly('no-picture.mp4');
    expect(probeStreams(pictureless).video).toBe(false);

    const out = runSeason({
      seriesId: 'series-7', title: 'Pictureless',
      episodes: [{ ordinal: 1, title: 'A', path: real }, { ordinal: 2, title: 'B', path: pictureless }],
    });
    expect(out.stdout).toContain('SEASON_ERR episode has no video stream: no-picture.mp4');
    expect(out.stdout).not.toContain('SEASON_OK');
  }, 120_000);

  it('refuses a single-episode plan — a season of one is that episode', () => {
    const out = runSeason({
      seriesId: 'series-6', title: 'Solo',
      episodes: [{ ordinal: 1, title: 'A', path: makeClip('s1.mp4', 'red') }],
    });
    expect(out.stdout).toContain('SEASON_ERR a season needs at least 2 episodes');
  }, 120_000);
});
