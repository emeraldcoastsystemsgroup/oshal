/**
 * Connector token broker — per-user SQL scoping guard for getValidAccessToken.
 *
 * WHY THIS EXISTS: the broker's per-user isolation for legacy (non-v2) token blobs
 * rests ENTIRELY on the SQL predicate that fetches the connection row. The lookup
 * chain is getValidAccessToken (connectors-routes.ts) → resolveConnectionRow →
 * accessibleConnections (connector-tenancy.ts), whose SQL is
 *   WHERE ((user_sub = $1 AND tenant_id IS NULL) OR tenant_id = ANY($2::uuid[]))
 *     AND provider = $3
 * with $2 sourced from the caller's own tenant memberships. Legacy blobs decrypt
 * with the shared KEK (SHA256(SESSION_SECRET)) — the crypto CANNOT tell user A's
 * token from user B's — and ownerSub() derives the DEK owner from the RETURNED ROW,
 * not the caller, so even v2 envelope crypto decrypts whatever row the query hands
 * back. Nothing downstream re-checks ownership. Every existing consumer test mocks
 * the broker, so a WHERE-clause regression would stay green everywhere else.
 * This spec calls the REAL function against a fake pg pool and pins the query
 * shape, the bind params, and the real decrypt round-trip.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — isolation guard: pins the caller-sub-bound user_sub/tenant predicate getValidAccessToken issues, proves the legacy + v2 decrypt round-trips with real crypto, and documents (via the broken-pool negatives) that the SQL predicate is the ONLY ownership check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getValidAccessToken } from '@/app/routes/connectors-routes';
import { encryptToken } from '@/app/routes/connector-token-crypto';

const SUB_A = 'auth0|user-a';
const SUB_B = 'auth0|user-b';
const PLAIN_A = 'plain-access-token-user-a';
const PLAIN_B = 'plain-access-token-user-b';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

type SeedRow = Record<string, unknown>;

/** A fully-populated personal (tenant_id NULL) oshal_connections row. */
function seedRow(sub: string, encryptedAccessToken: string): SeedRow {
  return {
    connection_id: `conn-${sub}`,
    user_sub: sub,
    connected_by_sub: null,
    tenant_id: null,
    provider: 'google',
    label: 'default',
    account_key: 'default',
    is_default: false,
    account_email: `${sub}@example.com`,
    account_id: null,
    scopes: 'openid',
    access_token: encryptedAccessToken,
    refresh_token: null,
    // Comfortably beyond the broker's 60s freshness headroom → no refresh fetch.
    expiry: new Date(Date.now() + 3_600_000),
  };
}

/**
 * Fake pg pool. Records every (text, params) pair, answers the tenant-membership
 * lookup with no tenants, serves the per-user DEK table from an in-memory map (for
 * the v2 envelope tests), and delegates the oshal_connections SELECT to the given
 * strategy so tests choose honest-WHERE vs broken-WHERE behavior.
 */
