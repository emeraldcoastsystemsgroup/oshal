/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — VisionDescribeService: turns attached image(s) into a factual text description via the swarm's OpenRouter key driving a vision-capable chat model. This is the VISUAL analog of speech-to-text (/api/voice/transcribe): a controller-side transform that lets the Codex-CLI Jarvis brain (which is text-only) reason over a photo the user attached. Fail-closed when no OpenRouter credential; records the vendor-reported cost to chat_tasks like every other accountable LLM call.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cost observability (migration 090): thread the already-measured OpenRouter call duration into recordCost so the per-call ledger row carries latency alongside the vendor-reported tokens/cost.
 */

import type { Pool } from 'pg';
import { getSwarmApiKey, hasSwarmApiKey } from '@/features/llm-provider';
import { CostTrackingService } from '@/features/operational-intelligence';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'vision-describe-service' });

/** OpenRouter chat-completions endpoint — the same host the storyboard image provider drives. */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Default vision-understanding model (text out). Cheap + multimodal; overridable per deployment. */
const DEFAULT_MODEL = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash';
/** Hard caps so one request can't blow past sane limits (the browser downscales before sending). */
const MAX_IMAGES = 4;
const MAX_DATAURL_BYTES = 8 * 1024 * 1024;
/** Accepts the still-image formats a phone camera / file picker produces. */
const IMAGE_DATAURL_RE = /^data:image\/(png|jpe?g|webp|gif|heic|heif);base64,[A-Za-z0-9+/=]+$/i;
/** Jarvis's agent id — cost attribution lands under the Jarvis bot (ADR-036). */
const JARVIS_AGENT_ID = 'a0000000-0000-0000-0000-000000000050';

/** One attached image, carried as a base64 `data:` URL from the browser. */
export interface VisionImageInput {
  dataUrl: string;
}

/** A request to describe one or more attached images in service of the user's question. */
export interface VisionDescribeRequest {
  images: VisionImageInput[];
  /** What the user typed alongside the image(s) — focuses the description. */
  question?: string;
  /** OIDC sub the cost is attributed to (per-owner budget). */
  ownerSub: string;
  /** Conversation/task id so the cost row links to the Jarvis thread. */
  taskId?: string;
  /** Overrides the cost-attribution agent id (defaults to the Jarvis bot). */
  agentId?: string;
}

/** The description plus the accountable metadata the caller stitches into the prompt. */
export interface VisionDescribeResult {
  description: string;
  model: string;
  cost: number;
  imageCount: number;
}

/**
 * @description Service that describes attached images as plain text using an OpenRouter
 * vision model, so a text-only reasoning brain can answer questions about a photo.
 */
export class VisionDescribeService {
  private readonly costTracker: CostTrackingService;

  /**
   * @param pool - Postgres pool for cost persistence (null in unit tests → cost is memory-only).
   */
  constructor(pool: Pool | null = null) {
    this.costTracker = new CostTrackingService(pool);
  }

  /**
   * @description Whether the swarm holds an OpenRouter credential to run the describe call.
   * @returns True when a describe request can succeed; false means fail-closed.
   */
  isAvailable(): boolean {
    return hasSwarmApiKey('openrouter');
  }

  /**
   * @description Describe the attached image(s) in factual detail, focused on the user's question.
   * @param req - The images, the user's question, and the owner/task the cost attributes to.
   * @returns The plain-text description plus the model + vendor-reported cost.
   * @throws Error when no OpenRouter credential is configured, the input is invalid, or the API fails.
   */
  async describe(req: VisionDescribeRequest): Promise<VisionDescribeResult> {
    const images = this.validateImages(req.images);
    if (!this.isAvailable()) {
      throw new Error('vision describe: the swarm holds no OpenRouter credential — set OPENROUTER_API_KEY, or openRouterApiKey in config-seed/secrets.json.');
    }
    const key = getSwarmApiKey('openrouter');
    const model = DEFAULT_MODEL;
    const body = {
      model,
      messages: [{ role: 'user', content: this.buildContent(req.question, images) }],
      max_tokens: 1200,
      usage: { include: true },
    };

    const started = Date.now();
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      logger.error({ status: res.status, detail, model }, 'vision describe: OpenRouter call failed');
      throw new Error(`vision describe: OpenRouter HTTP ${res.status} ${detail}`);
    }
    const parsed = await res.json() as OpenRouterChatResponse;
    const description = String(parsed.choices?.[0]?.message?.content || '').trim();
    if (!description) throw new Error('vision describe: model returned no description');

    await this.recordCost(parsed, req, model, Date.now() - started);
    logger.info(
      { imageCount: images.length, model, durationMs: Date.now() - started, cost: parsed.usage?.cost ?? 0 },
      'vision describe complete',
    );
    return { description, model, cost: Number(parsed.usage?.cost ?? 0), imageCount: images.length };
  }

  /** Validate + bound the image list; throws on anything that isn't a base64 image data URL. */
  private validateImages(images: VisionImageInput[] | undefined): VisionImageInput[] {
    const list = Array.isArray(images) ? images : [];
    if (list.length === 0) throw new Error('vision describe: at least one image is required');
    if (list.length > MAX_IMAGES) throw new Error(`vision describe: at most ${MAX_IMAGES} images per request`);
    for (const img of list) {
      const url = typeof img?.dataUrl === 'string' ? img.dataUrl : '';
      if (!IMAGE_DATAURL_RE.test(url)) throw new Error('vision describe: each image must be a base64 image data URL');
      if (url.length > MAX_DATAURL_BYTES) throw new Error('vision describe: an image exceeds the 8MB limit — downscale before sending');
    }
    return list;
  }

  /** Build the multimodal user content: the framing instruction + each image part. */
  private buildContent(question: string | undefined, images: VisionImageInput[]): OpenRouterContentPart[] {
    const ask = (question || '').trim();
    const instruction =
      'You describe attached images for an assistant that cannot see them, so it can answer the user. '
      + 'Describe the image(s) in thorough, factual detail: any visible text (transcribe it), objects, '
      + 'layout, colors, charts/tables, and notable details. Do NOT identify or name real people; refer '
      + 'to them generically. Report only what is visible — never invent. '
      + (ask ? `Focus on what is relevant to the user's request: "${ask}".` : 'Give a complete general description.')
      + ' Output plain text.';
    const parts: OpenRouterContentPart[] = [{ type: 'text', text: instruction }];
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    return parts;
  }

  /** Persist the vendor-reported cost to chat_tasks under the Jarvis bot (best-effort, non-fatal). */
  private async recordCost(parsed: OpenRouterChatResponse, req: VisionDescribeRequest, model: string, durationMs: number): Promise<void> {
    try {
      const usage = parsed.usage || {};
      await this.costTracker.recordCost({
        taskId: req.taskId || `vision-${req.ownerSub}`,
        agentId: req.agentId || JARVIS_AGENT_ID,
        providerId: 'openrouter',
        modelId: model,
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        inputCost: 0,
        outputCost: 0,
        totalCost: Number(usage.cost ?? 0),
        currency: 'USD',
        requestCount: 1,
        estimated: usage.cost === undefined,
        ownerSub: req.ownerSub,
        durationMs, // measured wall-clock of the OpenRouter call (090 ledger observability)
      });
    } catch (err) {
      logger.warn({ err }, 'vision describe: cost record failed — non-fatal');
    }
  }
}

/** Minimal shape of the OpenRouter chat-completions response we consume. */
interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

/** A single multimodal content part (text or an image reference). */
type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
