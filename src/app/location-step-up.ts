/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 (D3 "Routes and step-up"): the step-up proof. A packaged surface runs same-origin as the signed-in person, so a location route that raises exposure (opt-in, precision raise, accepting a share, creating a guardian share, approving a location enrolment, arming a device-action rule) must see a proof that script on the page cannot supply. A proof is a single-use challenge bound to one principal (subject AND verified issuer), one operation and a digest of that operation's exact parameters. It becomes usable only when a fresh authentication completes after the challenge was created: an OIDC re-authentication whose auth_time and iat are no older than the challenge, a local-auth TOTP code, or, under MOCK_OIDC only, a top-level navigation. Consuming it re-checks principal, operation and parameters, so a proof the person gave for one change can never authorise another. The store is in memory with bounded size and lifetimes, and registers a location state eraser so an account erasure drops the person's open challenges.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: a per-person failed-code budget for the local-auth rail. The per-challenge attempt limit alone let same-origin script open challenge after challenge (creating one only dropped the oldest) and guess codes without end, because nothing else throttles this path on a LAN or localhost box. Every code check is now also charged to a budget keyed on the person (subject AND issuer), held apart from the challenges so creating, trimming or cancelling challenges never resets it; a verified code is refunded, so only failures count. Once a person spends OSHAL_LOCATION_STEP_UP_TOTP_FAILURES (default 10) inside OSHAL_LOCATION_STEP_UP_TOTP_WINDOW_SEC (default 900), every challenge of theirs is refused before a code is checked until the oldest failure leaves the window. The location state eraser clears the budget with the challenges.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5: 'accept-restricted-invite' joins the operations that need a proof. Accepting a restricted invitation is what lets a group admin share the account's place transitions with others (Q5), so same-origin script on the page must not be able to accept one for the person.
 *
 * @module app/location-step-up
 */

import crypto from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import { registerLocationStateEraser, type LocationPrincipal } from '@/features/location';

const log = createChildLogger({ module: 'location-step-up' });

/** @description Every operation that needs the step-up proof (ADR-169 D3). */
export const LOCATION_STEP_UP_OPERATIONS = Object.freeze([
  'opt-in', 'raise-precision', 'accept-share', 'create-guardian-share', 'approve-enrolment', 'arm-rule',
  'accept-restricted-invite',
] as const);

/** @description One operation that needs the step-up proof. */
export type LocationStepUpOperation = typeof LOCATION_STEP_UP_OPERATIONS[number];

/** @description How the person proves a fresh authentication. */
export type LocationStepUpMethod = 'oidc-max-age' | 'local-totp' | 'mock-oidc';

/** @description Where a challenge is in its life. */
export type LocationStepUpState = 'pending' | 'proven' | 'consumed' | 'expired';

/** @description Why a challenge could not be proven or used. */
export type LocationStepUpRefusal =
  | 'unknown' | 'expired' | 'not-proven' | 'already-used' | 'already-proven' | 'operation-mismatch'
  | 'params-mismatch' | 'method-mismatch' | 'stale-authentication' | 'different-account' | 'too-many-attempts'
  | 'too-many-failures';

/** @description What the person's page may see of a challenge; never its principal or digest. */
export interface LocationStepUpView {
  /** Opaque, unguessable handle for this challenge. */
  challengeId: string;
  /** The operation it authorises. */
  operation: LocationStepUpOperation;
  /** How it must be proven. */
  method: LocationStepUpMethod;
  /** Its state now. */
  state: LocationStepUpState;
  /** When it stops being usable (ISO time). */
  expiresAt: string;
}

/** @description What a completed authentication establishes. */
export interface LocationStepUpEvidence {
  /** How it was proven; must be the challenge's method. */
  method: LocationStepUpMethod;
  /** The account that authenticated. */
  principal: LocationPrincipal;
  /** When the person actively authenticated, epoch ms (OIDC auth_time; now for TOTP and mock). */
  authTimeMs: number;
  /** When the credential carrying that authentication was issued, epoch ms (OIDC iat), if known. */
  issuedAtMs?: number;
}

