/**
 * ComfyUI provider (ADR-070) — FREE generation on the operator's GPU box. Calls a ComfyUI instance's
 * native HTTP API (`/prompt` → poll `/history` → `/view`) over Tailscale. The workflow is install-
 * specific: the operator exports their working text-to-video workflow as API-format JSON with a
 * `%PROMPT%` placeholder where the prompt text goes; this provider injects the prompt and runs it.
 * $0 — the cost is the operator's own compute.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial free ComfyUI provider (HTTP API + placeholder workflow injection).
 *
 * @module video-generation/services/providers/comfyui-provider
 */

import * as fs from 'node:fs';
import { createChildLogger } from '@/shared/logger';
import type { GenResult, ProviderStatus, VideoGenProvider, VideoJobSpec, VideoJobType } from '../../types';

const logger = createChildLogger({ module: 'comfyui-provider' });

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000; // local video gen can take minutes
const PROMPT_TOKEN = '%PROMPT%';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A media file ComfyUI reports in a node's outputs. */
interface ComfyFile { filename: string; subfolder?: string; type?: string }

/** Recursively inject the prompt into any string input equal to / containing %PROMPT%. */
function injectPrompt(workflow: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  for (const node of Object.values(clone)) {
    const inputs = (node as { inputs?: Record<string, unknown> })?.inputs;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v === 'string' && v.includes(PROMPT_TOKEN)) inputs[k] = v.replace(PROMPT_TOKEN, prompt);
    }
  }
  return clone;
}

/** Pull the first video-like media file out of a /history outputs map. */
function firstMedia(outputs: Record<string, unknown>): ComfyFile | null {
  for (const out of Object.values(outputs)) {
    const o = out as Record<string, ComfyFile[] | undefined>;
    for (const key of ['gifs', 'videos', 'images']) {
      const files = o[key];
      if (Array.isArray(files) && files[0]?.filename) return files[0];
    }
  }
  return null;
}

/**
 * @description Free ComfyUI generation provider. Requires COMFYUI_URL (the box's Tailscale URL) and
 * COMFYUI_WORKFLOW_PATH (an API-format workflow JSON containing a %PROMPT% placeholder).
 */
export class ComfyUIProvider implements VideoGenProvider {
  readonly id = 'comfyui';
  readonly costClass = 'free' as const;
  readonly jobTypes: readonly VideoJobType[] = ['generative', 'animation'];
  readonly requiresGpuHost = true;

  private base(): string | null {
    const u = process.env.COMFYUI_URL;
    return u ? u.replace(/\/+$/, '') : null;
  }

  /** Available when COMFYUI_URL + a workflow template are set and /system_stats responds. */
  async probe(): Promise<ProviderStatus> {
    const base = this.base();
    if (!base) return { available: false, providerId: this.id, reason: 'COMFYUI_URL not set' };
    const wf = process.env.COMFYUI_WORKFLOW_PATH;
    if (!wf || !fs.existsSync(wf)) return { available: false, providerId: this.id, reason: 'COMFYUI_WORKFLOW_PATH missing' };
    try {
      const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(4000) });
      return r.ok ? { available: true, providerId: this.id } : { available: false, providerId: this.id, reason: `system_stats ${r.status}` };
    } catch (err) {
      return { available: false, providerId: this.id, reason: `unreachable: ${(err as Error).message}` };
    }
  }

  estimateCost(): number {
    return 0;
  }

  /** Queue the workflow, poll history to completion, fetch the produced clip. */
  async generate(spec: VideoJobSpec): Promise<GenResult> {
    const base = this.base();
    if (!base) throw new Error('COMFYUI_URL not set');
    const prompt = (spec.prompt || spec.storyboard?.scenes?.map((s) => s.prompt).join('. ') || '').trim();
    if (!prompt) throw new Error('comfyui provider needs a prompt');
    const template = JSON.parse(fs.readFileSync(process.env.COMFYUI_WORKFLOW_PATH as string, 'utf8')) as Record<string, unknown>;
    const workflow = injectPrompt(template, prompt);

    const clientId = `oshal-${spec.userSub.slice(0, 8)}`;
    const queue = await fetch(`${base}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!queue.ok) throw new Error(`comfyui /prompt ${queue.status}: ${(await queue.text()).slice(0, 200)}`);
    const promptId = ((await queue.json()) as { prompt_id?: string }).prompt_id;
    if (!promptId) throw new Error('comfyui /prompt returned no prompt_id');
    logger.info({ promptId, base }, 'comfyui job queued');

    const media = await this.awaitOutput(base, promptId);
    const params = new URLSearchParams({ filename: media.filename, subfolder: media.subfolder || '', type: media.type || 'output' });
    const view = await fetch(`${base}/view?${params.toString()}`);
    if (!view.ok) throw new Error(`comfyui /view ${view.status}`);
    const mp4 = Buffer.from(await view.arrayBuffer());
    logger.info({ promptId, file: media.filename, bytes: mp4.length }, 'comfyui job done');
    return { providerId: this.id, costClass: this.costClass, mp4, costUsd: 0, meta: { file: media.filename, host: base } };
  }

  /** Poll /history/{id} until the job has outputs (or time out). */
  private async awaitOutput(base: string, promptId: string): Promise<ComfyFile> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      const r = await fetch(`${base}/history/${promptId}`);
      if (!r.ok) continue;
      const hist = (await r.json()) as Record<string, { outputs?: Record<string, unknown> }>;
      const outputs = hist[promptId]?.outputs;
      if (outputs) {
        const media = firstMedia(outputs);
        if (media) return media;
        throw new Error('comfyui job finished but produced no media output');
      }
    }
    throw new Error(`comfyui job timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`);
  }
}
