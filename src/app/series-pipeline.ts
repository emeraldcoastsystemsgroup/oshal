/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The three stages: WRITE (bot -> validated episodes), STORYBOARD (camera lines -> stills), RENDER (stills + prompts -> the node). Each gate fails before the next one spends money.
 */
/**
 * @description Video Series — the stages, in the order money gets spent.
 *
 *   WRITE       free      the screenplay-writer bot drafts episodes; we VALIDATE its rules here
 *   STORYBOARD  cheap     one still per scene (Vertex, caller-billed); duplicates rejected here
 *   RENDER      expensive one Veo clip per scene on the remote node; assembled there
 *
 * Everything is arranged so a mistake dies at the cheapest stage that can see it. A speaker who is
 * not in frame is caught in WRITE, for nothing. Two scenes that are the same shot are caught in
 * STORYBOARD, for pennies. Neither ever reaches the render, which is where the credits go.
 *
 * The renderer identifies a speaker to the video model by a POINTER derived from the character's
 * description — the last words of its first clause. "Small bean drummer holding two glow sticks"
 * resolves to "the sticks", and the drumsticks talk. resolveSpeakerPointers computes those pointers
 * so the write stage can reject an ambiguous cast before a frame exists.
 *
 * @module app/series-pipeline
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { BotNodeClient } from '@/features/agent-management';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import { generateEpisodeStoryboard, type StoryboardContext } from '@/features/video-generation';

const logger = createChildLogger({ module: 'series-pipeline' });

export const SCREENPLAY_WRITER_AGENT_ID = 'a0000000-0000-0000-0000-000000000052';

/** @description One character, as the writer returns them. */
export interface CastMember { name: string; description: string }

/** @description One scene of an episode, as the writer returns it. */
export interface Scene {
  n: number;
  camera: string;
  motion: string;
  dialogue: Array<{ who: string; line: string }>;
  reaction?: string | null;
}

/** @description One episode, as the writer returns it. */
export interface WrittenEpisode {
  ordinal: number;
  title: string;
  logline: string;
  scenes: Scene[];
}

/** @description What the writer returns for a whole series. */
export interface WrittenSeries {
  seriesTitle: string;
  styleLock: string;
  cast: CastMember[];
  episodes: WrittenEpisode[];
}

/* ─────────────────────────────── speaker pointers ─────────────────────────────── */

/**
 * @description Resolve the pointer the video model will hear for each character: the last word of
 * the FIRST CLAUSE of their description, widened until unique. Props belong after "with", which is
 * why "bean with two glow sticks" resolves to "bean" and "bean drummer holding two glow sticks"
 * resolves to "sticks".
 * @param {CastMember[]} cast the series cast
 * @returns {Map<string, string>} character name (lowercased) -> pointer noun
 */
export function resolveSpeakerPointers(cast: CastMember[]): Map<string, string> {
  const clauseWords = (c: CastMember): string[] =>
    String(c.description || c.name)
      .split(/[,;—]/)[0]
      .replace(/^an?\s+|^the\s+/i, '')
      .split(/\s+(?:with|who|that|which|holding|carrying)\s+/i)[0]
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  const pointers = new Map<string, string>();
  for (const c of cast) {
    const words = clauseWords(c);
    let n = 1;
    let handle = '';
    do {
      handle = words.slice(-n).join(' ').toLowerCase();
      n += 1;
    } while (
      n <= words.length
      && cast.some((o) => o !== c && clauseWords(o).slice(-(n - 1)).join(' ').toLowerCase() === handle)
    );
    pointers.set(String(c.name).toLowerCase(), handle);
  }
  return pointers;
}

/* ─────────────────────────────── validation ─────────────────────────────── */

/** @description A rule the writer broke, in the writer's terms. */
export interface Violation { where: string; rule: string }

/**
 * @description Enforce the persona's hard rules on what the bot actually returned. This is the
 * cheapest gate in the pipeline and the only one that costs nothing at all.
 * @param {WrittenSeries} written the bot's parsed output
 * @param {{episodeCount: number, scenesPerEpisode: number}} expected what the user asked for
 * @returns {Violation[]} every violation found (empty means renderable)
 */
