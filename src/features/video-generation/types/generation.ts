/**
 * Generation provider contracts (ADR-070) — the pluggable layer behind the Video Studio.
 * Video creation is many job types matched to many providers (most free, one paid). A router
 * picks free-first candidates per job type; a loop runs the free ones, judges them, and only
 * escalates to a paid provider behind a human cost-approval gate. This is Token Chase (ADR-046)
 * for media. Mirrors the LLM/TTS provider-registry pattern.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial VideoGenProvider/job/result contracts for the multi-provider video platform (ADR-070).
 *
 * @module video-generation/types/generation
 */

import type { Storyboard, VideoShape } from './storyboard';

/** The kind of work a request needs — drives which providers are candidates. */
export type VideoJobType =
  | 'generative'      // text/storyboard -> AI video (Veo, ComfyUI, Flow)
  | 'animation'       // 2D/stick-figure animation (ComfyUI, Blender grease-pencil)
  | 'deck-to-video'   // slides + narration -> video (deck engine + TTS + ffmpeg)
  | 'edit-highlight'  // long source video -> short cut (ffmpeg + highlight detection)
  | '3d'              // 3D render (Blender)
  | 'motion-graphics';// kinetic typography / logo motion (Blender / After Effects)

/** Whether a provider costs money. Paid providers never run speculatively — only on approval. */
export type CostClass = 'free' | 'paid';

/** Availability probe result for a provider. */
export interface ProviderStatus {
  available: boolean;
  providerId: string;
  reason?: string;
}

/** A generation request. Fields are job-type-specific; only `jobType` + `userSub` are always set. */
export interface VideoJobSpec {
  jobType: VideoJobType;
  userSub: string;
  /** Free-text idea/prompt (generative/animation). */
  prompt?: string;
  /** Optional structured plan (generative). */
  storyboard?: Storyboard;
  /** Shape controls (framing/voice/captions/music). */
  shape?: VideoShape;
  /** Job-type-specific inputs (deck sections, source video path, uploaded clips, …). */
  inputs?: Record<string, unknown>;
}

/** The product of a successful generation. The mp4 bytes OR an artifact reference is returned. */
export interface GenResult {
  providerId: string;
  costClass: CostClass;
  /** Finished video bytes (when produced in-process). */
  mp4?: Buffer;
  /** Or a path/reference to the artifact (when produced out-of-process, e.g. an edge node). */
  artifactPath?: string;
  /** Realized duration. */
  durationSec?: number;
  /** Actual/estimated USD cost (0 for free). */
  costUsd: number;
  meta?: Record<string, unknown>;
}

/**
 * @description A pluggable video generation provider. Each declares the job types it serves and its
 * cost class; the registry/router/loop orchestrate them. Mirrors the TTS/LLM provider interfaces.
 */
export interface VideoGenProvider {
  readonly id: string;
  readonly costClass: CostClass;
  /** Job types this provider can fulfill. */
  readonly jobTypes: readonly VideoJobType[];
  /** True if the provider needs a GPU host (edge bot-node) — informational for routing/UX. */
  readonly requiresGpuHost?: boolean;
  /** Is the provider usable right now (configured, reachable)? */
  probe(): Promise<ProviderStatus>;
  /** Estimated USD cost for this spec (0 for free providers). Cheap, no generation. */
  estimateCost(spec: VideoJobSpec): number;
  /** Produce the video. Throws on failure (the loop treats a throw as "this attempt failed"). */
  generate(spec: VideoJobSpec): Promise<GenResult>;
}

/** Verdict from the quality judge on a candidate result. */
export interface JudgeResult {
  pass: boolean;
  score?: number;
  notes?: string;
}

/** Judges a candidate result for a spec (LLM/vision score and/or operator preview). */
export type VideoJudge = (spec: VideoJobSpec, result: GenResult) => Promise<JudgeResult>;

/** One provider attempt in the loop trace. */
export interface LoopAttempt {
  providerId: string;
  costClass: CostClass;
  passed: boolean;
  error?: string;
  score?: number;
}

/**
 * @description Outcome of the free-first loop:
 * - `done`: a free result passed → deliver `result` at $0.
 * - `needs-approval`: free failed → park the ticket with `escalation` (provider + cost estimate);
 *   the paid provider is NOT run until the human approves.
 * - `failed`: nothing free passed and no paid escalation is available.
 */
export interface LoopOutcome {
  status: 'done' | 'needs-approval' | 'failed';
  result?: GenResult;
  escalation?: { providerId: string; estimatedCostUsd: number };
  attempts: LoopAttempt[];
}
