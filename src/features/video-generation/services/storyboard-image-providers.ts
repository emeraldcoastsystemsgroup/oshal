/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Storyboard image generation behind a provider interface. Codex (the operator's own OpenAI account) is the DEFAULT; ComfyUI on the GPU box is the free local sibling; Vertex is a paid fallback that must be asked for by name.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | openrouter sibling: the swarm's OpenRouter key driving an image-capable chat model (default gemini-2.5-flash-image, image-to-image via data-URL parts). Needed because the codex identity is a ChatGPT-subscription OAuth token and api.openai.com/v1/images REJECTS those (misleading "token has expired" for a token valid to 07-22) — subscription auth works for the codex backend, never for the platform Images API. Explicit selection only, paid per image, fail-closed like its siblings.
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
 *   codex    the operator's own OpenAI account (`gpt-image-1`). DEFAULT. Same BYOK identity the
 *            codex harness already uses — `OPENAI_API_KEY`, or the key inside ~/.codex/auth.json.
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

import { createChildLogger } from '@/shared/logger';
import { getSwarmApiKey, hasSwarmApiKey } from '@/features/llm-provider';
import { vertexProjectLocation } from './veo-client';

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
  readonly id: 'codex' | 'comfyui' | 'vertex' | 'openrouter';
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
 * @description Codex provider — the swarm's own OpenAI identity. The default.
 *
 * The credential comes from the SWARM's credential resolver (`getSwarmApiKey('openai')`), which is
 * the same one `buildClineConfig` hands every codex-harness bot. This module must never read a key
 * out of `process.env` or `~/.codex/auth.json` itself: a bespoke read creates a second, invisible
 * credential path the operator never configured and cannot rotate.
 *
 * @returns {StoryboardImageProvider} the provider
 */
export function createCodexImageProvider(): StoryboardImageProvider {
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  return {
    id: 'codex',
    costClass: 'paid', // the swarm's own account, but still per-image — say so plainly
    available: async () => hasSwarmApiKey('openai'),
    generate: async (prompt, anchor) => {
      const key = getSwarmApiKey('openai');
      if (!key) throw new Error("codex image provider: the swarm holds no OpenAI credential — connect the Codex/ChatGPT login, or set openAiApiKey in config-seed/secrets.json.");

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

/**
 * @description Choose the storyboard image provider. Explicit, and fails closed.
 *
 * `STORYBOARD_IMAGE_PROVIDER` selects; the default is `codex`. If the selection is not configured we
 * throw and say what to do — we never silently fall through to a provider that bills per image.
 *
 * @param {{vertexToken?: string}} opts credentials the selected provider may need
 * @returns {Promise<StoryboardImageProvider>} the chosen, verified-available provider
 */
export async function resolveStoryboardImageProvider(
  opts: { vertexToken?: string } = {},
): Promise<StoryboardImageProvider> {
  const want = (process.env.STORYBOARD_IMAGE_PROVIDER || 'codex').toLowerCase();
  const byId: Record<string, StoryboardImageProvider> = {
    codex: createCodexImageProvider(),
    comfyui: createComfyUiImageProvider(),
    vertex: createVertexImageProvider(opts.vertexToken ?? ''),
    openrouter: createOpenRouterImageProvider(),
  };
  const chosen = byId[want];
  if (!chosen) throw new Error(`STORYBOARD_IMAGE_PROVIDER='${want}' is not a provider (codex | comfyui | vertex | openrouter)`);

  if (!(await chosen.available())) {
    const hint = want === 'codex'
      ? "the swarm holds no OpenAI credential — connect the Codex/ChatGPT login (its access token is the swarm's OpenAI key), or set openAiApiKey in config-seed/secrets.json"
      : want === 'comfyui'
        ? 'set COMFYUI_URL and COMFYUI_STORYBOARD_WORKFLOW, and make sure the GPU box is reachable'
        : want === 'openrouter'
          ? 'set OPENROUTER_API_KEY (or openRouterApiKey in config-seed/secrets.json) — the swarm OpenRouter key funds the image model per image'
          : "no Google token with the cloud-platform scope — the caller's gcp connector must grant it (read-only is not enough)";
    throw new Error(`storyboard image provider '${want}' is not configured — ${hint}. Refusing to fall back to a paid provider you did not ask for.`);
  }
  logger.info({ provider: chosen.id, costClass: chosen.costClass }, 'storyboard image provider selected');
  return chosen;
}