export function validateWrittenSeries(
  written: WrittenSeries,
  expected: { episodeCount: number; scenesPerEpisode: number },
): Violation[] {
  const v: Violation[] = [];
  const cast = written.cast ?? [];
  if (cast.length < 1) v.push({ where: 'cast', rule: 'a series needs at least one character' });

  // Pointers must be distinct, or two characters answer to the same noun.
  const pointers = resolveSpeakerPointers(cast);
  const seen = new Map<string, string>();
  for (const [name, ptr] of pointers) {
    if (seen.has(ptr)) v.push({ where: `cast: ${name} / ${seen.get(ptr)}`, rule: `both resolve to the pointer "the ${ptr}" — make each description's first clause end in that character's own noun` });
    seen.set(ptr, name);
  }

  const episodes = written.episodes ?? [];
  if (episodes.length !== expected.episodeCount) {
    v.push({ where: 'episodes', rule: `expected ${expected.episodeCount}, got ${episodes.length}` });
  }

  const castNames = new Set(cast.map((c) => c.name.toLowerCase()));
  for (const ep of episodes) {
    const scenes = ep.scenes ?? [];
    if (scenes.length !== expected.scenesPerEpisode) {
      v.push({ where: `ep ${ep.ordinal}`, rule: `expected ${expected.scenesPerEpisode} scenes, got ${scenes.length}` });
    }
    let prevShot = '';
    /** shot type -> the scene number that already used it, across the WHOLE episode. */
    const shots = new Map<string, number>();
    for (const s of scenes) {
      const at = `ep ${ep.ordinal} scene ${s.n}`;
      if (!s.camera?.trim()) v.push({ where: at, rule: 'no camera line' });
      if (!s.motion?.trim()) v.push({ where: at, rule: 'no motion line — the prompt must say what CHANGES' });
      if (!s.dialogue?.length) v.push({ where: at, rule: 'no dialogue — a silent scene renders as characters drifting to music' });

      for (const d of s.dialogue ?? []) {
        if (!castNames.has(String(d.who).toLowerCase())) {
          v.push({ where: at, rule: `"${d.who}" is not in the cast` });
        } else if (s.camera && !s.camera.toLowerCase().includes(String(d.who).toLowerCase())) {
          // The rule that stops a close-up from carrying an off-screen voice.
          v.push({ where: at, rule: `${d.who} speaks but is not named in the camera line — a speaker must be on screen` });
        }
        const words = String(d.line).trim().split(/\s+/).length;
        if (words > 12) v.push({ where: at, rule: `"${d.line.slice(0, 32)}…" is ${words} words — 8 seconds fits ~10` });
      }

      // Consecutive scenes must not open on the same shot type.
      const shot = (s.camera ?? '').toLowerCase().split(/\s+/).slice(0, 2).join(' ');
      if (shot && shot === prevShot) v.push({ where: at, rule: `same shot type as the previous scene ("${shot}") — vary the camera` });
      if (shot) {
        const twin = shots.get(shot);
        // NOT just consecutive. In a four-scene joke the setup and the punchline both want "everyone
        // together", so scene 1 and scene 4 kept coming back as the same wide shot — the consecutive
        // check waved them through and the storyboard's near-duplicate gate then rejected the episode
        // AFTER four images had been paid for. Three of the pump's first seven episodes died exactly
        // there (2026-07-30). Frames are expensive; scripts are cheap — so it is caught here now.
        if (twin !== undefined) {
          v.push({ where: at, rule: `same shot type as scene ${twin} ("${shot}") — every scene needs a different camera, not just a different neighbour` });
        } else {
          shots.set(shot, s.n);
        }
      }
      prevShot = shot;
    }
  }
  return v;
}

/* ─────────────────────────────── the Veo prompt ─────────────────────────────── */