/** @description The result of proving or consuming a challenge. */
export type LocationStepUpOutcome = { ok: true } | { ok: false; reason: LocationStepUpRefusal };

/** @description Lifetimes and bounds; every one has a default and an environment override. */
export interface LocationStepUpOptions {
  /** Clock, epoch ms. */
  now?: () => number;
  /** How long a challenge may wait for its authentication. */
  completeWithinMs?: number;
  /** How long a proven challenge may wait to be used. */
  useWithinMs?: number;
  /** Clock skew tolerated between the identity provider and this server. */
  skewMs?: number;
  /** Open challenges one person may hold; the oldest is dropped beyond it. */
  maxOpenPerPrincipal?: number;
  /** Code attempts one TOTP challenge allows before it dies. */
  maxTotpAttempts?: number;
  /** Failed codes one person may spend, across all their challenges, inside the failure window. */
  totpFailureBudget?: number;
  /** How long a failed code counts against the person's budget. */
  totpFailureWindowMs?: number;
}

interface Challenge {
  id: string;
  sub: string;
  issuer: string;
  operation: LocationStepUpOperation;
  digest: string;
  method: LocationStepUpMethod;
  createdAtMs: number;
  completeByMs: number;
  useByMs: number | null;
  consumed: boolean;
  attempts: number;
}

/**
 * @description Whether a value names an operation that needs the step-up proof.
 * @param value - Anything, typically a request field.
 * @returns true for one of {@link LOCATION_STEP_UP_OPERATIONS}.
 */
export function isLocationStepUpOperation(value: unknown): value is LocationStepUpOperation {
  return typeof value === 'string' && (LOCATION_STEP_UP_OPERATIONS as readonly string[]).includes(value);
}

/**
 * @description Canonical JSON: object keys sorted at every depth, undefined members dropped, so the
 * same parameters always digest the same however the caller ordered them.
 * @param value - A JSON-shaped value.
 * @returns The canonical text.
 */
export function canonicalLocationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalLocationJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalLocationJson(v)}`).join(',')}}`;
}

/**
 * @description The digest that binds a challenge to one operation's exact parameters.
 * @param operation - The operation.
 * @param params - Its parameters, as the route derives them from the request.
 * @returns Hex SHA-256.
 */
export function locationStepUpDigest(operation: LocationStepUpOperation, params: unknown): string {
  return crypto.createHash('sha256').update(`${operation}\n${canonicalLocationJson(params)}`).digest('hex');
}

/**
 * @description Read a positive whole number of seconds from the environment, as milliseconds.
 * @param name - The variable.
 * @param fallbackSec - Used when unset or not a positive number.
 * @param maxSec - Upper bound.
 * @returns Milliseconds.
 */
function envSeconds(name: string, fallbackSec: number, maxSec: number): number {
  const raw = Number(process.env[name]);
  const sec = Number.isFinite(raw) && raw > 0 ? Math.min(raw, maxSec) : fallbackSec;
  return Math.round(sec * 1000);
}

/**
 * @description Read a positive whole count from the environment.
 * @param name - The variable.
 * @param fallback - Used when unset or not a positive number.
 * @param max - Upper bound.
 * @returns The count.
 */
function envCount(name: string, fallback: number, max: number): number {
  const raw = Math.floor(Number(process.env[name]));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, max) : fallback;
}

/**
 * @description The deployment's step-up lifetimes and bounds: OSHAL_LOCATION_STEP_UP_COMPLETE_SEC
 * (default 600), OSHAL_LOCATION_STEP_UP_USE_SEC (default 300), OSHAL_LOCATION_STEP_UP_SKEW_SEC
 * (default 5), and the per-person failed-code budget OSHAL_LOCATION_STEP_UP_TOTP_FAILURES (default 10,
 * at most 100) inside OSHAL_LOCATION_STEP_UP_TOTP_WINDOW_SEC (default 900, at most 86400).
 * @returns Options for {@link LocationStepUpStore}.
 */
