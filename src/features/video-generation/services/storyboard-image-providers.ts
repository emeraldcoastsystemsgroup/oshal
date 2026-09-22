/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Storyboard image generation behind a provider interface. Codex (the operator's own OpenAI account) is the DEFAULT; ComfyUI on the GPU box is the free local sibling; Vertex is a paid fallback that must be asked for by name.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | openrouter sibling: the swarm's OpenRouter key driving an image-capable chat model (default gemini-2.5-flash-image, image-to-image via data-URL parts). Needed because the codex identity is a ChatGPT-subscription OAuth token and api.openai.com/v1/images REJECTS those (misleading "token has expired" for a token valid to 07-22) — subscription auth works for the codex backend, never for the platform Images API. Explicit selection only, paid per image, fail-closed like its siblings.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | codex provider resolves the PLATFORM realm only (getSwarmPlatformApiKey): the mounted ChatGPT-subscription OAuth made available() read true while every /v1/images call 401'd (re-verified 2026-08-21 — missing scope api.model.images.request). Selection now fails closed at resolve time with the paste-a-platform-key hint instead of burning a doomed vendor call; codex gains a real healthCheck (GET /v1/models: 200 = platform key, 403 = subscription realm); the resolver hint no longer suggests the ChatGPT login for images.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | codex-cli sibling (ADR-130): renders through the swarm's own codex HARNESS on a bot node — codex CLI 0.147+ has native image generation (proven live 2026-08-22 on the bind-mounted ChatGPT login: text-to-image AND anchored edits, gpt-5.5 and gpt-5.6-sol both), which the subscription CAN use even though the platform Images API rejects it. The controller never spawns the CLI: an app-boot-registered executor (storyboard-cli-image-executor) delegates to a bot node over swarm-execute, where the SEC-05 demo carve (DEMO_MODE + operator sub) governs the spawn; files travel via the shared workspace volume. Demo-mode default: with STORYBOARD_IMAGE_PROVIDER unset and DEMO_MODE on, selection now defaults to codex-cli (config → swarm env → demo default); explicit env always wins.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | comfyui is a real provider, not a throw. Submit/poll/fetch against the ComfyUI HTTP API, the same protocol and shape as the video sibling providers/comfyui-provider.ts (ADR-070): probe /system_stats, inject the frame prompt into a pinned API-format workflow, POST /prompt, poll /history, fetch /view, and reject anything that is not a PNG. Built on the operator's 2026-09-21 decision: it is free per image, and it is the ONLY free rail that can serve a caller who is not the operator — the codex-cli sibling sits behind the DEMO_MODE + operator-sub carve — on the same box a trained LoRA lands on. URL reuses COMFYUI_URL (one box, one key to rotate); the workflow needs its own COMFYUI_STORYBOARD_WORKFLOW because COMFYUI_WORKFLOW_PATH is a text-to-VIDEO graph. The wait is bounded TWICE (wall-clock deadline + attempt cap) by COMFYUI_STORYBOARD_TIMEOUT_MS so a sleeping GPU box fails visibly instead of hanging the stage, and the timeout message avoids a bare HTTP-status number so the caller's retry classifier does not treat it as transient. available()/healthCheck() share one status() that names WHICH of url/workflow/reachability is missing, and the resolver's comfyui hint now quotes it. An anchor frame is uploaded via /upload/image into an optional %ANCHOR% slot; a workflow without that slot logs a WARN rather than silently rendering unanchored against a prompt that says "use the reference image".
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Entry 5's "bounded TWICE" was false, and adversarial verification measured it: only the /history poll carried a signal, so a black-holed /prompt rejected after 304753 ms on the OS socket timeout (203x the configured window, knob never consulted) and a black-holed /view or /upload/image was still pending at 20 s. Now ONE deadline is taken at the top of generate() and EVERY call — upload, submit, each poll, fetch — goes through comfyFetch with a signal cut from what is left of it, so the window bounds the whole frame and a hung hop is reported by route name instead of as undici's bare "fetch failed". Also from the same verification: the anchor upload sends a per-call unique filename and no `overwrite`, because LoadImage reads its file at node-EXECUTION time and a fixed shared name let caller B's anchor render into caller A's queued frame on the one rail that serves more than the operator; status() now performs the same workflow load generate() does (parse + require the %PROMPT% slot), so a corrupt or slotless workflow no longer reads as a green "ready" on the Test Lab card; a /history body that is not an object and a `messages` that is not an array are both handled instead of crashing the reporting path; and a non-2xx /history answer is warned about once per distinct status and named in the final timeout message (as HTTP_5xx, kept out of the caller's transient classifier on purpose).
 */
/**
 * @description Storyboard image providers — siblings behind one interface.
 *
 * The first cut of the storyboard stage called Vertex directly. That was wrong for the same reason
 * TTS must never hardcode Polly: a vendor belongs behind an interface, chosen at runtime, never
 * welded into the feature (CLAUDE.md). Vertex also *bills per image*, which is how a night of frame
 * regeneration turned into real money.
 *
 * The order of preference is a cost order, not a taste order:
 *
 *   codex    the operator's own OpenAI account (`gpt-image-1`). DEFAULT. PLATFORM key only —
 *            `openAiApiKey` in config/seed, or `OPENAI_API_KEY`. The codex ChatGPT-subscription
 *            login is a different auth realm and is never offered here: /v1/images always
 *            rejects it (ADR-082, re-verified 2026-08-21).
 *   comfyui  the GPU box that already runs LoRA. FREE. No per-image charge, and the place a trained
 *            character LoRA makes cast consistency exact rather than approximate. It is also the
 *            only free rail that can serve a caller who is NOT the operator: codex-cli below is
 *            behind the DEMO_MODE + operator-sub carve. Needs COMFYUI_URL +
 *            COMFYUI_STORYBOARD_WORKFLOW.
 *   vertex   `gemini-2.5-flash-image`. PAID, per image. Never selected implicitly.
 *
 * Selection is explicit (`STORYBOARD_IMAGE_PROVIDER`) and FAILS CLOSED: if the chosen provider is
 * not configured we throw with instructions rather than quietly falling through to the one that
 * charges. A silent fallback to a paid vendor is the bug, not the fix.
 *
 * @module features/video-generation/services/storyboard-image-providers
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { getSwarmApiKey, hasSwarmApiKey, getSwarmPlatformApiKey, hasSwarmPlatformApiKey } from '@/features/llm-provider';
import { vertexProjectLocation } from './veo-client';
import { resolveCliStoryboardImageExecutor } from './storyboard-cli-image-executor';

const logger = createChildLogger({ module: 'storyboard-image-providers' });

/** @description A metadata-aware generation result: the still plus what it actually cost. */
export interface StoryboardImageResult {
  image: Buffer;
  /** Vendor-reported cost in USD for this one image, or null when the vendor doesn't say. */
  costUsd: number | null;
  /** The concrete model that produced the image. */
  model: string;
}

/** @description What a storyboard image provider must do: make one still, optionally matching a reference. */
export interface StoryboardImageProvider {
  readonly id: 'codex' | 'comfyui' | 'vertex' | 'openrouter' | 'codex-cli';
  /** 'free' costs nothing per image; 'paid' bills the caller per image. */
  readonly costClass: 'free' | 'paid';
  /** Configured and reachable right now? Cheap: no generation. */
  available(): Promise<boolean>;
  /**
   * Generate one PNG.
   * @param prompt the frame prompt (camera + style + the no-text tail)
   * @param anchor an earlier frame to match for cast/world consistency, or null
   */
  generate(prompt: string, anchor: Buffer | null): Promise<Buffer>;
  /**
   * Optional richer sibling of generate(): same call, plus vendor-reported cost + model so the
   * caller can capture spend in the canonical ledger (recordStoryboardImageCost). Providers
   * whose vendor reports per-call cost should implement it; callers fall back to generate().
   */
  generateWithMeta?(prompt: string, anchor: Buffer | null): Promise<StoryboardImageResult>;
  /**
   * Optional REAL credential probe — a cheap vendor call proving the key actually works, vs
   * available()'s key-presence check. Key-presence lies: an expired/wrong-audience token still
   * "exists" (that is exactly how the codex ChatGPT token read as configured while /v1/images
   * rejected every call).
   */
  healthCheck?(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * @description A cheap, real probe of the swarm's PLATFORM OpenAI key. `GET /v1/models` is the
 * discriminating call for the auth realm: a platform key answers 200; the ChatGPT-subscription
 * codex token answers 403 (ADR-082) — the truthful version of "configured".
 * @param {string} model the image model the codex provider would run, named in the detail
 * @returns {Promise<{ok: boolean, detail: string}>} probe verdict, never a thrown error
 */
async function probeOpenAiPlatformKey(model: string): Promise<{ ok: boolean; detail: string }> {
  const key = getSwarmPlatformApiKey('openai');
  if (!key) {
    return { ok: false, detail: 'no PLATFORM OpenAI key — set OPENAI_API_KEY in .env, or openAiApiKey in config-seed/secrets.json. The ChatGPT-subscription codex login cannot generate images.' };
  }
  try {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const realmNote = res.status === 403 ? ' (subscription-realm token, not a platform key)' : '';
      return { ok: false, detail: `platform key rejected: HTTP ${res.status}${realmNote}` };
    }
    return { ok: true, detail: `platform key valid (model ${model})` };
  } catch (err) {
    return { ok: false, detail: `key probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * @description Codex provider — the swarm's own OpenAI identity. The default.
 *
 * The credential comes from the SWARM's credential resolver, PLATFORM realm only
 * (`getSwarmPlatformApiKey('openai')`): the codex ChatGPT-subscription OAuth token authenticates
 * the codex chat backend but is forbidden on `/v1/images`, so offering it here made `available()`
 * lie while every generation 401'd. This module must never read a key out of `process.env` or
 * `~/.codex/auth.json` itself: a bespoke read creates a second, invisible credential path the
 * operator never configured and cannot rotate.
 *
 * @returns {StoryboardImageProvider} the provider
 */
export function createCodexImageProvider(): StoryboardImageProvider {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  return {
    id: 'codex',
    costClass: 'paid', // the swarm's own account, but still per-image — say so plainly
    available: async () => hasSwarmPlatformApiKey('openai'),
    healthCheck: async () => probeOpenAiPlatformKey(model),
    generate: async (prompt, anchor) => {
      const key = getSwarmPlatformApiKey('openai');
      if (!key) throw new Error('codex image provider: the swarm holds no PLATFORM OpenAI key — set OPENAI_API_KEY in .env, or openAiApiKey in config-seed/secrets.json. The ChatGPT-subscription codex login cannot call /v1/images.');

      // With a reference frame this is an EDIT (image-to-image), which is what holds a cast together
      // across scenes. Without one it is a plain generation.
      const url = anchor
        ? 'https://api.openai.com/v1/images/edits'
        : 'https://api.openai.com/v1/images/generations';

      let res: Response;
      if (anchor) {
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('size', process.env.OPENAI_IMAGE_SIZE || '1024x1024');
        form.append('image', new Blob([new Uint8Array(anchor)], { type: 'image/png' }), 'anchor.png');
        res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
      } else {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, size: process.env.OPENAI_IMAGE_SIZE || '1024x1024', n: 1 }),
        });
      }
      if (!res.ok) throw new Error(`codex image provider: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const body = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> };
      const first = body.data?.[0];
      if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
      if (first?.url) {
        const img = await fetch(first.url);
        if (!img.ok) throw new Error(`codex image provider: fetching result HTTP ${img.status}`);
        return Buffer.from(await img.arrayBuffer());
      }
      throw new Error('codex image provider: response carried no image');
    },
  };
}

/** The prompt slot a pinned storyboard workflow must carry; the frame prompt replaces it. */
export const COMFY_PROMPT_TOKEN = '%PROMPT%';
/** The optional reference-image slot: present means the workflow can hold a cast across scenes. */
export const COMFY_ANCHOR_TOKEN = '%ANCHOR%';
/** Gap between `/history` polls. Storyboard stills finish in seconds, not the video path's minutes. */
const COMFY_POLL_INTERVAL_MS = 1_500;
/** Default bound on one frame's submit→poll→fetch. Overridden by COMFYUI_STORYBOARD_TIMEOUT_MS. */
const COMFY_DEFAULT_TIMEOUT_MS = 180_000;
/** Bound on the cheap reachability/poll calls, so an asleep box answers "unavailable", not "hang". */
const COMFY_PROBE_TIMEOUT_MS = 4_000;
/** The poll never sleeps more than this fraction of what is left, so a short window still gets polls. */
const COMFY_POLLS_PER_WINDOW = 4;

/** A media file ComfyUI reports in a node's `outputs` map. */
interface ComfyStoryboardFile { filename: string; subfolder?: string; type?: string }

/** One `/history/{prompt_id}` entry, as far as this provider reads it. */
interface ComfyHistoryEntry {
  status?: { status_str?: string; messages?: unknown[] };
  outputs?: Record<string, unknown>;
}

/** A live reference to one workflow input string that carries a placeholder token. */
interface ComfySlot { inputs: Record<string, unknown>; key: string; text: string }

/**
 * @description The bounded wait for one storyboard frame, in milliseconds. Configuration, never a
 * literal: a slow box gets a bigger number in `.env` rather than a code change, and a bad value
 * falls back to the default instead of disabling the bound.
 * @returns {number} the poll window in milliseconds
 */
function comfyStoryboardTimeoutMs(): number {
  const raw = Number(process.env.COMFYUI_STORYBOARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : COMFY_DEFAULT_TIMEOUT_MS;
}

/**
 * @description Find every workflow input string carrying `token`, as live references we can rewrite.
 * Returned rather than replaced so the caller can decide what to do when a slot is absent — an
 * absent prompt slot is a fatal misconfiguration, an absent anchor slot is only a dropped reference.
 * @param {Record<string, unknown>} workflow an API-format ComfyUI workflow (already cloned)
 * @param {string} token the placeholder to look for
 * @returns {ComfySlot[]} one entry per input string containing the token
 */
function comfyTokenSlots(workflow: Record<string, unknown>, token: string): ComfySlot[] {
  const slots: ComfySlot[] = [];
  for (const node of Object.values(workflow)) {
    const inputs = (node as { inputs?: Record<string, unknown> })?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === 'string' && value.includes(token)) slots.push({ inputs, key, text: value });
    }
  }
  return slots;
}

/**
 * @description Substitute `value` for every occurrence of `token` in the given slots, in place.
 * @param {ComfySlot[]} slots the slots returned by comfyTokenSlots
 * @param {string} token the placeholder being filled
 * @param {string} value the replacement text
 * @returns {void}
 */
function fillComfySlots(slots: ComfySlot[], token: string, value: string): void {
  for (const slot of slots) slot.inputs[slot.key] = slot.text.split(token).join(value);
}

/**
 * @description Pull the first image file out of a `/history` outputs map.
 * @param {Record<string, unknown>} outputs the finished job's per-node outputs
 * @returns {ComfyStoryboardFile | null} the first saved image, or null when the graph saved none
 */
function firstComfyImage(outputs: Record<string, unknown>): ComfyStoryboardFile | null {
  for (const out of Object.values(outputs)) {
    const files = (out as { images?: ComfyStoryboardFile[] })?.images;
    if (Array.isArray(files) && files[0]?.filename) return files[0];
  }
  return null;
}

/**
 * @description Turn a failed job's history entry into one readable line. ComfyUI reports failures as
 * `status.messages` tuples carrying the Python exception; surfacing it is what makes a wrong model
 * name or a missing LoRA legible instead of "the job failed".
 * @param {ComfyHistoryEntry} entry the history entry whose status_str is 'error'
 * @returns {string} the box's own error text, bounded in length
 */
function describeComfyFailure(entry: ComfyHistoryEntry): string {
  // The box's own error path must not itself throw: a non-array here is "no message", not a crash.
  const messages = Array.isArray(entry.status?.messages) ? entry.status.messages : [];
  for (const message of messages) {
    const payload = Array.isArray(message) ? message[1] : message;
    const detail = (payload as { exception_message?: unknown } | null)?.exception_message;
    if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 240);
  }
  return 'the box reported an execution error with no message';
}