/**
 * @description Build the scene's animation prompt in the grammar the renderer proved out: one
 * motion sentence, the spoken lines addressed by pointer, the reaction after them, one short tail.
 * Nothing describes the picture — the still already is the picture.
 * @param {Scene} scene the scene
 * @param {Map<string,string>} pointers character -> pointer noun
 * @returns {string} the prompt sent to the video model
 */
export function buildScenePrompt(scene: Scene, pointers: Map<string, string>): string {
  const lines: string[] = [`Animate this image. ${scene.motion.trim().replace(/([^.!?])$/, '$1.')}`];
  for (const d of scene.dialogue) {
    const ptr = pointers.get(String(d.who).toLowerCase()) ?? String(d.who).toLowerCase();
    lines.push(`The ${ptr} says: "${String(d.line).replace(/"/g, '')}"`);
  }
  if (scene.reaction?.trim()) lines.push(scene.reaction.trim().replace(/([^.!?])$/, '$1.'));
  lines.push('Speaking voices only, no singing. No subtitles.');
  return lines.join('\n');
}

/* ─────────────────────────────── stage 1: WRITE ─────────────────────────────── */

/** @description Pull the first JSON object out of a bot reply that may be fenced or chatty. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) throw new Error('the writer returned no JSON');
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(body.slice(start, i + 1)); }
  }
  throw new Error('the writer returned unterminated JSON');
}

/**
 * @description WRITE — ask the screenplay-writer to draft the series, validate what came back, and
 * persist the episodes. Rejects rather than "fixes": a script that breaks the rules must not render.
 * @param {AppContext} ctx app context
 * @param {BotNodeClient} botClient bot node client (the writer runs inline; this is the resolver)
 * @param {string} seriesId the series
 * @returns {Promise<{ok: boolean, episodes?: number, violations?: Violation[], error?: string}>} result
 */