export function locationStepUpOptionsFromEnv(): LocationStepUpOptions {
  return {
    completeWithinMs: envSeconds('OSHAL_LOCATION_STEP_UP_COMPLETE_SEC', 600, 3600),
    useWithinMs: envSeconds('OSHAL_LOCATION_STEP_UP_USE_SEC', 300, 1800),
    skewMs: envSeconds('OSHAL_LOCATION_STEP_UP_SKEW_SEC', 5, 120),
    totpFailureBudget: envCount('OSHAL_LOCATION_STEP_UP_TOTP_FAILURES', 10, 100),
    totpFailureWindowMs: envSeconds('OSHAL_LOCATION_STEP_UP_TOTP_WINDOW_SEC', 900, 86_400),
  };
}

/** @description The in-memory challenge store. One per process; tests build their own. */
export class LocationStepUpStore {
  private readonly challenges = new Map<string, Challenge>();

  private readonly now: () => number;

  private readonly completeWithinMs: number;

  private readonly useWithinMs: number;

  private readonly skewMs: number;

  private readonly maxOpenPerPrincipal: number;

  private readonly maxTotpAttempts: number;

  /** Failed-code times per person, kept apart from the challenges so no challenge change resets them. */
  private readonly totpFailures = new Map<string, number[]>();

  private readonly totpFailureBudget: number;

  private readonly totpFailureWindowMs: number;

  constructor(options: LocationStepUpOptions = {}) {
    this.now = options.now ?? Date.now;
    this.completeWithinMs = options.completeWithinMs ?? 600_000;
    this.useWithinMs = options.useWithinMs ?? 300_000;
    this.skewMs = options.skewMs ?? 5_000;
    this.maxOpenPerPrincipal = options.maxOpenPerPrincipal ?? 10;
    this.maxTotpAttempts = options.maxTotpAttempts ?? 5;
    this.totpFailureBudget = options.totpFailureBudget ?? 10;
    this.totpFailureWindowMs = options.totpFailureWindowMs ?? 900_000;
  }

  /**
   * @description Open a challenge for one person, one operation and its exact parameters.
   * @param principal - The signed-in person.
   * @param operation - What the proof will authorise.
   * @param params - That operation's parameters (digested, never stored).
   * @param method - How the person will prove a fresh authentication.
   * @returns The challenge as the page may see it.
   */
  create(principal: LocationPrincipal, operation: LocationStepUpOperation, params: unknown, method: LocationStepUpMethod): LocationStepUpView {
    const nowMs = this.now();
    this.sweep(nowMs);
    this.trimPrincipal(principal);
    const challenge: Challenge = {
      id: crypto.randomBytes(32).toString('base64url'),
      sub: principal.sub,
      issuer: principal.principalIssuer,
      operation,
      digest: locationStepUpDigest(operation, params),
      method,
      createdAtMs: nowMs,
      completeByMs: nowMs + this.completeWithinMs,
      useByMs: null,
      consumed: false,
      attempts: 0,
    };
    this.challenges.set(challenge.id, challenge);
    log.info({ op: 'step-up-create', outcome: 'ok', count: this.challenges.size }, 'location step-up challenge opened');
    return this.toView(challenge, nowMs);
  }

  /**
   * @description The person's own view of a challenge; another person's challenge reads as unknown.
   * @param challengeId - The handle.
   * @param principal - The signed-in person.
   * @returns The view, or null.
   */
  view(challengeId: string, principal: LocationPrincipal): LocationStepUpView | null {
    const challenge = this.owned(challengeId, principal);
    return challenge ? this.toView(challenge, this.now()) : null;
  }