/**
 * @description One ComfyUI call under the frame's shared deadline. EVERY call the provider makes
 * goes through here — upload, submit, each poll, fetch — so the configured window bounds the whole
 * frame, not one hop of it. A call that outlives what is left of the window is aborted and reported
 * as such, with the route named, rather than surfacing as undici's bare "fetch failed" minutes later
 * on the operating system's own socket timeout.
 * @param {string} base the ComfyUI base URL, no trailing slash
 * @param {string} route the path (and query) under the base
 * @param {RequestInit} init method/headers/body for the call
 * @param {number} deadline epoch-ms at which the whole frame is out of time
 * @param {number} [cap] an optional per-call bound tighter than the remaining window (the poll's)
 * @returns {Promise<Response>} the response, or a thrown error naming the route and the bound
 */
async function comfyFetch(base: string, route: string, init: RequestInit, deadline: number, cap?: number): Promise<Response> {
  const remaining = deadline - Date.now();
  const routeName = route.split('?')[0];
  const exhausted = (): Error => new Error(`comfyui storyboard provider: ${routeName} did not answer inside the bounded window — the GPU box may be asleep, wedged, or queued behind other work. Raise COMFYUI_STORYBOARD_TIMEOUT_MS if it is simply slow.`);
  if (remaining <= 0) throw exhausted();
  const signal = AbortSignal.timeout(cap ? Math.min(cap, remaining) : remaining);
  try {
    return await fetch(`${base}${route}`, { ...init, signal });
  } catch (err) {
    if (signal.aborted) throw exhausted();
    throw err;
  }
}

