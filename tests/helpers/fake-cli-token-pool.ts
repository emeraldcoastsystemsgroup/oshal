/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from tests/unit/remote-client-node-token.spec.ts so a second spec can drive the REAL cli-token SQL without a second copy of it. A divergent copy of a statement-matching stand-in is worse than no stand-in: the SQL moves, one copy follows, and the other keeps passing against a shape production stopped using.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: the row carries location_device_id, the lookup matches the store's widened SELECT, the INSERT takes its ninth parameter, and seed() can bind a token to a location device so the token-scope specs drive the real middleware over a location credential.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: answers /api/join/enroll's `location_device_named` probe off `locationDeviceIds` (empty by default, so a database with no located device of that id), because the route refuses the enrolment when the question cannot be asked and the enrolment guards must keep driving the real route.
 */

/**
 * A `Pool` stand-in that answers the statements the cli-token store actually issues.
 *
 * It is a DOUBLE of Postgres, not of the token store: `insertCliToken`,
 * `createCliTokenAuthMiddleware` and `rotateNodeToken` run unmodified against it, and
 * the statements are matched by their real text — an unrecognised statement throws
 * rather than returning an empty result, so a query the store starts issuing shows up
 * as a failure instead of as a silent zero-row answer.
 *
 * It is NOT evidence about Postgres itself: RLS, types and constraints are not exercised
 * here. Specs that need those use the disposable-postgres helper.
 *
 * @module tests/helpers/fake-cli-token-pool
 */
import crypto from 'crypto';
import type { Pool } from 'pg';
import { CLI_TOKEN_PREFIX, hashCliToken } from '@/app/routes/cli-token-routes';

/** One row of `oshal_cli_tokens`, in the columns the store reads and writes. */
export interface FakeCliTokenRow {
  id: string;
  user_sub: string;
  email: string | null;
  label: string;
  token_hash: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  node_client_id: string | null;
  principal_issuer: string | null;
  location_device_id: string | null;
}

/**
 * @description In-memory `oshal_cli_tokens`, driven by the store's own SQL.
 */
export class FakeCliTokenPool {
  rows: FakeCliTokenRow[] = [];

  /** Location device ids the `location_device_named` probe answers true for (ADR-169 L6); none by default. */
  locationDeviceIds = new Set<string>();

  /**
   * @description Answers the four statements the cli-token store issues, off the row array.
   * @param sql - Statement text as the store wrote it.
   * @param params - Bound parameters, in the store's order.
   * @returns The rows the statement selects, and a row count for the writes.
   * @throws When asked a statement this fixture does not model, so a store change is loud.
   */
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT id, user_sub, email, node_client_id, location_device_id, principal_issuer FROM oshal_cli_tokens')) {
      const hash = params[0] as string;
      const now = Date.now();
      const hit = this.rows.find((r) => (
        r.token_hash === hash && r.revoked_at === null && (r.expires_at === null || r.expires_at.getTime() > now)
      ));
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (text.startsWith('UPDATE oshal_cli_tokens SET last_used_at')) {
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT location_device_named($1) AS named')) {
      return { rows: [{ named: this.locationDeviceIds.has(String(params[0])) }], rowCount: 1 };
    }
    if (text.startsWith('UPDATE oshal_cli_tokens SET revoked_at = NOW() WHERE node_client_id')) {
      const [clientId, ownerSub] = params as [string, string];
      const hits = this.rows.filter((r) => r.node_client_id === clientId && r.user_sub === ownerSub && r.revoked_at === null);
      for (const row of hits) row.revoked_at = new Date();
      return { rows: [], rowCount: hits.length };
    }
    if (text.startsWith('INSERT INTO oshal_cli_tokens')) {
      const [id, userSub, email, label, tokenHash, expiresAt, nodeClientId, principalIssuer, locationDeviceId] = params as [
        string, string, string | null, string, string, Date | null, string | null, string | null, string | null,
      ];
      this.rows.push({
        id, user_sub: userSub, email, label, token_hash: tokenHash,
        expires_at: expiresAt, revoked_at: null, node_client_id: nodeClientId,
        principal_issuer: principalIssuer, location_device_id: locationDeviceId ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakeCliTokenPool: unexpected SQL: ${text.slice(0, 90)}`);
  }

  /**
   * @description Hands the fixture to code that wants a `Pool`.
   * @returns This fixture, typed as the pool the store expects.
   */
  asPool(): Pool {
    return this as unknown as Pool;
  }

  /**
   * @description Seeds a token row directly, bypassing the mint route.
   * @param opts - Owner sub, optional device binding, revoked flag and issuer.
   * @returns The plaintext token, which only this call ever sees.
   */
  seed(opts: {
    sub: string;
    nodeClientId?: string | null;
    locationDeviceId?: string | null;
    revoked?: boolean;
    principalIssuer?: string | null;
    id?: string;
  }): string {
    const token = `${CLI_TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    this.rows.push({
      id: opts.id ?? crypto.randomUUID(),
      user_sub: opts.sub,
      email: null,
      label: 'spec token',
      token_hash: hashCliToken(token),
      expires_at: null,
      revoked_at: opts.revoked ? new Date() : null,
      node_client_id: opts.nodeClientId ?? null,
      principal_issuer: opts.principalIssuer ?? null,
      location_device_id: opts.locationDeviceId ?? null,
    });
    return token;
  }
}