  /**
   * @description Record a completed authentication against a challenge. It is accepted only for the
   * challenge's own account and method, and only when the authentication (and the credential that
   * carries it) happened after the challenge was opened, give or take the tolerated clock skew.
   * @param challengeId - The handle.
   * @param evidence - What the authentication established.
   * @returns ok, or why not.
   */
  prove(challengeId: string, evidence: LocationStepUpEvidence): LocationStepUpOutcome {
    const nowMs = this.now();
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return this.refuse('unknown');
    if (!samePrincipal(challenge, evidence.principal)) return this.refuse('different-account');
    const state = this.stateOf(challenge, nowMs);
    if (state === 'expired') return this.refuse('expired');
    if (state !== 'pending') return this.refuse('already-proven');
    if (evidence.method !== challenge.method) return this.refuse('method-mismatch');
    const floor = challenge.createdAtMs - this.skewMs;
    if (!Number.isFinite(evidence.authTimeMs) || evidence.authTimeMs < floor) return this.refuse('stale-authentication');
    if (evidence.issuedAtMs !== undefined && !(evidence.issuedAtMs >= floor)) return this.refuse('stale-authentication');
    challenge.useByMs = nowMs + this.useWithinMs;
    log.info({ op: 'step-up-prove', outcome: 'ok' }, 'location step-up proven');
    return { ok: true };
  }

  /**
   * @description Admit one second-factor code check, before the code is checked. It is refused when
   * the person has spent their failed-code budget (whatever challenge it names, so opening new
   * challenges cannot buy more guesses), and a challenge dies after its own allowed number. An
   * admitted check is charged to the budget as a failure straight away, so concurrent checks cannot
   * all pass the limit; {@link LocationStepUpStore.refundTotpAttempt} returns the charge when the
   * code turns out to be right.
   * @param challengeId - The handle.
   * @param principal - The signed-in person.
   * @returns ok while attempts remain, or why not.
   */
  noteAttempt(challengeId: string, principal: LocationPrincipal): LocationStepUpOutcome {
    const nowMs = this.now();
    const challenge = this.owned(challengeId, principal);
    if (!challenge) return this.refuse('unknown');
    if (this.stateOf(challenge, nowMs) !== 'pending') return this.refuse('already-proven');
    const failures = this.recentFailures(principal, nowMs);
    if (failures.length >= this.totpFailureBudget) return this.refuse('too-many-failures');
    challenge.attempts += 1;
    if (challenge.attempts > this.maxTotpAttempts) {
      this.challenges.delete(challengeId);
      return this.refuse('too-many-attempts');
    }
    failures.push(nowMs);
    this.totpFailures.set(principalKey(principal), failures);
    return { ok: true };
  }

  /**
   * @description Return the charge of one admitted code check that did not fail (the code was right,
   * or the account has no second factor to guess), so the budget counts failures only.
   * @param principal - The signed-in person.
   * @returns Nothing.
   */
  refundTotpAttempt(principal: LocationPrincipal): void {
    const key = principalKey(principal);
    const failures = this.totpFailures.get(key);
    if (!failures) return;
    failures.pop();
    if (failures.length === 0) this.totpFailures.delete(key);
  }

  /**
   * @description Spend a proven challenge on the operation it was opened for. Single use: a second
   * call with the same handle is refused, whatever it asks for.
   * @param challengeId - The handle the request carries.
   * @param principal - The signed-in person making the request.
   * @param operation - The operation the route is about to perform.
   * @param params - That operation's parameters, derived from the request itself.
   * @returns ok, or why not.
   */
  consume(challengeId: string, principal: LocationPrincipal, operation: LocationStepUpOperation, params: unknown): LocationStepUpOutcome {
    const challenge = this.owned(challengeId, principal);
    if (!challenge) return this.refuse('unknown');
    const state = this.stateOf(challenge, this.now());
    if (state === 'consumed') return this.refuse('already-used');
    if (state === 'expired') return this.refuse('expired');
    if (state === 'pending') return this.refuse('not-proven');
    if (challenge.operation !== operation) return this.refuse('operation-mismatch');
    if (challenge.digest !== locationStepUpDigest(operation, params)) return this.refuse('params-mismatch');
    challenge.consumed = true;
    log.info({ op: 'step-up-consume', outcome: 'ok' }, 'location step-up spent');
    return { ok: true };
  }

  /**
   * @description Withdraw one of the person's own challenges.
   * @param challengeId - The handle.
   * @param principal - The signed-in person.
   * @returns true when a challenge was removed.
   */
  cancel(challengeId: string, principal: LocationPrincipal): boolean {
    return this.owned(challengeId, principal) ? this.challenges.delete(challengeId) : false;
  }