/**
 * @description Read, parse and validate the pinned storyboard workflow. Shared by the readiness
 * probe and by generate() so the two cannot disagree: a workflow the probe calls ready is one
 * generate() can submit. Throws plain (unprefixed) messages naming the specific defect.
 * @param {string} wf the COMFYUI_STORYBOARD_WORKFLOW path
 * @returns {Record<string, unknown>} the parsed API-format workflow, carrying at least one prompt slot
 */
function loadComfyStoryboardWorkflow(wf: string): Record<string, unknown> {
  if (!fs.existsSync(wf)) throw new Error(`COMFYUI_STORYBOARD_WORKFLOW points at a file that does not exist: ${wf}`);
  let workflow: unknown;
  try {
    workflow = JSON.parse(fs.readFileSync(wf, 'utf8'));
  } catch (err) {
    throw new Error(`COMFYUI_STORYBOARD_WORKFLOW at ${wf} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — export it from ComfyUI in API format`);
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error(`COMFYUI_STORYBOARD_WORKFLOW at ${wf} is not an API-format workflow object`);
  }
  const parsed = workflow as Record<string, unknown>;
  if (!comfyTokenSlots(parsed, COMFY_PROMPT_TOKEN).length) {
    throw new Error(`COMFYUI_STORYBOARD_WORKFLOW at ${wf} carries no ${COMFY_PROMPT_TOKEN} placeholder, so the frame prompt would never reach the box and every frame would render the template's own fixed prompt`);
  }
  return parsed;
}

