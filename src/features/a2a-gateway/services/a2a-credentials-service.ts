/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-agent A2A credentials (BACKLOG Plan F item 2): replaces any notion of a global shared secret with operator-minted, capability-scoped bearer tokens. Mirrors the PAT rails (cli-token-routes): `oshal_a2a_`-prefixed plaintext returned exactly ONCE at mint, only its sha256 stored (a2a_agents, lazy-DDL chokepoint + migration 089). authenticate() does an indexed hash lookup THEN a timingSafeEqual re-compare (belt and braces), checks enabled + not-revoked, stamps last_seen_at best-effort, and returns {agentId, name, scopes}. A2aAuthFailureLimiter is the simple in-memory failure counter the route consults before/after auth so credential brute-forcing gets 429s, not oracle timing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Doc correction alongside the a2a-routes limiter-key fix: the limiter's key is the TRANSPORT peer address (socket.remoteAddress), not req.ip — with `trust proxy` true, req.ip is client-controlled via X-Forwarded-For and must never key a rate-limit bucket. No behavior change in this class (it is key-agnostic); the key choice lives in a2aLimiterKey() in a2a-routes.ts.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { A2A_SCOPES, type A2AAgentIdentity, type A2AScope } from '../types';

const logger = createChildLogger({ module: 'a2a-credentials' });

/** Token prefix — recognizable (like oshal_pat_) so secret scanners and humans can spot a leak. */
export const A2A_TOKEN_PREFIX = 'oshal_a2a_';
/** Random payload size; 24 bytes → 48 hex chars of entropy (192 bits, same as PATs). */
const TOKEN_BYTES = 24;
/** Display-string ceilings — these are operator-facing labels, not content. */
const NAME_MAX = 120;
const NOTE_MAX = 500;

/**
 * @description Mints a new A2A agent bearer token. The plaintext is shown to the operator
 * exactly once at creation; only its sha256 lands in the database.
 * @returns The plaintext token (`oshal_a2a_` + 48 hex chars).
 */
export function generateA2aToken(): string {
  return `${A2A_TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('hex')}`;
}

/**
 * @description Storage/lookup hash — sha256 hex. 192 bits of token entropy makes an
 * unsalted fast hash the standard trade (same rationale as the PAT store): lookups stay
 * a single indexed equality and brute-forcing the space is infeasible.
 * @param token - Plaintext token.
 * @returns Hex digest.
 */
export function hashA2aToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * @description Narrows arbitrary input to known A2A scopes; an empty/absent request
 * defaults to ALL scopes (an operator minting a credential usually wants a working
 * agent; narrowing is the deliberate act). Unknown scope strings are dropped, and a
 * request that yields none after filtering is invalid (returns null) rather than
 * silently minting an unusable credential.
 * @param raw - Candidate scopes from the mint request body.
 * @returns The validated scope list, or null when explicit scopes were all invalid.
 */
export function normalizeScopes(raw: unknown): A2AScope[] | null {
  if (raw == null) return [...A2A_SCOPES];
  if (!Array.isArray(raw)) return null;
  const scopes = raw.filter((s): s is A2AScope => (A2A_SCOPES as readonly string[]).includes(String(s)));
  if (raw.length > 0 && scopes.length === 0) return null;
  return scopes.length ? [...new Set(scopes)] : [...A2A_SCOPES];
}

/**
 * @description Creates the a2a_agents store if absent (lazy-DDL chokepoint, mirroring
 * oshal_cli_tokens) so a fresh database works before migration 089 has been applied.
 * The table is OPERATOR-managed platform config (no per-user rows), so it carries no
 * owner RLS — route-level operator gating is the isolation boundary.
 * @param pool - Postgres pool.
 * @returns Resolves when the table exists.
 */
export async function ensureA2aAgentSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'a2a gateway credentials',
    statements: [
      `CREATE TABLE IF NOT EXISTS a2a_agents (
        id           UUID PRIMARY KEY,
        name         TEXT NOT NULL,
        token_hash   TEXT UNIQUE NOT NULL,
        scopes       TEXT[] NOT NULL DEFAULT '{}',
        enabled      BOOLEAN NOT NULL DEFAULT TRUE,
        owner_note   TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ
      )`,
    ],
    requirements: [{ table: 'a2a_agents', columns: ['id', 'name', 'token_hash', 'scopes', 'enabled', 'revoked_at'] }],
  });
}

/** @description Metadata row returned by list() — hashes and plaintext never leave the server. */
export interface A2aAgentRecord {
  id: string;
  name: string;
  scopes: A2AScope[];
  enabled: boolean;
  ownerNote: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
}

/** @description Mint result — the ONLY moment the plaintext token exists outside the caller. */
export interface A2aMintResult {
  id: string;
  name: string;
  scopes: A2AScope[];
  token: string;
  createdAt: string;
}

/**
 * @description Simple in-memory failure counter for the bearer check. Keyed by caller
 * (transport peer address — see a2aLimiterKey() in a2a-routes.ts; NEVER a client-header
 * value like req.ip under trust-proxy); over-threshold keys get 429 before any DB work,
 * so credential guessing is throttled without a new dependency. Windowed, self-pruning;
 * injectable clock for tests.
 */
export class A2aAuthFailureLimiter {
  private readonly failures = new Map<string, number[]>();

