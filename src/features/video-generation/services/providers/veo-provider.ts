/**
 * Veo provider (ADR-070) — wraps the built Vertex Veo render path as a PAID VideoGenProvider for
 * `generative` jobs. It is the escalation tier: never run speculatively, only after a human approves
 * the cost estimate at the gate. Defaults to the cheap 720p Fast tier.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Veo paid-provider adapter over the existing render service.
 *
 * @module video-generation/services/providers/veo-provider
 */

import * as fs from 'node:fs';
import type { GenResult, ProviderStatus, VideoGenProvider, VideoJobSpec, VideoJobType } from '../../types';
import { veoCostPerSecond, type VeoResolution } from '../veo-client';
import { renderVideo } from '../video-render-service';
import { storyboardSeconds } from '../storyboard';

/** Default escalation tier — 720p (cheap Fast). A second approval can request '1080p'. */
const DEFAULT_RESOLUTION: VeoResolution = '720p';

/**
 * @description Paid Veo generation provider. Generates real AI video via Vertex; cost is per second
 * of generated video. Availability requires a service-account key + Vertex project.
 */
export class VeoProvider implements VideoGenProvider {
  readonly id = 'veo';
  readonly costClass = 'paid' as const;
  readonly jobTypes: readonly VideoJobType[] = ['generative'];

  /** Probe: needs GOOGLE_APPLICATION_CREDENTIALS (SA key) + a Vertex project. */
  async probe(): Promise<ProviderStatus> {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const project = process.env.VERTEX_PROJECT || process.env.GCP_PROJECT_ID;
    if (!project) return { available: false, providerId: this.id, reason: 'VERTEX_PROJECT not set' };
    if (!keyPath || !fs.existsSync(keyPath)) return { available: false, providerId: this.id, reason: 'GOOGLE_APPLICATION_CREDENTIALS missing' };
    return { available: true, providerId: this.id };
  }

  /** Estimate = storyboard seconds × the per-second rate for the chosen tier. */
  estimateCost(spec: VideoJobSpec): number {
    const seconds = spec.storyboard ? storyboardSeconds(spec.storyboard) : (spec.shape?.targetSeconds ?? 8);
    return Number((seconds * veoCostPerSecond(DEFAULT_RESOLUTION)).toFixed(2));
  }

  /** Render the storyboard to a real .mp4 via Veo + ffmpeg (cheap 720p tier by default). */
  async generate(spec: VideoJobSpec): Promise<GenResult> {
    if (!spec.storyboard || !spec.shape) throw new Error('veo provider needs a storyboard + shape');
    const rendered = await renderVideo(spec.storyboard, spec.shape, DEFAULT_RESOLUTION);
    return {
      providerId: this.id,
      costClass: this.costClass,
      mp4: rendered.mp4,
      durationSec: rendered.durationSec,
      costUsd: rendered.estimatedCostUsd,
      meta: { resolution: DEFAULT_RESOLUTION },
    };
  }
}