/**
 * @description Upload the anchor frame so a LoadImage node in the pinned workflow can reference it.
 * This is what makes ComfyUI image-to-image: the caller's anchored prompt literally instructs the
 * model to "use the reference image", so a provider that accepted an anchor and never sent it would
 * render a frame against an instruction that points at nothing.
 *
 * The filename is unique per call and `overwrite` is NOT sent. ComfyUI's LoadImage reads its file
 * at node-EXECUTION time, so a fixed name shared by two concurrent storyboard runs would let caller
 * B's anchor render into caller A's still-queued frame — on the one rail that serves more than the
 * operator. The name the box actually stored is what gets injected, never the name we asked for.
 * @param {string} base the ComfyUI base URL, no trailing slash
 * @param {Buffer} anchor the earlier frame to match
 * @param {number} deadline epoch-ms at which the whole frame is out of time
 * @returns {Promise<string>} the name (subfolder-qualified) a LoadImage node should load
 */
async function uploadComfyAnchor(base: string, anchor: Buffer, deadline: number): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(anchor)], { type: 'image/png' }), `oshal-anchor-${randomUUID()}.png`);
  const res = await comfyFetch(base, '/upload/image', { method: 'POST', body: form }, deadline);
  if (!res.ok) {
    throw new Error(`comfyui storyboard provider: /upload/image answered HTTP ${res.status} — ${(await res.text()).slice(0, 240)}`);
  }
  const body = await res.json() as { name?: string; subfolder?: string };
  if (!body.name) throw new Error('comfyui storyboard provider: /upload/image returned no filename for the reference frame');
  return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
}

/**
 * @description One `/history/{prompt_id}` poll, parsed and shape-checked. Returns null for anything
 * that is not yet an answer — a non-2xx, a body that is not an object, no entry for this id — so
 * the loop's only job is to decide whether to keep waiting. Non-2xx answers are counted by status
 * and warned about ONCE per distinct status: a box 500-ing on every poll is a finding, not noise.
 * @param {string} base the ComfyUI base URL, no trailing slash
 * @param {string} promptId the id `/prompt` returned for this submission
 * @param {number} deadline epoch-ms at which the whole frame is out of time
 * @param {Map<number, number>} seen non-2xx statuses seen so far, by count (mutated)
 * @returns {Promise<ComfyHistoryEntry | null>} this job's history entry, or null to keep polling
 */
