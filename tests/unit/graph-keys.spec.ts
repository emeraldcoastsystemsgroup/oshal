/**
 * Graph-key isolation guard — pins the derivation in graph-keys.ts.
 *
 * graph-keys.ts self-describes as "the isolation boundary ... treat like the token
 * broker": personDbName/tenantDbName are the ONLY thing separating one person's (or
 * tenant's) ArangoDB database from another's. A silent change — shorter digest,
 * dropped g_p_/g_t_ prefix distinction, non-determinism, or deriving from anything
 * beyond the argument — is cross-user/cross-tenant graph access with no other
 * defense. This spec exists so any such change is a CONSCIOUS test edit, never an
 * accident.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — regression guard for the ADR-045 graph isolation boundary: golden derivation values, person/tenant prefix distinctness, determinism, env-independence, and nodeKey sanitization/non-collision pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nodeKey, personDbName, tenantDbName } from '@/features/graph/services/graph-keys';

/**
 * GOLDEN VALUES — computed ONCE by running the real code
 * (`npx tsx -e "import { personDbName, ... } ..."`), then hardcoded.
 *
 * These are load-bearing: existing ArangoDB databases were created under exactly
 * these names. If the derivation changes (different hash, shorter digest slice,
 * changed prefix), every existing graph database silently orphans AND — far worse —
 * a weaker derivation (short digest → collisions, or prefix loss → person/tenant
 * overlap) can hand one caller another caller's graph. Any intentional migration
 * must edit these literals deliberately and ship a data migration alongside.
 */
const GOLDEN = {
  person: {
    'auth0|alice-123': 'g_p_fe7db07ccc6b05c6fdde4362',
    'auth0|bob-456': 'g_p_4be27dd95f3728782260addb',
    'shared-id': 'g_p_bfd7313542364285aa15157d',
  } as Record<string, string>,
  tenant: {
    'shared-id': 'g_t_bfd7313542364285aa15157d',
    '11111111-2222-3333-4444-555555555555': 'g_t_666ff6ccaa5b3c07feaa3a95',
    'acme-corp': 'g_t_f13fa37ca5aed07e133e4d7b',
  } as Record<string, string>,
  nodeKey: {
    // Safe ids pass through verbatim (required: pre-existing _keys must keep resolving).
    'svc:api@prod-1': 'svc:api@prod-1',
    // Illegal ids hash to k_<40-hex>.
    'a/b': 'k_c14cddc033f64b9dea80ea675cf280a015e67251',
    'hello world': 'k_b94d27b9934d3e08a52e52d7da7dabfac484efe3',
  } as Record<string, string>,
  // Over-long (201 chars of 'x') falls out of the safe-passthrough class and is hashed.
  longNodeKey: 'k_84a0678c90937f5dcf9994d5866668da6b995109',
};