export async function writeSeries(
  ctx: AppContext,
  botClient: BotNodeClient,
  seriesId: string,
): Promise<{ ok: boolean; episodes?: number; violations?: Violation[]; error?: string }> {
  const { rows } = await ctx.pool.query(
    `SELECT user_sub, title, premise, style_lock, cast_bible, episode_count, scenes_per_episode
       FROM video_series WHERE series_id = $1`, [seriesId],
  );
  const s = rows[0] as Record<string, unknown> | undefined;
  if (!s) return { ok: false, error: 'series not found' };

  const userCast = Array.isArray(s.cast_bible) ? (s.cast_bible as CastMember[]) : [];
  const scenesPer = Number(s.scenes_per_episode);

  // The persona carries HOW to write (the laws). The caller carries the machine-readable CONTRACT —
  // the same split video-director uses. Without the shape restated here the bot writes a good script
  // in an invented JSON shape, and every field parses as undefined (observed live 2026-07-08).
  const prompt = [
    `Write the series "${String(s.title)}".`,
    ``,
    `Premise: ${String(s.premise)}`,
    s.style_lock ? `Style lock: ${String(s.style_lock)}` : 'Style lock: choose one and state it.',
    userCast.length ? `Cast — use EXACTLY these, do not rename or add: ${JSON.stringify(userCast)}` : 'Cast: invent one that fits.',
    ``,
    `Write exactly ${Number(s.episode_count)} episode(s), each with EXACTLY ${scenesPer} scenes.`,
    ``,
    `HARD RULES, enforced by the renderer — a script that breaks any of them is rejected and nothing renders:`,
    `  1. Every scene has at least one spoken line. There is NO narrator; the characters carry the story.`,
    `  2. A character may only speak in a scene whose "camera" text NAMES them. A speaker must be on screen.`,
    `  3. "camera" states the shot type, the distance, and who is in frame. Consecutive scenes must NOT open`,
    `     with the same shot type (vary: wide / close-up / two-shot / low-angle). End it with`,
    `     "No text anywhere in the image."`,
    `  4. "motion" says only what CHANGES, in plain verbs ("The pancake springs upward."). Never describe the`,
    `     scenery, the colours, or the mood — the still image already is the picture.`,
    `  5. Spoken lines are 10 words or fewer.`,
    `  6. "reaction" is null, or one short motion sentence ("Everyone laughs.") that lands AFTER the dialogue.`,
    ``,
    `Return ONLY this JSON object. No prose before or after it, no markdown fence:`,
    JSON.stringify({
      seriesTitle: 'string',
      styleLock: 'one line naming the medium and look',
      cast: [{ name: 'Character Name', description: "first clause ends in the character's own noun; props after 'with'; personality after ';'" }],
      episodes: [{
        ordinal: 1,
        title: 'string',
        logline: 'one sentence',
        scenes: Array.from({ length: scenesPer }, (_, i) => ({
          n: i + 1,
          camera: 'shot type, distance, who is in frame. No text anywhere in the image.',
          motion: 'what changes, plain verbs',
          dialogue: [{ who: 'Character Name', line: 'ten words or fewer' }],
          reaction: null,
        })),
      }],
    }, null, 2),
  ].join('\n');

  logger.info({ seriesId, episodes: s.episode_count, scenes: s.scenes_per_episode }, 'WRITE stage: asking the screenplay-writer');
  const userSub = String(s.user_sub);
  // userSub is load-bearing, not decoration: the inline path records the call's cost in chat_tasks,
  // whose RLS WITH CHECK requires the row's user_sub to match the request's caller. Omit it and the
  // bot runs, then the cost insert is rejected and the whole call fails.
  const reply = await executeBotOrInline(ctx, botClient, SCREENPLAY_WRITER_AGENT_ID, {
    text: prompt,
    taskId: `series-write-${seriesId}`,
    workspaceFolderId: `series-${seriesId}`,
    agentId: SCREENPLAY_WRITER_AGENT_ID,
    agenticMode: true,
    direct: true,
    userSub,
  });

  const text = String((reply as { response?: string; content?: string }).response
    ?? (reply as { content?: string }).content ?? '');
  if (!text.trim()) return { ok: false, error: 'the writer returned nothing' };

  let written: WrittenSeries;
  try { written = extractJson(text) as WrittenSeries; }
  catch (err) { return { ok: false, error: `could not parse the writer's reply: ${(err as Error).message}` }; }

  const violations = validateWrittenSeries(written, {
    episodeCount: Number(s.episode_count),
    scenesPerEpisode: Number(s.scenes_per_episode),
  });
  if (violations.length) {
    logger.warn({ seriesId, violations }, 'WRITE stage: script rejected — it would not render well');
    await ctx.pool.query(`UPDATE video_series SET status='failed', error=$2, updated_at=now() WHERE series_id=$1`,
      [seriesId, `script rejected: ${violations.map((x) => `${x.where}: ${x.rule}`).join(' | ')}`]);
    return { ok: false, violations };
  }

  for (const ep of written.episodes) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.pool.query(
      `INSERT INTO video_episodes (series_id, user_sub, ordinal, title, logline, scenes, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'scripted')
       ON CONFLICT (series_id, ordinal)
       DO UPDATE SET title=EXCLUDED.title, logline=EXCLUDED.logline, scenes=EXCLUDED.scenes,
                     status='scripted', error=NULL, updated_at=now()`,
      [seriesId, String(s.user_sub), ep.ordinal, ep.title, ep.logline ?? '', JSON.stringify(ep.scenes)],
    );
  }
  await ctx.pool.query(
    `UPDATE video_series SET style_lock = COALESCE(style_lock, $2), cast_bible = $3::jsonb,
        status='awaiting_approval', error=NULL, updated_at=now() WHERE series_id=$1`,
    [seriesId, written.styleLock, JSON.stringify(written.cast)],
  );

  logger.info({ seriesId, episodes: written.episodes.length }, 'WRITE stage: episodes persisted, awaiting approval');
  return { ok: true, episodes: written.episodes.length };
}

/* ─────────────────────────────── stage 2: STORYBOARD ─────────────────────────────── */