async function pollComfyHistory(base: string, promptId: string, deadline: number, seen: Map<number, number>): Promise<ComfyHistoryEntry | null> {
  const res = await comfyFetch(base, `/history/${promptId}`, {}, deadline, COMFY_PROBE_TIMEOUT_MS);
  if (!res.ok) {
    const count = (seen.get(res.status) ?? 0) + 1;
    seen.set(res.status, count);
    if (count === 1) logger.warn({ promptId, status: res.status }, 'comfyui /history answered non-2xx; continuing to poll until the window closes');
    return null;
  }
  const history = await res.json() as unknown;
  if (!history || typeof history !== 'object') return null;
  const entry = (history as Record<string, ComfyHistoryEntry | undefined>)[promptId];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * @description Poll `/history/{prompt_id}` until the job produces an image, fails, or the frame's
 * shared deadline passes. Bounded by that deadline, by an attempt cap derived from it, and per call
 * through comfyFetch — so neither a stalled clock, a degenerate interval, nor one hung poll can leave
 * a storyboard stage waiting on a sleeping GPU box. A failure here is loud: it throws with what the
 * box said, including the non-2xx answers it gave while we waited.
 * @param {string} base the ComfyUI base URL, no trailing slash
 * @param {string} promptId the id `/prompt` returned for this submission
 * @param {number} deadline epoch-ms at which the whole frame is out of time
 * @returns {Promise<ComfyStoryboardFile>} the saved image the job produced
 */
async function awaitComfyStoryboardImage(base: string, promptId: string, deadline: number): Promise<ComfyStoryboardFile> {
  const window = Math.max(1, deadline - Date.now());
  const interval = Math.max(50, Math.min(COMFY_POLL_INTERVAL_MS, Math.floor(window / COMFY_POLLS_PER_WINDOW)));
  const maxAttempts = Math.max(1, Math.ceil(window / interval));
  const seen = new Map<number, number>();
  for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(1, deadline - Date.now()))));
    let entry: ComfyHistoryEntry | null;
    try {
      // eslint-disable-next-line no-await-in-loop
      entry = await pollComfyHistory(base, promptId, deadline, seen);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, promptId, attempt }, 'comfyui storyboard history poll failed');
      continue;
    }
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      throw new Error(`comfyui storyboard provider: job ${promptId} failed on the box — ${describeComfyFailure(entry)}`);
    }
    if (!entry.outputs) continue;
    const file = firstComfyImage(entry.outputs);
    if (file) return file;
    throw new Error(`comfyui storyboard provider: job ${promptId} finished but saved no image — the pinned workflow needs a SaveImage node`);
  }
  // Deliberately worded without a bare HTTP-status number, including in the statuses we observed
  // (HTTP_500, not "HTTP 500"): the caller's retry classifier treats a bare 5xx as transient, and
  // burning MAX_ATTEMPTS whole windows against a box that 500'd for three minutes is not a retry.
  const observed = seen.size
    ? ` While waiting, /history answered ${[...seen].map(([status, n]) => `HTTP_${status} (${n}x)`).join(', ')} instead of the job.`
    : ' The box accepted the job and never reported it finished.';
  throw new Error(`comfyui storyboard provider: job ${promptId} did not finish inside the bounded window of ${Math.round(comfyStoryboardTimeoutMs() / 1000)}s.${observed} The GPU box may be asleep, wedged, or queued behind other work; raise COMFYUI_STORYBOARD_TIMEOUT_MS if it is simply slow.`);
}

/**
 * @description ComfyUI provider — the GPU box that already runs LoRA training. FREE: no per-image
 * charge, only the operator's own compute, and it is the one free rail that serves a caller who is
 * NOT the operator (the codex-cli sibling sits behind the DEMO_MODE + operator-sub carve). It is
 * also the box a trained character LoRA lands on, so a workflow pinned here makes the operator's own
 * trained styles usable in storyboards (operator decision, 2026-09-21).
 *
 * Protocol is the video sibling's, exactly (`providers/comfyui-provider.ts`, ADR-070): probe
 * `/system_stats`, inject the prompt into an API-format workflow, `POST /prompt`, poll `/history`,
 * fetch `/view`. Configuration:
 *
 *   COMFYUI_URL                    the box. Reused, not duplicated — it is the SAME ComfyUI server
 *                                  the video provider drives, and a second URL key would be a
 *                                  second place to rotate one host and a silent divergence when
 *                                  only one of them is updated.
 *   COMFYUI_STORYBOARD_WORKFLOW    the path to an API-format IMAGE workflow carrying a %PROMPT%
 *                                  placeholder (and optionally %ANCHOR% on a LoadImage input). This
 *                                  one IS its own key: the video path's COMFYUI_WORKFLOW_PATH is a
 *                                  text-to-VIDEO graph and cannot render a still.
 *   COMFYUI_STORYBOARD_TIMEOUT_MS  the window for the WHOLE frame — upload, submit, every poll
 *                                  and the fetch all draw on it — default 180000.
 *
 * @returns {StoryboardImageProvider} the provider
 */