  /**
   * @description Drop every challenge one person holds and their failed-code budget (the location
   * state eraser).
   * @param principal - The person being erased.
   * @returns How many challenges went.
   */
  clearPrincipal(principal: LocationPrincipal): number {
    let removed = 0;
    for (const [id, challenge] of this.challenges) {
      if (samePrincipal(challenge, principal)) {
        this.challenges.delete(id);
        removed += 1;
      }
    }
    this.totpFailures.delete(principalKey(principal));
    return removed;
  }

  /**
   * @description The store's clock, for evidence whose authentication happens now (TOTP, mock).
   * @returns Epoch ms.
   */
  clock(): number {
    return this.now();
  }

  /**
   * @description How many challenges are held (for bounds tests and the Test Lab).
   * @returns The count.
   */
  size(): number {
    return this.challenges.size;
  }

  private owned(challengeId: string, principal: LocationPrincipal): Challenge | null {
    const challenge = typeof challengeId === 'string' ? this.challenges.get(challengeId) : undefined;
    return challenge && samePrincipal(challenge, principal) ? challenge : null;
  }

  private stateOf(challenge: Challenge, nowMs: number): LocationStepUpState {
    if (challenge.consumed) return 'consumed';
    if (challenge.useByMs === null) return nowMs > challenge.completeByMs ? 'expired' : 'pending';
    return nowMs > challenge.useByMs ? 'expired' : 'proven';
  }

  private toView(challenge: Challenge, nowMs: number): LocationStepUpView {
    return {
      challengeId: challenge.id,
      operation: challenge.operation,
      method: challenge.method,
      state: this.stateOf(challenge, nowMs),
      expiresAt: new Date(challenge.useByMs ?? challenge.completeByMs).toISOString(),
    };
  }

  private refuse(reason: LocationStepUpRefusal): LocationStepUpOutcome {
    log.warn({ op: 'step-up', outcome: 'refused' }, 'location step-up refused');
    return { ok: false, reason };
  }

  private sweep(nowMs: number): void {
    for (const [id, challenge] of this.challenges) {
      const state = this.stateOf(challenge, nowMs);
      if (state === 'expired' || (state === 'consumed' && nowMs > challenge.completeByMs)) this.challenges.delete(id);
    }
    for (const [key, failures] of this.totpFailures) {
      const recent = failures.filter((atMs) => nowMs - atMs < this.totpFailureWindowMs);
      if (recent.length) this.totpFailures.set(key, recent); else this.totpFailures.delete(key);
    }
  }

  private recentFailures(principal: LocationPrincipal, nowMs: number): number[] {
    return (this.totpFailures.get(principalKey(principal)) ?? []).filter((atMs) => nowMs - atMs < this.totpFailureWindowMs);
  }

  private trimPrincipal(principal: LocationPrincipal): void {
    const mine = [...this.challenges.values()].filter((c) => samePrincipal(c, principal));
    mine.sort((a, b) => a.createdAtMs - b.createdAtMs);
    while (mine.length >= this.maxOpenPerPrincipal) {
      const oldest = mine.shift();
      if (oldest) this.challenges.delete(oldest.id);
    }
  }
}

/**
 * @description Whether a challenge belongs to a principal: subject AND issuer.
 * @param challenge - The challenge.
 * @param principal - The principal.
 * @returns true on an exact match.
 */
function samePrincipal(challenge: Challenge, principal: LocationPrincipal): boolean {
  return challenge.sub === principal.sub && challenge.issuer === principal.principalIssuer;
}

/**
 * @description The budget key of a principal: subject AND issuer, encoded so no pair can collide
 * with another.
 * @param principal - The principal.
 * @returns The key.
 */
function principalKey(principal: LocationPrincipal): string {
  return JSON.stringify([principal.sub, principal.principalIssuer]);
}

/** @description The process's step-up store, with the deployment's lifetimes. */
export const locationStepUpStore = new LocationStepUpStore(locationStepUpOptionsFromEnv());

registerLocationStateEraser('location-step-up', (principal) => {
  locationStepUpStore.clearPrincipal(principal);
});
