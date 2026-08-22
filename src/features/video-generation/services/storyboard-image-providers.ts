/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Storyboard image generation behind a provider interface. Codex (the operator's own OpenAI account) is the DEFAULT; ComfyUI on the GPU box is the free local sibling; Vertex is a paid fallback that must be asked for by name.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | openrouter sibling: the swarm's OpenRouter key driving an image-capable chat model (default gemini-2.5-flash-image, image-to-image via data-URL parts). Needed because the codex identity is a ChatGPT-subscription OAuth token and api.openai.com/v1/images REJECTS those (misleading "token has expired" for a token valid to 07-22) — subscription auth works for the codex backend, never for the platform Images API. Explicit selection only, paid per image, fail-closed like its siblings.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | codex provider resolves the PLATFORM realm only (getSwarmPlatformApiKey): the mounted ChatGPT-subscription OAuth made available() read true while every /v1/images call 401'd (re-verified 2026-08-21 — missing scope api.model.images.request). Selection now fails closed at resolve time with the paste-a-platform-key hint instead of burning a doomed vendor call; codex gains a real healthCheck (GET /v1/models: 200 = platform key, 403 = subscription realm); the resolver hint no longer suggests the ChatGPT login for images.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | codex-cli sibling (ADR-130): renders through the swarm's own codex HARNESS on a bot node — codex CLI 0.147+ has native image generation (proven live 2026-08-22 on the bind-mounted ChatGPT login: text-to-image AND anchored edits, gpt-5.5 and gpt-5.6-sol both), which the subscription CAN use even though the platform Images API rejects it. The controller never spawns the CLI: an app-boot-registered executor (storyboard-cli-image-executor) delegates to a bot node over swarm-execute, where the SEC-05 demo carve (DEMO_MODE + operator sub) governs the spawn; files travel via the shared workspace volume. Demo-mode default: with STORYBOARD_IMAGE_PROVIDER unset and DEMO_MODE on, selection now defaults to codex-cli (config → swarm env → demo default); explicit env always wins.
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
 *            character LoRA would eventually make cast consistency exact rather than approximate.
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

/**
 * @description ComfyUI provider — the GPU box that already runs LoRA training. Free per image, and
 * the natural home for a trained character LoRA, which would make cast consistency exact instead of
 * merely anchored. Requires COMFYUI_URL and an API-format workflow with a %PROMPT% placeholder.
 * @returns {StoryboardImageProvider} the provider
 */
export function createComfyUiImageProvider(): StoryboardImageProvider {
  const base = (): string => (process.env.COMFYUI_URL || '').replace(/\/+$/, '');
  return {
    id: 'comfyui',
    costClass: 'free',
    available: async () => {
      const u = base();
      if (!u || !process.env.COMFYUI_STORYBOARD_WORKFLOW) return false;
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 4000);
        const r = await fetch(`${u}/system_stats`, { signal: c.signal });
        clearTimeout(t);
        return r.ok;
      } catch { return false; }
    },
    generate: async () => {
      // Deliberately not a stub that returns a placeholder image: an unimplemented path must fail,
      // not hand the renderer a fake frame. Wiring is the workflow JSON + /prompt + /history poll,
      // mirroring providers/comfyui-provider.ts.
      throw new Error('comfyui storyboard provider is not wired yet — set STORYBOARD_IMAGE_PROVIDER=codex, or implement the workflow submit/poll against COMFYUI_STORYBOARD_WORKFLOW');
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
    const hint = want === 'codex'
      ? 'the swarm holds no PLATFORM OpenAI key — set OPENAI_API_KEY in .env, or openAiApiKey in config-seed/secrets.json. The codex/ChatGPT login cannot help here: /v1/images rejects subscription tokens (a different auth realm). Or pick a funded provider by name, e.g. STORYBOARD_IMAGE_PROVIDER=openrouter'
      : want === 'comfyui'
        ? 'set COMFYUI_URL and COMFYUI_STORYBOARD_WORKFLOW, and make sure the GPU box is reachable'
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
