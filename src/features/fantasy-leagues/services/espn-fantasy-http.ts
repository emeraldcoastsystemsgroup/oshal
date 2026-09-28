/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-146 D2: the bounded GET the fantasy-leagues skill makes every ESPN fantasy read through, moved from sports-edge's sports-espn.ts with the read client so the skill carries its own transport instead of importing a package. Same contract, byte for byte: retry a transient failure (5xx, 429, network) and never a 4xx, fire onError once every attempt is exhausted, and classify the failure as transport / unavailable / refused so a caller can tell "we never reached ESPN" from "ESPN refused this league". Request headers (the league cookies) are consumed at the fetch and never logged: the log events carry the URL, status, timing and attempt only. With no injected log, events go to the Pino child logger.
 *
 * @module fantasy-leagues/espn-fantasy-http
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'fantasy-leagues-espn' });

/** Optional injection points, so the client is testable without the public network and observable. */
export interface FantasyReadOptions {
  /** Replaces global fetch; tests pass a loopback-rewriting fetch or a stub. */
  fetchImpl?: typeof fetch;
  /**
   * Called with every request and its outcome. The fields are the URL, status, timing, attempt and
   * error message — never a request header, so a credential cannot reach a log through this.
   */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * Called when a read ultimately fails, after retries. This is how a caller tells "ESPN said there
   * is nothing" apart from "we never reached ESPN" — an empty result rendered as an answer is a lie
   * a person will act on.
   */
  onError?: (url: string, reason: string) => void;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Attempts per read, including the first. Transient failures here are common under load. */
  attempts?: number;
}

/**
 * Why a read failed, as far as this client can tell:
 *
 *   - `transport`   no HTTP response was ever produced: DNS, TCP, TLS, or the timeout. The fault
 *                   lies between this swarm and ESPN, and NO credential can fix it.
 *   - `unavailable` ESPN answered but could not serve the request (5xx, or 429). Also not a
 *                   credential problem, and usually transient.
 *   - `refused`     ESPN answered with a statement about the request itself (any other 4xx). This
 *                   is the only kind a credential, or a corrected league id, can fix.
 */
export type FantasyReadFailureKind = 'transport' | 'unavailable' | 'refused';

/** A failed read, classified. */
export interface FantasyReadFailure {
  kind: FantasyReadFailureKind;
  /** Exactly what the read recorded: `HTTP <status>`, or the transport error's message. */
  reason: string;
  /** The status ESPN answered with, or null when no response was received at all. */
  status: number | null;
}

/**
 * @description The default event sink when a caller injects none: a successful request at debug, a
 * refused or failed one at warn, and a request that threw at error. Only the fields `getJson`
 * builds reach it, and none of them is a header.
 * @param event - The request event name.
 * @param fields - URL, status, timing, attempt and error message.
 * @returns Nothing.
 */
function defaultLog(event: string, fields: Record<string, unknown>): void {
  if (event === 'espn.request.ok') logger.debug(fields, event);
  else if (event === 'espn.request.error') logger.error(fields, event);
  else logger.warn(fields, event);
}

/** Backoff between attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * @description Fetch and parse JSON with a timeout, retrying a transient failure before giving up,
 * and returning null rather than throwing when the service ultimately misbehaves.
 *
 * THE RETRY IS NOT DEFENSIVE PADDING. Measured on the live box 2026-09-07: eight consecutive reads
 * from a fresh process all succeeded in under 1.6s while the long-running api intermittently failed
 * the identical read. A single attempt from a busy event loop is not a reliable read.
 *
 * `onError` fires only when every attempt is exhausted, so a caller can report honestly.
 * @param url - Absolute URL to read. Every caller in this skill builds it from a fixed ESPN origin.
 * @param opts - Injection points, timeout and attempt count.
 * @param headers - Optional request headers. The league cookies arrive here; they are consumed by
 * the fetch and never logged (only the URL is).
 * @returns Parsed JSON, or null once every attempt has failed.
 */
export async function getJson(
  url: string, opts: FantasyReadOptions, headers?: Record<string, string>,
): Promise<any | null> {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const log = opts.log || defaultLog;
  const attempts = Math.max(1, opts.attempts ?? 3);
  let reason = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
    const started = Date.now();
    try {
      const res = await doFetch(url, { signal: controller.signal, headers });
      if (res.ok) {
        const body = await res.json();
        log('espn.request.ok', { url, ms: Date.now() - started, attempt });
        return body;
      }
      reason = `HTTP ${res.status}`;
      log('espn.request.failed', { url, status: res.status, ms: Date.now() - started, attempt });
      // A 4xx is a statement about the request and will not change on a retry; a 5xx might.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      reason = (err as Error).message;
      log('espn.request.error', { url, ms: Date.now() - started, attempt, error: reason });
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(250 * attempt);
  }
  opts.onError?.(url, reason);
  return null;
}

/**
 * @description Classify a failure reason reported through `onError`. The reason is `HTTP <status>`
 * when ESPN answered and the thrown error's message when it did not, so the PRESENCE of a status is
 * the transport distinction — there is nothing else available to infer it from.
 * @param reason - The reason string `getJson` reported.
 * @returns The classified failure.
 */
export function classifyFailure(reason: string): FantasyReadFailure {
  const matched = /^HTTP (\d{3})$/.exec(reason);
  if (!matched) return { kind: 'transport', reason, status: null };
  const status = Number(matched[1]);
  return { kind: status >= 500 || status === 429 ? 'unavailable' : 'refused', reason, status };
}

/**
 * @description Run a read and capture the FIRST failure it reports, so a caller can answer with why
 * rather than only with null. Every accessor degrades to null or an empty result, which is the right
 * runtime behaviour and is exactly what loses the reason; this restores it without changing any
 * accessor's own contract, and the caller's own `onError` still fires.
 * @param opts - The caller's options.
 * @param run - Receives the options to pass to the read it performs.
 * @returns The read's value, and the first failure it reported (null when none did).
 */
export async function readWithOutcome<T>(
  opts: FantasyReadOptions, run: (opts: FantasyReadOptions) => Promise<T>,
): Promise<{ value: T; failure: FantasyReadFailure | null }> {
  const captured: FantasyReadFailure[] = [];
  const value = await run({
    ...opts,
    onError: (url, reason) => {
      if (!captured.length) captured.push(classifyFailure(reason));
      opts.onError?.(url, reason);
    },
  });
  return { value, failure: captured.length ? captured[0] : null };
}
