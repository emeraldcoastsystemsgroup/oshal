/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Zod validation schemas for voice API
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional providerId override on synthesize — lets the voice settings page preview any registered provider, not just the swarm default
 */

import { z } from 'zod';

/**
 * @description Schema for text-to-speech synthesis request.
 */
export const SynthesizeRequestSchema = z.object({
  text: z.string()
    .min(1, 'Text is required')
    .max(3000, 'Text too long (max 3000 characters)'),
  voice: z.string().optional(),
  providerId: z.string().optional(),
});

/**
 * @description Inferred type for a text-to-speech synthesis request payload.
 */
export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;

/**
 * @description Schema for successful synthesis response.
 */
export const SynthesizeResponseSchema = z.object({
  audioData: z.string().optional(), // Base64 encoded audio
  fallback: z.string().optional(),
  message: z.string().optional(),
});

/**
 * @description Inferred type for a successful synthesis response payload.
 */
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

/**
 * @description Schema for successful transcription response.
 */
export const TranscribeResponseSchema = z.object({
  text: z.string().optional(),
  fallback: z.string().optional(),
  message: z.string().optional(),
});

/**
 * @description Inferred type for a successful transcription response payload.
 */
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

/**
 * @description Schema for a voice option.
 */
export const VoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  gender: z.string(),
  language: z.string(),
});

/**
 * @description Inferred type for a single selectable voice option.
 */
export type Voice = z.infer<typeof VoiceSchema>;

/**
 * @description Schema for get voices response.
 */
export const GetVoicesResponseSchema = z.object({
  voices: z.array(VoiceSchema),
  source: z.string(),
});

/**
 * @description Inferred type for the response listing available voices and their source.
 */
export type GetVoicesResponse = z.infer<typeof GetVoicesResponseSchema>;