export function createComfyUiImageProvider(): StoryboardImageProvider {
  const base = (): string => (process.env.COMFYUI_URL || '').trim().replace(/\/+$/, '');
  const workflowPath = (): string => (process.env.COMFYUI_STORYBOARD_WORKFLOW || '').trim();

  /**
   * The single truth behind both available() and healthCheck(): what is configured, and does the
   * box answer. Never throws — an unreachable GPU box is an unavailable provider with a stated
   * reason, not a crashed storyboard stage, and never a silent fall-through to a paid sibling.
   */
  const status = async (): Promise<{ ok: boolean; detail: string }> => {
    const u = base();
    if (!u) return { ok: false, detail: 'COMFYUI_URL is not set — point it at the GPU box running ComfyUI (the same box the video provider uses)' };
    const wf = workflowPath();
    if (!wf) return { ok: false, detail: `COMFYUI_STORYBOARD_WORKFLOW is not set — export the image workflow from ComfyUI in API format, put ${COMFY_PROMPT_TOKEN} in its positive-prompt text, and point this at the file` };
    // The same load generate() performs: a workflow that is missing, corrupt, or slotless is NOT
    // "ready", and saying it was is the false-green the readiness card exists to prevent.
    try {
      loadComfyStoryboardWorkflow(wf);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    try {
      const res = await fetch(`${u}/system_stats`, { signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, detail: `ComfyUI at ${u} answered /system_stats with HTTP ${res.status}` };
      return { ok: true, detail: `ComfyUI reachable at ${u}, workflow ${path.basename(wf)}, bounded at ${Math.round(comfyStoryboardTimeoutMs() / 1000)}s per frame` };
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, base: u }, 'comfyui storyboard reachability probe failed');
      return { ok: false, detail: `ComfyUI at ${u} is unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  return {
    id: 'comfyui',
    costClass: 'free',
    available: async () => (await status()).ok,
    healthCheck: status,
    generate: async (prompt, anchor) => {
      const u = base();
      if (!u) throw new Error('comfyui storyboard provider: COMFYUI_URL is not set');
      const wf = workflowPath();
      if (!wf) throw new Error('comfyui storyboard provider: COMFYUI_STORYBOARD_WORKFLOW is not set');
      // One deadline for the WHOLE frame. Every call below — upload, submit, each poll, fetch —
      // draws on what is left of it, so the configured window bounds the frame, not one hop.
      const deadline = Date.now() + comfyStoryboardTimeoutMs();

      let workflow: Record<string, unknown>;
      try {
        workflow = loadComfyStoryboardWorkflow(wf);
      } catch (err) {
        logger.error({ err, stack: (err as Error).stack, workflow: wf }, 'comfyui storyboard workflow is not usable');
        throw new Error(`comfyui storyboard provider: ${err instanceof Error ? err.message : String(err)}`);
      }
      fillComfySlots(comfyTokenSlots(workflow, COMFY_PROMPT_TOKEN), COMFY_PROMPT_TOKEN, prompt);

      if (anchor) {
        const anchorSlots = comfyTokenSlots(workflow, COMFY_ANCHOR_TOKEN);
        if (anchorSlots.length) {
          fillComfySlots(anchorSlots, COMFY_ANCHOR_TOKEN, await uploadComfyAnchor(u, anchor, deadline));
        } else {
          // Said out loud rather than dropped: the anchored prompt tells the model to use a
          // reference image, so a workflow with no LoadImage slot renders an unanchored frame.
          logger.warn({ workflow: wf }, `comfyui storyboard: a reference frame was supplied but the pinned workflow has no ${COMFY_ANCHOR_TOKEN} input — rendering unanchored, so cast consistency across scenes will drift`);
        }
      }

      const queued = await comfyFetch(u, '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: `oshal-storyboard-${randomUUID().slice(0, 8)}` }),
      }, deadline);
      if (!queued.ok) {
        throw new Error(`comfyui storyboard provider: /prompt answered HTTP ${queued.status} — ${(await queued.text()).slice(0, 240)}`);
      }
      const promptId = ((await queued.json()) as { prompt_id?: string }).prompt_id;
      if (!promptId) throw new Error('comfyui storyboard provider: /prompt returned no prompt_id');
      logger.info({ promptId, base: u, anchored: Boolean(anchor) }, 'comfyui storyboard job queued');

      const file = await awaitComfyStoryboardImage(u, promptId, deadline);
      const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      const view = await comfyFetch(u, `/view?${params.toString()}`, {}, deadline);
      if (!view.ok) throw new Error(`comfyui storyboard provider: /view answered HTTP ${view.status} for ${file.filename}`);
      const image = Buffer.from(await view.arrayBuffer());
      if (image.length < 8 || !image.subarray(0, 4).equals(PNG_MAGIC)) {
        throw new Error(`comfyui storyboard provider: ${file.filename} is not a PNG — the pinned workflow's SaveImage node must write PNG, which is what the frame cropper decodes`);
      }
      logger.info({ promptId, file: file.filename, bytes: image.length }, 'comfyui storyboard frame rendered');
      return image;
    },
  };
}

/**
 * @description Vertex provider — `gemini-2.5-flash-image`. Paid per image. Kept because it works and
 * accepts an inline reference image, but it is never chosen implicitly.
 * @param {string} accessToken a Google token with the cloud-platform scope
 * @returns {StoryboardImageProvider} the provider
 */
export function createVertexImageProvider(accessToken: string): StoryboardImageProvider {
  const model = process.env.VERTEX_STORYBOARD_MODEL || 'gemini-2.5-flash-image';
  return {
    id: 'vertex',
    costClass: 'paid',
    available: async () => Boolean(accessToken),
    generate: async (prompt, anchor) => {
      const { project, location } = vertexProjectLocation();
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}`
        + `/publishers/google/models/${model}:generateContent`;
      const parts: Array<Record<string, unknown>> = [];
      if (anchor) parts.push({ inline_data: { mime_type: 'image/png', data: anchor.toString('base64') } });
      parts.push({ text: prompt });

      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      });
      if (res.status === 429) throw new Error('RATE_LIMITED');
      if (!res.ok) throw new Error(`vertex image provider: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const body = await res.json() as { candidates?: Array<{ content?: { parts?: Array<Record<string, { data?: string }>> } }> };
      const found = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.inlineData?.data ?? p.inline_data?.data)
        .find((d): d is string => Boolean(d));
      if (!found) throw new Error('EMPTY_RESPONSE');
      return Buffer.from(found, 'base64');
    },
  };
}