/**
 * @description STORYBOARD — one still per scene, cast held by an anchor frame, near-duplicates
 * rejected. Frames are uploaded to Drive because the node cannot be reached over the LAN.
 *
 * The image vendor is NOT decided here. STORYBOARD_IMAGE_PROVIDER chooses it (default `codex`, the
 * operator's own OpenAI account); a provider that is not configured fails closed rather than falling
 * through to one that bills per image.
 *
 * @param {Pool} pool database pool
 * @param {string} episodeId the episode
 * @param {(png: Buffer, name: string) => Promise<string>} uploadFrame returns the Drive file id
 * @param {{vertexToken?: string}} creds credentials the selected provider may need
 * @returns {Promise<{ok: boolean, frameIds?: string[], duplicates?: string[], error?: string}>} result
 */
export async function storyboardEpisode(
  pool: Pool,
  episodeId: string,
  uploadFrame: (png: Buffer, name: string) => Promise<string>,
  creds: { vertexToken?: string } = {},
): Promise<{ ok: boolean; frameIds?: string[]; duplicates?: string[]; error?: string }> {
  const { rows } = await pool.query(
    `SELECT e.scenes, e.title, e.ordinal, s.style_lock, s.cast_bible
       FROM video_episodes e JOIN video_series s ON s.series_id = e.series_id
      WHERE e.episode_id = $1`, [episodeId],
  );
  const e = rows[0] as Record<string, unknown> | undefined;
  if (!e) return { ok: false, error: 'episode not found' };

  const scenes = (Array.isArray(e.scenes) ? e.scenes : []) as Scene[];
  if (!scenes.length) return { ok: false, error: 'episode has no scenes — the write stage has not run' };

  const ctx: StoryboardContext = {
    styleLock: String(e.style_lock ?? ''),
    cast: (Array.isArray(e.cast_bible) ? e.cast_bible : []) as CastMember[],
    vertexToken: creds.vertexToken,
  };

  logger.info({ episodeId, scenes: scenes.length }, 'STORYBOARD stage: generating stills');
  const { frames, distinct } = await generateEpisodeStoryboard(
    scenes.map((s) => ({ n: s.n, camera: s.camera })), ctx,
  );

  if (!distinct.ok) {
    // The cheapest place this mistake can possibly be caught. Never let it reach a render.
    await pool.query(`UPDATE video_episodes SET status='failed', error=$2, updated_at=now() WHERE episode_id=$1`,
      [episodeId, `storyboard rejected: ${distinct.duplicates.join('; ')}`]);
    return { ok: false, duplicates: distinct.duplicates };
  }

  const frameIds: string[] = [];
  for (const f of frames) {
    // eslint-disable-next-line no-await-in-loop
    frameIds.push(await uploadFrame(f.png, `ep${Number(e.ordinal)}-scene-${String(f.n).padStart(2, '0')}.png`));
  }
  await pool.query(
    `UPDATE video_episodes SET frame_ids=$2::jsonb, status='storyboarded', error=NULL, updated_at=now()
      WHERE episode_id=$1`, [episodeId, JSON.stringify(frameIds)],
  );
  logger.info({ episodeId, frames: frameIds.length }, 'STORYBOARD stage: stills ready');
  return { ok: true, frameIds };
}

/**
 * @description The render payload the node needs: which still, and what motion + speech to animate
 * over it. Built here so the node never re-interprets a script.
 * @param {Scene[]} scenes the episode's scenes
 * @param {string[]} frameIds Drive ids, in scene order
 * @param {CastMember[]} cast for speaker pointers
 * @returns {Array<{n:number, frameId:string, prompt:string}>} one entry per scene
 */
export function buildRenderPlan(
  scenes: Scene[],
  frameIds: string[],
  cast: CastMember[],
): Array<{ n: number; frameId: string; prompt: string }> {
  const pointers = resolveSpeakerPointers(cast);
  return scenes.map((s, i) => ({ n: s.n, frameId: frameIds[i], prompt: buildScenePrompt(s, pointers) }));
}