describe('graph-keys isolation boundary (ADR-045)', () => {
  describe('golden derivation values', () => {
    it('personDbName matches the pinned goldens (prefix + 24-hex digest)', () => {
      for (const [sub, expected] of Object.entries(GOLDEN.person)) {
        expect(personDbName(sub)).toBe(expected);
        // Shape pin: shortening the digest slice (collision risk) must fail loudly.
        expect(personDbName(sub)).toMatch(/^g_p_[0-9a-f]{24}$/);
      }
    });

    it('tenantDbName matches the pinned goldens (prefix + 24-hex digest)', () => {
      for (const [tenant, expected] of Object.entries(GOLDEN.tenant)) {
        expect(tenantDbName(tenant)).toBe(expected);
        expect(tenantDbName(tenant)).toMatch(/^g_t_[0-9a-f]{24}$/);
      }
    });

    it('nodeKey matches the pinned goldens (pass-through and hashed forms)', () => {
      for (const [id, expected] of Object.entries(GOLDEN.nodeKey)) {
        expect(nodeKey(id)).toBe(expected);
      }
      expect(nodeKey('x'.repeat(201))).toBe(GOLDEN.longNodeKey);
    });
  });

  describe('distinctness (the actual isolation property)', () => {
    it('different subs never share a person database name', () => {
      const subs = ['auth0|alice-123', 'auth0|bob-456', 'auth0|alice-124', 'a', 'b', ''];
      const names = subs.map(personDbName);
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          expect(names[i]).not.toBe(names[j]);
        }
      }
    });

    it('person and tenant databases never collide, even for the IDENTICAL input string', () => {
      // The digest of 'shared-id' is byte-identical on both sides — ONLY the
      // g_p_/g_t_ prefix separates a person graph from a tenant graph. Dropping or
      // unifying the prefixes would merge the two tiers; this is the pin against that.
      for (const input of ['shared-id', 'auth0|alice-123', 'acme-corp', '']) {
        const p = personDbName(input);
        const t = tenantDbName(input);
        expect(p).not.toBe(t);
        expect(p.startsWith('g_p_')).toBe(true);
        expect(t.startsWith('g_t_')).toBe(true);
        // Same digest body is EXPECTED (same hash fn) — the prefix is the boundary.
        expect(p.slice(4)).toBe(t.slice(4));
      }
    });
  });

  describe('determinism', () => {
    it('repeated calls return the identical name (lookups depend on it)', () => {
      for (let i = 0; i < 5; i += 1) {
        expect(personDbName('auth0|alice-123')).toBe(GOLDEN.person['auth0|alice-123']);
        expect(tenantDbName('acme-corp')).toBe(GOLDEN.tenant['acme-corp']);
        expect(nodeKey('a/b')).toBe(GOLDEN.nodeKey['a/b']);
      }
    });
  });

  describe('derivation only from the argument (no ambient inputs)', () => {
    const ENV_KEYS = ['ARANGO_URL', 'SESSION_SECRET', 'GRAPH_DB_PREFIX', 'NODE_ENV'];
    let saved: Record<string, string | undefined>;

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('outputs are unchanged when plausible env vars are set, changed, or unset', () => {
      saved = {};
      for (const key of ENV_KEYS) saved[key] = process.env[key];

      const baseline = {
        p: personDbName('auth0|alice-123'),
        t: tenantDbName('acme-corp'),
        k: nodeKey('a/b'),
      };
      // A name derived from ARANGO_URL / a secret / a prefix env would mean two
      // deployments (or one deployment across a config change) resolve DIFFERENT
      // databases for the same person — or worse, the SAME database for different
      // people. Derivation must depend on the argument alone.
      process.env.ARANGO_URL = 'http://graph.example.internal:8529';
      process.env.SESSION_SECRET = 'a-completely-different-secret';
      process.env.GRAPH_DB_PREFIX = 'evil_';
      process.env.NODE_ENV = 'production';
      expect(personDbName('auth0|alice-123')).toBe(baseline.p);
      expect(tenantDbName('acme-corp')).toBe(baseline.t);
      expect(nodeKey('a/b')).toBe(baseline.k);

      for (const key of ENV_KEYS) delete process.env[key];
      expect(personDbName('auth0|alice-123')).toBe(baseline.p);
      expect(tenantDbName('acme-corp')).toBe(baseline.t);
      expect(nodeKey('a/b')).toBe(baseline.k);
    });
  });

  describe('nodeKey sanitization', () => {
    it('safe ids pass through verbatim; the 200-char boundary is pinned', () => {
      const safe = 'AZaz09_-.:@';
      expect(nodeKey(safe)).toBe(safe);
      const twoHundred = 'x'.repeat(200);
      expect(nodeKey(twoHundred)).toBe(twoHundred); // exactly at the limit: pass-through
      expect(nodeKey('x'.repeat(201))).toBe(GOLDEN.longNodeKey); // one past: hashed
    });

    it('illegal ids are hashed to an ArangoDB-legal k_<40-hex> key, never emitted raw', () => {
      for (const bad of ['a/b', 'hello world', 'emoji☃id', 'slash\\back', '"quoted"', '']) {
        const key = nodeKey(bad);
        expect(key).toMatch(/^k_[0-9a-f]{40}$/);
        expect(key).not.toBe(bad);
      }
    });

    it('near-miss inputs do not collide (sanitization must not fold distinct ids together)', () => {
      // 'a_b' is safe (passes through as itself); 'a/b' is illegal (hashed). A naive
      // "replace illegal chars with _" sanitizer would collide them — the hash design
      // exists precisely to prevent that. Pin the non-collision.
      expect(nodeKey('a/b')).not.toBe(nodeKey('a_b'));
      expect(nodeKey('a_b')).toBe('a_b');
      // All-illegal near-misses stay pairwise distinct too (full-input hashing).
      const hashedVariants = ['a/b', 'a b', 'a\\b', 'a//b', '/ab', 'ab/'].map(nodeKey);
      for (let i = 0; i < hashedVariants.length; i += 1) {
        for (let j = i + 1; j < hashedVariants.length; j += 1) {
          expect(hashedVariants[i]).not.toBe(hashedVariants[j]);
        }
      }
    });

    it('is deterministic for hashed ids (edges and neighbor lookups re-derive keys)', () => {
      expect(nodeKey('a/b')).toBe(nodeKey('a/b'));
      expect(nodeKey('hello world')).toBe(nodeKey('hello world'));
    });
  });
});