/**
 * @description OpenRouter provider — the swarm's own OpenRouter key driving an image-capable
 * chat-completions model (default `gemini-2.5-flash-image`, image-to-image via a data-URL image
 * part). PAID per image (~$0.04 on the operator's prepaid credit), so like vertex it is never
 * chosen implicitly — `STORYBOARD_IMAGE_PROVIDER=openrouter` is an explicit operator choice.
 *
 * Why it exists: the codex identity is a ChatGPT-**subscription** OAuth token; the platform
 * Images API (`/v1/images`) rejects those with a misleading "token has expired" even while the
 * token is valid for the codex backend. The ADR-064 free-tier CHAT fallback's :free-only guard
 * is a separate path and is untouched by this knob.
 *
 * @returns {StoryboardImageProvider} the provider
 */
export function createOpenRouterImageProvider(): StoryboardImageProvider {
  const model = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
  const generateWithMeta = async (prompt: string, anchor: Buffer | null): Promise<StoryboardImageResult> => {
    const key = getSwarmApiKey('openrouter');
    if (!key) throw new Error('openrouter image provider: the swarm holds no OpenRouter credential — set OPENROUTER_API_KEY, or openRouterApiKey in config-seed/secrets.json.');
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
    if (anchor) {
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${anchor.toString('base64')}` } });
    }
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content }], usage: { include: true } }),
    });
    if (res.status === 429) throw new Error('RATE_LIMITED');
    if (!res.ok) throw new Error(`openrouter image provider: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const body = await res.json() as {
      choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
      usage?: { cost?: number };
    };
    const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? '';
    const match = /^data:image\/\w+;base64,(.+)$/s.exec(url);
    if (!match) throw new Error('openrouter image provider: response carried no image');
    const cost = typeof body.usage?.cost === 'number' ? body.usage.cost : null;
    return { image: Buffer.from(match[1], 'base64'), costUsd: cost, model };
  };
  return {
    id: 'openrouter',
    costClass: 'paid',
    available: async () => hasSwarmApiKey('openrouter'),
    generate: async (prompt, anchor) => (await generateWithMeta(prompt, anchor)).image,
    generateWithMeta,
    // GET /key is the vendor's own cheap credential probe: it fails on a bad/revoked key and
    // reports credit state on a good one — the truthful version of "configured".
    healthCheck: async () => {
      const key = getSwarmApiKey('openrouter');
      if (!key) return { ok: false, detail: 'no OpenRouter credential configured' };
      try {
        const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
        if (!res.ok) return { ok: false, detail: `key rejected: HTTP ${res.status}` };
        const body = await res.json() as { data?: { usage?: number; limit?: number | null; limit_remaining?: number | null } };
        const d = body.data ?? {};
        const remaining = typeof d.limit_remaining === 'number' ? `$${d.limit_remaining.toFixed(2)} remaining` : 'no spend limit set';
        const used = typeof d.usage === 'number' ? `$${d.usage.toFixed(2)} used` : '';
        return { ok: true, detail: `key valid — ${[used, remaining].filter(Boolean).join(', ')} (model ${model})` };
      } catch (err) {
        return { ok: false, detail: `key probe failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

/** PNG signature — the render is trusted only when the bot actually wrote a real PNG. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * @description Build the fixed render-task prompt for the codex-cli provider. The caller's brief
 * is embedded between markers as data; the file contract around it is ours and never varies.
 * @param {string} brief the frame/portrait brief from the calling surface
 * @param {boolean} hasAnchor whether an ./anchor.png reference photo was staged
 * @returns {string} the full task prompt
 */
function buildCliRenderPrompt(brief: string, hasAnchor: boolean): string {
  const anchorStep = hasAnchor
    ? 'An input reference photo is at ./anchor.png — view it FIRST. The output image MUST preserve the exact identity, face, and likeness of the subject in that photo.\n'
    : '';
  return 'You are a headless image-rendering task. Work ONLY in the current working directory.\n'
    + anchorStep
    + 'Using your native image generation, render ONE image following this brief:\n'
    + '---BRIEF---\n'
    + brief
    + '\n---END BRIEF---\n'
    + 'Save the final rendered image as ./output.png (PNG) in the current working directory. '
    + 'Do not create any other deliverable files'
    + (hasAnchor ? ' and do not modify ./anchor.png' : '')
    + '. When the file is saved, reply with exactly: RENDERED output.png\n'
    + 'If you cannot render an image with your native tools, reply with exactly: NO_IMAGE_CAPABILITY and create no files.';
}

/**
 * @description codex-cli provider — the swarm's own codex HARNESS rendering on a bot node
 * (ADR-130). This is the rail the ChatGPT-subscription login CAN use: codex CLI 0.147+ ships
 * native image generation (text-to-image and anchored edits, proven live 2026-08-22), while the
 * platform Images API keeps rejecting subscription tokens. The controller never spawns the CLI —
 * the app-boot-registered executor delegates to a bot node over swarm-execute, and the SEC-05
 * demo carve there (DEMO_MODE + operator sub, threaded from `userSub`) is what authorizes the
 * spawn. Marginal cost is subscription-included; the bot records its own price-equivalent in
 * chat_tasks, so this provider reports costUsd null (never double-record).
 *
 * @param {string | undefined} userSub the REAL calling user's sub, threaded to the bot-side gates
 * @returns {StoryboardImageProvider} the provider
 */
export function createCodexCliImageProvider(userSub?: string): StoryboardImageProvider {
  const gatesPass = (): boolean =>
    Boolean(resolveCliStoryboardImageExecutor()) && demoModeEnabled() && isDeploymentOperatorSub(userSub);
  const generateWithMeta = async (prompt: string, anchor: Buffer | null): Promise<StoryboardImageResult> => {
    const executor = resolveCliStoryboardImageExecutor();
    if (!executor || !userSub) {
      throw new Error('codex-cli image provider: no boot-registered executor or no caller identity — the surface must pass userSub and the app must wire the executor at boot.');
    }
    const id = `sbimg-${randomUUID()}`;
    const dir = path.join(resolveSharedWorkspaceRoot(), id);
    await fs.promises.mkdir(dir, { recursive: true });
    if (anchor) await fs.promises.writeFile(path.join(dir, 'anchor.png'), anchor);

    const result = await executor({
      prompt: buildCliRenderPrompt(prompt, Boolean(anchor)),
      taskId: id,
      workspaceFolderId: id,
      userSub,
    });
    const outPath = path.join(dir, 'output.png');
    if (!result.success) {
      throw new Error(`codex-cli image provider: render task failed — ${(result.error || result.responseText || 'no detail').slice(0, 200)}`);
    }
    if (!fs.existsSync(outPath)) {
      throw new Error(`codex-cli image provider: the render task completed without writing output.png — ${(result.responseText || 'no final text').slice(0, 200)}`);
    }
    const image = await fs.promises.readFile(outPath);
    if (image.length < 8 || !image.subarray(0, 4).equals(PNG_MAGIC)) {
      throw new Error('codex-cli image provider: output.png is not a valid PNG');
    }
    return { image, costUsd: null, model: result.model || 'codex-cli' };
  };
  return {
    id: 'codex-cli',
    costClass: 'free', // subscription-included: no per-image bill; plan capacity, not credit
    available: async () => gatesPass(),
    generate: async (prompt, anchor) => (await generateWithMeta(prompt, anchor)).image,
    generateWithMeta,
    healthCheck: async () => (gatesPass()
      ? { ok: true, detail: 'demo-mode CLI rendering via the swarm codex harness (bot-node, subscription-included)' }
      : { ok: false, detail: 'demo-mode CLI rendering unavailable — needs DEMO_MODE=true, an operator caller (OSHAL_OPERATOR_SUBS) passed as userSub, and the boot-registered executor' }),
  };
}

/**
 * @description Choose the storyboard image provider. Explicit, and fails closed.
 *
 * `STORYBOARD_IMAGE_PROVIDER` selects; with it unset the default is `codex-cli` when the
 * deployment runs in demo mode (config → swarm env → demo default, ADR-130) and `codex`
 * otherwise. If the selection is not configured we throw and say what to do — we never silently
 * fall through to a provider that bills per image.
 *
 * @param {{vertexToken?: string, userSub?: string}} opts credentials/identity the selected provider may need
 * @returns {Promise<StoryboardImageProvider>} the chosen, verified-available provider
 */
export async function resolveStoryboardImageProvider(
  opts: { vertexToken?: string; userSub?: string } = {},
): Promise<StoryboardImageProvider> {
  const explicit = (process.env.STORYBOARD_IMAGE_PROVIDER || '').trim().toLowerCase();
  const want = explicit || (demoModeEnabled() ? 'codex-cli' : 'codex');
  const byId: Record<string, StoryboardImageProvider> = {
    codex: createCodexImageProvider(),
    comfyui: createComfyUiImageProvider(),
    vertex: createVertexImageProvider(opts.vertexToken ?? ''),
    openrouter: createOpenRouterImageProvider(),
    'codex-cli': createCodexCliImageProvider(opts.userSub),
  };
  const chosen = byId[want];
  if (!chosen) throw new Error(`STORYBOARD_IMAGE_PROVIDER='${want}' is not a provider (codex | comfyui | vertex | openrouter | codex-cli)`);

  if (!(await chosen.available())) {
    // comfyui can say exactly WHICH of url / workflow / reachability is missing, so it does, rather
    // than handing the operator a list of three things to check. The extra probe only ever runs on
    // the failure path, and it is bounded by COMFY_PROBE_TIMEOUT_MS like the availability check.
    const comfyDetail = want === 'comfyui' && chosen.healthCheck ? (await chosen.healthCheck()).detail : '';
    const hint = want === 'codex'
      ? 'the swarm holds no PLATFORM OpenAI key — set OPENAI_API_KEY in .env, or openAiApiKey in config-seed/secrets.json. The codex/ChatGPT login cannot help here: /v1/images rejects subscription tokens (a different auth realm). Or pick a funded provider by name, e.g. STORYBOARD_IMAGE_PROVIDER=openrouter'
      : want === 'comfyui'
        ? `${comfyDetail}. The free GPU rail needs COMFYUI_URL pointed at the box and COMFYUI_STORYBOARD_WORKFLOW pointed at an API-format image workflow carrying a ${COMFY_PROMPT_TOKEN} placeholder; COMFYUI_STORYBOARD_TIMEOUT_MS bounds each frame`
        : want === 'openrouter'
          ? 'set OPENROUTER_API_KEY (or openRouterApiKey in config-seed/secrets.json) — the swarm OpenRouter key funds the image model per image'
          : want === 'codex-cli'
            ? 'demo-mode CLI rendering needs DEMO_MODE=true, an operator caller (OSHAL_OPERATOR_SUBS) passed as userSub by the calling surface, and the bot-node executor registered at boot. Otherwise set STORYBOARD_IMAGE_PROVIDER=codex with a platform OPENAI_API_KEY, or =openrouter with credit'
            : "no Google token with the cloud-platform scope — the caller's gcp connector must grant it (read-only is not enough)";
    throw new Error(`storyboard image provider '${want}' is not configured — ${hint}. Refusing to fall back to a paid provider you did not ask for.`);
  }
  logger.info({ provider: chosen.id, costClass: chosen.costClass }, 'storyboard image provider selected');
  return chosen;
}