function makePool(connections: (params: unknown[]) => SeedRow[]) {
  const recorded: RecordedQuery[] = [];
  const deks = new Map<string, string>();
  return {
    recorded,
    query: async (text: string, params: unknown[] = []) => {
      recorded.push({ text, params });
      if (text.includes('oshal_tenant_memberships')) return { rows: [] };
      if (text.includes('FROM oshal_user_deks')) {
        const wrapped = deks.get(String(params[0]));
        return { rows: wrapped ? [{ wrapped_dek: wrapped }] : [] };
      }
      if (text.includes('INSERT INTO oshal_user_deks')) {
        if (!deks.has(String(params[0]))) deks.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (text.includes('FROM oshal_connections')) return { rows: connections(params) };
      return { rows: [] };
    },
  };
}

/** Honest pool: emulates the production predicate — personal rows only for the bound sub. */
function makeHonestPool(rows: SeedRow[]) {
  return makePool((params) => rows.filter(
    (r) => r.user_sub === params[0] && r.tenant_id === null && r.provider === params[2],
  ));
}

/** Find the recorded oshal_connections SELECT (the isolation-bearing query). */
function connectionsQuery(pool: { recorded: RecordedQuery[] }): RecordedQuery {
  const q = pool.recorded.find((r) => r.text.includes('FROM oshal_connections'));
  expect(q, 'expected getValidAccessToken to query oshal_connections').toBeDefined();
  return q as RecordedQuery;
}

const ENV_KEYS = ['SESSION_SECRET', 'OSHAL_ENVELOPE_CRYPTO'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // The legacy KEK is SHA256(SESSION_SECRET) read at call time — pin a test-only
  // value so encryptToken here and decryptToken inside the broker share one key.
  process.env.SESSION_SECRET = 'token-lookup-scope-spec-secret';
  delete process.env.OSHAL_ENVELOPE_CRYPTO; // default = legacy single-key blobs
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Seed both users' rows with REAL legacy-encrypted blobs (no fake decrypt). */
async function seedLegacyRows(): Promise<SeedRow[]> {
  const unusedPool = makePool(() => []);
  // userSub undefined → legacy KEK format, identical to pre-envelope stored blobs.
  const encA = await encryptToken(unusedPool, undefined, PLAIN_A);
  const encB = await encryptToken(unusedPool, undefined, PLAIN_B);
  return [seedRow(SUB_A, encA), seedRow(SUB_B, encB)];
}

describe('getValidAccessToken per-user SQL scoping (the token-broker isolation guard)', () => {
  it('binds the CALLER sub into a user_sub-scoped predicate and returns only that user\'s token', async () => {
    const pool = makeHonestPool(await seedLegacyRows());

    const token = await getValidAccessToken(pool, SUB_A, 'google');
    expect(token).toBe(PLAIN_A);
    expect(token).not.toBe(PLAIN_B);

    // The isolation-bearing query shape. These literal assertions are the guard:
    // the connections SELECT must scope personal rows by the caller's sub.
    const q = connectionsQuery(pool);
    expect(q.text).toMatch(/user_sub\s*=\s*\$1/);
    expect(q.text).toContain('tenant_id IS NULL');
    expect(q.text).toMatch(/provider\s*=\s*\$3/);
    expect(q.params[0]).toBe(SUB_A);
    expect(q.params[2]).toBe('google');

    // The shared-tenant arm ($2) must also derive from the CALLER's memberships.
    const membership = pool.recorded.find((r) => r.text.includes('oshal_tenant_memberships'));
    expect(membership).toBeDefined();
    expect(membership!.params[0]).toBe(SUB_A);
  });

  it('returns user B\'s token to user B under the same predicate (symmetry)', async () => {
    const pool = makeHonestPool(await seedLegacyRows());

    const token = await getValidAccessToken(pool, SUB_B, 'google');
    expect(token).toBe(PLAIN_B);
    expect(token).not.toBe(PLAIN_A);

    const q = connectionsQuery(pool);
    expect(q.params[0]).toBe(SUB_B);
  });

  it('BROKEN-WHERE negative: the function TRUSTS the query — a pool returning B\'s row hands B\'s token to A', async () => {
    const rows = await seedLegacyRows();
    const rowB = rows.find((r) => r.user_sub === SUB_B) as SeedRow;
    // Simulate a regressed WHERE clause: the connections query ignores its binds
    // and returns user B's row to user A's call.
    const brokenPool = makePool(() => [rowB]);

    const token = await getValidAccessToken(brokenPool, SUB_A, 'google');

    // DELIBERATE: this asserts the LEAK HAPPENS. getValidAccessToken performs no
    // ownership re-check on the returned row, and the legacy KEK decrypts any
    // user's blob — so with the WHERE gone, A receives B's live token. That is
    // exactly why the SQL-text + bind-param assertions above ARE the isolation
    // guard: the query shape is the only thing standing between users. If this
    // test ever FAILS because the function starts rejecting foreign rows, that is
    // a security IMPROVEMENT — update this spec to pin the new check instead.
    expect(token).toBe(PLAIN_B);
  });

  it('v2 envelope round-trip: the DEK path decrypts a real v2 blob for the owning user', async () => {
    process.env.OSHAL_ENVELOPE_CRYPTO = 'true';
    const rows: SeedRow[] = [];
    const pool = makeHonestPool(rows);
    // Real v2 encryption against the same pool (DEK minted + wrapped in-memory).
    const encA = await encryptToken(pool, SUB_A, PLAIN_A);
    expect(encA.startsWith('v2:')).toBe(true);
    rows.push(seedRow(SUB_A, encA));

    const token = await getValidAccessToken(pool, SUB_A, 'google');
    expect(token).toBe(PLAIN_A);
  });

  it('BROKEN-WHERE negative, v2: envelope crypto does NOT rescue a broken predicate', async () => {
    process.env.OSHAL_ENVELOPE_CRYPTO = 'true';
    const v2PlainB = 'v2-plain-access-token-user-b';
    let rowB: SeedRow | null = null;
    const brokenPool = makePool(() => (rowB ? [rowB] : []));
    rowB = seedRow(SUB_B, await encryptToken(brokenPool, SUB_B, v2PlainB));

    const token = await getValidAccessToken(brokenPool, SUB_A, 'google');

    // DELIBERATE leak assertion, mirroring the legacy negative: the DEK owner is
    // derived from the RETURNED ROW (ownerSub → row.user_sub), not from the
    // caller, so the broker happily unwraps B's DEK and returns B's plaintext to
    // A's call. Per-user envelope crypto changes the blast radius of a KEY leak,
    // not of a WHERE-clause regression — SQL scoping remains the only ownership
    // check at every crypto tier.
    expect(token).toBe(v2PlainB);
  });
});
