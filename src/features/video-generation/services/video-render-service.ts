/**
 * Video render service — the deterministic half of the Video Studio (mirrors how
 * `renderPptx` turns a deck-builder outline into a real .pptx). Takes a sanitized
 * storyboard + the user's shape and produces a real .mp4: one Veo clip per scene,
 * per-scene TTS narration (reusing the voice-providers registry), burned-in captions,
 * an optional music bed, all stitched with ffmpeg. No stubs — every step does real work
 * or is skipped cleanly when its input is absent.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial render pipeline (Veo clips -> per-scene TTS + caption burn -> concat -> optional music mix) for the Video Studio thin slice.
 *
 * @module video-generation/services/video-render-service
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import { getTTSProviderRegistry } from '@/features/voice-providers';
import type { AspectRatio, RenderedVideo, Scene, Storyboard, VideoShape } from '../types';
import { generateClip, veoCostPerSecond, type VeoResolution } from './veo-client';

const logger = createChildLogger({ module: 'video-render-service' });

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// Alpine `ttf-dejavu` install path (see Dockerfile.oshal); override via env if the image differs.
const CAPTION_FONT = process.env.VIDEO_CAPTION_FONT || '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';

/** Output pixel dimensions for each supported aspect ratio. */
function resolution(aspectRatio: AspectRatio): { w: number; h: number } {
  if (aspectRatio === '16:9') return { w: 1920, h: 1080 };
  if (aspectRatio === '1:1') return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 };
}

/** Run ffmpeg with the given args; reject with the stderr tail on a non-zero exit. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed (${FFMPEG}): ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Synthesize a scene's narration to an mp3 file; returns the path, or null when there's none. */
async function synthNarration(scene: Scene, shape: VideoShape, dir: string, i: number): Promise<string | null> {
  if (!scene.narration) return null;
  try {
    const provider = getTTSProviderRegistry().resolveForApp(undefined, 'serverSide');
    const useVoiceId = shape.voice !== 'none' && shape.voice !== 'default';
    const result = await provider.synthesize({ text: scene.narration, voiceId: useVoiceId ? shape.voice : undefined });
    if (!result.audio) {
      logger.warn({ providerId: result.providerId }, 'TTS returned no server audio — scene narration skipped');
      return null;
    }
    // gemini-tts emits WAV (PCM+header); ffmpeg auto-detects by content regardless of name.
    const out = path.join(dir, `narration${i}.wav`);
    fs.writeFileSync(out, result.audio);
    return out;
  } catch (err) {
    // Narration is best-effort: a TTS failure leaves the scene silent rather than failing the whole render.
    logger.warn({ err: (err as Error).message, scene: i }, 'TTS synthesis failed — scene narration skipped');
    return null;
  }
}

/** ffmpeg drawtext caption clause, written via a textfile so we never have to escape the caption. */
function captionFilter(caption: string, dir: string, i: number, h: number): string {
  if (!caption) return '';
  if (!fs.existsSync(CAPTION_FONT)) {
    // Best-effort: without a usable font, skip the burn rather than failing the ffmpeg call.
    logger.warn({ font: CAPTION_FONT }, 'caption font missing — captions skipped for this render');
    return '';
  }
  const file = path.join(dir, `caption${i}.txt`);
  fs.writeFileSync(file, caption);
  const tfile = file.replace(/\\/g, '/').replace(/:/g, '\\:');
  const font = CAPTION_FONT.replace(/\\/g, '/').replace(/:/g, '\\:');
  return `,drawtext=textfile='${tfile}':fontfile='${font}':fontcolor=white:fontsize=${Math.round(h / 20)}` +
    `:box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=h-(text_h)-${Math.round(h / 12)}`;
}

/** Normalize one Veo clip to the target frame, burn its caption, and mux its narration. */
async function processScene(clip: Buffer, scene: Scene, shape: VideoShape, dir: string, i: number): Promise<string> {
  const { w, h } = resolution(shape.aspectRatio);
  const clipPath = path.join(dir, `clip${i}.mp4`);
  fs.writeFileSync(clipPath, clip);
  const narration = await synthNarration(scene, shape, dir, i);
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p${captionFilter(scene.caption, dir, i, h)}`;
  const out = path.join(dir, `scene${i}.mp4`);
  const audioIn = narration
    ? ['-i', narration, '-filter_complex', '[1:a]apad[a]', '-map', '0:v', '-map', '[a]']
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-map', '0:v', '-map', '1:a'];
  await runFfmpeg([
    '-i', clipPath, ...audioIn,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-ar', '44100',
    '-shortest', out,
  ]);
  return out;
}

/** Concatenate normalized scene files into one mp4 (re-encode for clean timestamps). */
async function concatScenes(scenePaths: string[], dir: string): Promise<string> {
  const listPath = path.join(dir, 'concat.txt');
  fs.writeFileSync(listPath, scenePaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const out = path.join(dir, 'stitched.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out]);
  return out;
}

/** Resolve an optional music-bed file for the shape's music style (operator-provided dir). */
function resolveMusicBed(music: string | 'none'): string | null {
  if (music === 'none') return null;
  const root = process.env.VIDEO_MUSIC_DIR;
  if (!root) return null;
  const file = path.join(root, `${music.replace(/[^\w.\-]/g, '')}.mp3`);
  return fs.existsSync(file) ? file : null;
}

/** Mix a background music bed (ducked) under the stitched audio; returns the final path. */
async function mixMusic(stitched: string, bed: string, dir: string): Promise<string> {
  const out = path.join(dir, 'final.mp4');
  await runFfmpeg([
    '-i', stitched, '-i', bed,
    '-filter_complex', '[1:a]volume=0.18[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', out,
  ]);
  return out;
}

/**
 * @description Render a storyboard into a finished .mp4 buffer. Generates each scene's
 * clip via Veo, normalizes + captions + narrates it, stitches the scenes, and mixes an
 * optional music bed. Cleans up its temp working dir in all cases.
 * @param storyboard - the sanitized scene plan
 * @param shape - the user's shape controls (framing, voice, captions, music)
 * @param resolution - '720p' (cheap draft — the DEFAULT) or '1080p' (final, pricier)
 * @returns the mp4 bytes, realized duration, and estimated Veo cost
 */
export async function renderVideo(storyboard: Storyboard, shape: VideoShape, resolution: VeoResolution = '720p'): Promise<RenderedVideo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oshal-video-${crypto.randomBytes(4).toString('hex')}-`));
  try {
    let durationSec = 0;
    const scenePaths: string[] = [];
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const scene = storyboard.scenes[i];
      const clip = await generateClip(scene, shape.aspectRatio, resolution);
      durationSec += clip.durationSec;
      scenePaths.push(await processScene(clip.mp4, scene, shape, dir, i));
    }
    let finalPath = await concatScenes(scenePaths, dir);
    const bed = resolveMusicBed(shape.music);
    if (bed) finalPath = await mixMusic(finalPath, bed, dir);
    const mp4 = fs.readFileSync(finalPath);
    logger.info({ scenes: storyboard.scenes.length, durationSec, resolution, bytes: mp4.length }, 'video render complete');
    return { mp4, durationSec, estimatedCostUsd: Number((durationSec * veoCostPerSecond(resolution)).toFixed(2)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