  /**
   * @param maxFailures - Failures allowed inside the window before blocking (default 10).
   * @param windowMs - Rolling window in milliseconds (default 60s).
   * @param now - Clock, injectable for tests.
   */
  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @description Records one authentication failure for a key.
   * @param key - Caller key (transport peer address).
   */
  recordFailure(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.failures.set(key, list);
  }

  /**
   * @description Whether a key has exceeded the failure budget inside the window.
   * @param key - Caller key (transport peer address).
   * @returns True when the caller should receive 429 without further processing.
   */
  isLimited(key: string): boolean {
    return this.prune(key).length >= this.maxFailures;
  }

  /** Drops entries older than the window; returns the surviving list. */
  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}

/**
 * @description Operator-facing credential store for external A2A agents. All methods
 * degrade cleanly (null/[]/false) when no pool is configured — the gateway is then
 * effectively closed because no credential can authenticate.
 */
export class A2aCredentialsService {
  /** @param pool - Postgres pool (null tolerated: every method degrades closed). */
  constructor(private readonly pool: Pool | null) {
    if (pool) {
      void ensureA2aAgentSchema(pool).catch((err) => {
        logger.error({ err }, 'a2a_agents schema bootstrap failed — A2A auth unavailable until it exists');
      });
    }
  }

  /**
   * @description Mints a credential for one external agent. The plaintext token is
   * returned ONCE and never stored — only the sha256 hash lands in a2a_agents.
   * @param input - Display name, optional scope narrowing, optional operator note.
   * @returns The mint result with plaintext token, or null when no store is available.
   */
  async mint(input: { name: string; scopes?: unknown; ownerNote?: string }): Promise<A2aMintResult | null> {
    if (!this.pool) return null;
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const scopes = normalizeScopes(input.scopes);
    if (!name || !scopes) throw new Error('invalid_mint_input');
    const id = crypto.randomUUID();
    const token = generateA2aToken();
    await this.pool.query(
      'INSERT INTO a2a_agents (id, name, token_hash, scopes, owner_note) VALUES ($1, $2, $3, $4, $5)',
      [id, name, hashA2aToken(token), scopes, String(input.ownerNote ?? '').slice(0, NOTE_MAX) || null],
    );
    logger.info({ id, name, scopes }, 'a2a agent credential minted');
    return { id, name, scopes, token, createdAt: new Date().toISOString() };
  }

  /**
   * @description Lists credential metadata (never hashes or plaintext).
   * @returns All agent rows, newest first; [] without a store.
   */
  async list(): Promise<A2aAgentRecord[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT id, name, scopes, enabled, owner_note, created_at, last_seen_at, revoked_at
         FROM a2a_agents ORDER BY created_at DESC`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      scopes: normalizeScopes(r.scopes) ?? [],
      enabled: r.enabled !== false,
      ownerNote: (r.owner_note as string) ?? null,
      createdAt: r.created_at ? String(r.created_at) : null,
      lastSeenAt: r.last_seen_at ? String(r.last_seen_at) : null,
      revoked: r.revoked_at != null,
    }));
  }

  /**
   * @description Revokes one credential (idempotent; already-revoked rows are untouched).
   * @param id - Credential id.
   * @returns True when a live credential was revoked by this call.
   */
  async revoke(id: string): Promise<boolean> {
    if (!this.pool) return false;
    const result = await this.pool.query(
      'UPDATE a2a_agents SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    const revoked = (result.rowCount ?? 0) > 0;
    logger.info({ id, revoked }, 'a2a agent credential revoke');
    return revoked;
  }

  /**
   * @description Authenticates a presented bearer token: indexed sha256 lookup filtered
   * to enabled + not-revoked, then a timingSafeEqual re-comparison of the digests so the
   * final accept/reject never depends on early-exit string comparison. Stamps
   * last_seen_at best-effort (never in the request's critical path). Never logs the
   * token — at most an 8-char hash prefix on failure.
   * @param token - The presented plaintext bearer token.
   * @returns The agent identity, or null when the token is unknown/revoked/disabled.
   */
  async authenticate(token: string): Promise<A2AAgentIdentity | null> {
    if (!this.pool || !token.startsWith(A2A_TOKEN_PREFIX)) return null;
    const hash = hashA2aToken(token);
    const { rows } = await this.pool.query(
      `SELECT id, name, token_hash, scopes FROM a2a_agents
        WHERE token_hash = $1 AND enabled = TRUE AND revoked_at IS NULL LIMIT 1`,
      [hash],
    );
    const row = rows[0] as { id: string; name: string; token_hash: string; scopes: unknown } | undefined;
    if (!row || !timingSafeHashEquals(hash, String(row.token_hash))) {
      logger.warn({ hashPrefix: hash.slice(0, 8) }, 'a2a bearer rejected (unknown/revoked/disabled)');
      return null;
    }
    void this.pool
      .query('UPDATE a2a_agents SET last_seen_at = NOW() WHERE id = $1', [row.id])
      .catch((err) => logger.warn({ err }, 'a2a last_seen_at update failed'));
    return { agentId: String(row.id), name: String(row.name), scopes: normalizeScopes(row.scopes) ?? [] };
  }
}

/**
 * @description Constant-time equality over two hex digests (crypto.timingSafeEqual with
 * a length guard, since timingSafeEqual throws on length mismatch).
 * @param a - First hex digest.
 * @param b - Second hex digest.
 * @returns True when equal.
 */
function timingSafeHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
