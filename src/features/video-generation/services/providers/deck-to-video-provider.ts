/**
 * Deck-to-video provider (ADR-070) — the first FREE generation provider. Turns slide sections
 * (title + bullets [+ speaker notes]) into a narrated .mp4: each slide is rendered to a PNG via the
 * image's headless Chromium, narrated via the TTS registry, and assembled with ffmpeg (image + audio
 * → clip, then concat). $0 — pure local compute. Reuses the deck sections the presentation engine
 * already produces.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial free deck-to-video provider (Chromium slide render + TTS + ffmpeg).
 *
 * @module video-generation/services/providers/deck-to-video-provider
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import { getTTSProviderRegistry } from '@/features/voice-providers';
import type { GenResult, ProviderStatus, VideoGenProvider, VideoJobSpec, VideoJobType } from '../../types';
import type { AspectRatio } from '../../types';

const logger = createChildLogger({ module: 'deck-to-video-provider' });

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || 'chromium-browser';
/** Slide shown for this long when it has no narration audio. */
const SILENT_SLIDE_SEC = 4;

/** One deck slide. Matches the presentation engine's RenderableSlide (title + newline bullets + notes). */
interface DeckSlide { title?: string; content?: string; notes?: string }

/** Output pixel dimensions per aspect ratio (decks default to 16:9). */
function resolution(aspectRatio: AspectRatio): { w: number; h: number } {
  if (aspectRatio === '9:16') return { w: 1080, h: 1920 };
  if (aspectRatio === '1:1') return { w: 1080, h: 1080 };
  return { w: 1920, h: 1080 };
}

/** Escape user text for safe embedding in slide HTML. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a clean styled HTML page for one slide at the target size. */
export function slideHtml(slide: DeckSlide, w: number, h: number): string {
  const bullets = String(slide.content ?? '').split(/\n+/).map((b) => b.trim()).filter(Boolean);
  const items = bullets.map((b) => `<li>${esc(b)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    body{width:${w}px;height:${h}px;background:#0e0e16;color:#e6e6f0;
      font-family:system-ui,Segoe UI,sans-serif;display:flex;flex-direction:column;justify-content:center;
      box-sizing:border-box;padding:${Math.round(h * 0.09)}px ${Math.round(w * 0.07)}px}
    h1{font-size:${Math.round(h / 14)}px;margin:0 0 ${Math.round(h / 22)}px;line-height:1.1;color:#fff}
    ul{margin:0;padding-left:${Math.round(w / 28)}px}
    li{font-size:${Math.round(h / 26)}px;line-height:1.5;margin-bottom:${Math.round(h / 40)}px;color:#c9c9da}
  </style></head><body>${slide.title ? `<h1>${esc(slide.title)}</h1>` : ''}<ul>${items}</ul></body></html>`;
}

/** Run a subprocess; reject with the stderr tail on a non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (err) => reject(new Error(`${cmd} spawn failed: ${err.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`))));
  });
}

/** Render one slide's HTML to a PNG via headless Chromium. */
async function slideToPng(slide: DeckSlide, w: number, h: number, dir: string, i: number): Promise<string> {
  const htmlPath = path.join(dir, `slide${i}.html`);
  const pngPath = path.join(dir, `slide${i}.png`);
  fs.writeFileSync(htmlPath, slideHtml(slide, w, h));
  await run(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${w},${h}`, `--screenshot=${pngPath}`, `file://${htmlPath.replace(/\\/g, '/')}`,
  ]);
  return pngPath;
}

/** Synthesize a slide's narration (notes preferred, else its bullets) to a wav; null when none/failed. */
async function slideNarration(slide: DeckSlide, dir: string, i: number): Promise<string | null> {
  const text = (slide.notes || String(slide.content ?? '').split(/\n+/).join('. ')).trim();
  if (!text) return null;
  try {
    const result = await getTTSProviderRegistry().resolveForApp(undefined, 'serverSide').synthesize({ text });
    if (!result.audio) return null;
    const out = path.join(dir, `narration${i}.wav`);
    fs.writeFileSync(out, result.audio);
    return out;
  } catch (err) {
    logger.warn({ err: (err as Error).message, slide: i }, 'deck narration TTS failed — slide will be silent');
    return null;
  }
}

/** Turn one slide PNG (+ optional narration) into a normalized clip. */
async function slideClip(png: string, narration: string | null, w: number, h: number, dir: string, i: number): Promise<string> {
  const out = path.join(dir, `clip${i}.mp4`);
  const vf = `scale=${w}:${h},setsar=1,fps=30,format=yuv420p`;
  const audio = narration
    ? ['-i', narration]
    : ['-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`, '-t', String(SILENT_SLIDE_SEC)];
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', png, ...audio,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-ar', '44100', '-shortest', out,
  ]);
  return out;
}

/** Concatenate slide clips into one mp4 (re-encode for clean timestamps). */
async function concat(clips: string[], dir: string): Promise<string> {
  const list = path.join(dir, 'concat.txt');
  fs.writeFileSync(list, clips.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const out = path.join(dir, 'deck.mp4');
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out]);
  return out;
}

/**
 * @description Free deck-to-video provider. `spec.inputs.sections` is the slide array; aspect ratio
 * comes from `spec.shape` (default 16:9). Renders each slide → PNG → narrated clip → concat.
 */
export class DeckToVideoProvider implements VideoGenProvider {
  readonly id = 'deck-to-video';
  readonly costClass = 'free' as const;
  readonly jobTypes: readonly VideoJobType[] = ['deck-to-video'];

  /** Available when ffmpeg + Chromium binaries are present (best-effort; spawn errors surface at run). */
  async probe(): Promise<ProviderStatus> {
    return { available: true, providerId: this.id };
  }

  estimateCost(): number {
    return 0;
  }

  async generate(spec: VideoJobSpec): Promise<GenResult> {
    const sections = (spec.inputs?.sections as DeckSlide[] | undefined) ?? [];
    if (!sections.length) throw new Error('deck-to-video needs inputs.sections[]');
    const { w, h } = resolution(spec.shape?.aspectRatio ?? '16:9');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oshal-deck-${crypto.randomBytes(4).toString('hex')}-`));
    try {
      const clips: string[] = [];
      for (let i = 0; i < sections.length; i++) {
        const png = await slideToPng(sections[i], w, h, dir, i);
        const narration = await slideNarration(sections[i], dir, i);
        clips.push(await slideClip(png, narration, w, h, dir, i));
      }
      const mp4 = fs.readFileSync(await concat(clips, dir));
      logger.info({ slides: sections.length, bytes: mp4.length }, 'deck-to-video render complete');
      return { providerId: this.id, costClass: this.costClass, mp4, costUsd: 0, meta: { slides: sections.length } };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
