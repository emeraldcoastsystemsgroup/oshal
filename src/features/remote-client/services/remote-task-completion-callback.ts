/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deliver bounded browser-task results through a same-control-plane, allowlisted ingest callback using one-use capability metadata kept outside the model-visible tool arguments.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Retry the identical validated result three times on transport refusal without ever substituting a contradictory failure payload after task completion.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Refuse HTTP redirects so an allowlisted same-origin endpoint cannot forward a callback capability to another origin.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Permit one bounded direct-child confirmation-image name in the immutable result while retaining strict rejection of every other extra field.
 */

import { z } from 'zod';
import { A2ATaskCompletionCallbackSchema, type A2ATaskCompletionCallback } from '@/shared/types';

const CALLBACK_TIMEOUT_MS = 10_000;
const MAX_RESULT_BYTES = 8 * 1024;
const ALLOWED_PATHS = new Set(['/api/profile-studio/ingest', '/api/apply/ingest']);

const BrowserTaskCallbackResultSchema = z.object({
  result: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/),
  note: z.string().max(4000),
  confirmationFile: z.string().max(132)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g)$/i).optional(),
}).strict();

/** @description Strict result vocabulary transported from a browser task to its scoped callback. */
export type BrowserTaskCallbackResult = z.infer<typeof BrowserTaskCallbackResultSchema>;

/**
 * @description Extracts exactly one bounded JSON result object from a direct value or known MCP
 * text wrapper. Embedded JSON, code fences, extra result keys, and oversized output fail closed.
 * @param output - Untrusted tool output returned by the browser-driving model.
 * @returns The strictly validated callback result.
 */
export function parseBrowserTaskCallbackResult(output: unknown): BrowserTaskCallbackResult {
  const candidate = unwrapMcpResult(output);
  const parsed = typeof candidate === 'string' ? parseBoundedJson(candidate) : candidate;
  return BrowserTaskCallbackResultSchema.parse(parsed);
}

/**
 * @description Posts a result using trusted daemon metadata after proving the target is an
 * allowlisted ingest path on this remote client's registered control-plane origin.
 * @param callbackInput - Opaque callback metadata carried outside tool arguments.
 * @param taskId - Exact task whose completion is being reported.
 * @param output - Untrusted tool output to validate before sending.
 * @param registeredControlPlaneUrl - Control plane configured for this remote client.
 * @returns Resolves after the control plane accepts the callback.
 */
export async function deliverTaskCompletionCallback(
  callbackInput: A2ATaskCompletionCallback,
  taskId: string,
  output: unknown,
  registeredControlPlaneUrl: string,
): Promise<void> {
  const callback = A2ATaskCompletionCallbackSchema.parse(callbackInput);
  validateCallbackUrl(callback.url, registeredControlPlaneUrl);
  const result = parseBrowserTaskCallbackResult(output);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await postCallbackOnce(callback, taskId, result);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await retryDelay(attempt * 100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Trusted completion callback failed');
}

/** @description Performs one timed HTTP attempt with the already-validated immutable payload. */
async function postCallbackOnce(
  callback: A2ATaskCompletionCallback,
  taskId: string,
  result: BrowserTaskCallbackResult,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const response = await fetch(callback.url, callbackRequest(callback, taskId, result, controller.signal));
    if (!response.ok) throw new Error(`Trusted completion callback refused with HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** @description Applies a tiny bounded backoff between identical callback attempts. */
function retryDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** @description Unwraps only transport shapes emitted by MCP tool execution. */
function unwrapMcpResult(output: unknown): unknown {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (hasOnlyResultFields(record)) return record;
  if (typeof record.response === 'string') return record.response;
  if (record.structuredContent !== undefined) return record.structuredContent;
  const content = record.content;
  if (!Array.isArray(content) || content.length !== 1) return output;
  const block = content[0];
  if (!block || typeof block !== 'object') return output;
  return (block as Record<string, unknown>).type === 'text'
    ? (block as Record<string, unknown>).text
    : output;
}

/** @description Recognizes the decoded required fields plus the sole optional artifact name. */
function hasOnlyResultFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length >= 2 && keys.length <= 3 && keys.includes('note') && keys.includes('result')
    && keys.every((key) => ['confirmationFile', 'note', 'result'].includes(key));
}

/** @description Parses a whole bounded JSON string without accepting prose or fenced fragments. */
function parseBoundedJson(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('Browser-task callback result exceeds the byte limit');
  }
  return JSON.parse(value.trim()) as unknown;
}

/** @description Restricts trusted callbacks to this daemon's registered control plane and ingest routes. */
function validateCallbackUrl(callbackUrl: string, registeredUrl: string): void {
  const target = new URL(callbackUrl);
  const registered = new URL(registeredUrl);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== registered.origin) {
    throw new Error('Trusted completion callback must use the registered control-plane origin');
  }
  if (target.username || target.password || target.search || target.hash || !ALLOWED_PATHS.has(target.pathname)) {
    throw new Error('Trusted completion callback URL is not an allowlisted ingest endpoint');
  }
}

/** @description Builds the non-model HTTP request without logging or echoing its capability. */
function callbackRequest(
  callback: A2ATaskCompletionCallback,
  taskId: string,
  result: BrowserTaskCallbackResult,
  signal: AbortSignal,
): RequestInit {
  return {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'x-oshal-callback-capability': callback.capability,
    },
    body: JSON.stringify({ taskId, context: callback.context, result }),
    signal,
  };
}
