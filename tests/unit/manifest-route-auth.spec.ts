/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D2: lock the route auth contract. Auth is OPT-IN per route in this codebase, so a package route is publicly callable unless something wraps it — every test here exists to keep a manifest from becoming anonymous by omission, typo, or a sibling's declaration order. Includes the standing guard that a manifest's declared `auth:` matches what server.ts ACTUALLY mounts: eight manifests were misdeclaring theirs (saying requiresAuth: true against serviceSecretOr mounts), harmless only because route blocks are informational until an app carves — at which point it becomes a 401 storm for every bot node and the headless CLI.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Sanity floor 10->3: ADR-085 Wave 3 carved most route-declaring manifests to the store (8 kernel declarations remain; Wave G leaves 5). The floor is anti-empty-scan only; the auth-truth guards below are unchanged.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';
import { readManifest } from '../../src/features/swarm-apps';
import {
  DEFAULT_ROUTE_AUTH_MODE,
  isRouteAuthMode,
  resolveRouteAuthMode,
  routeAuthContradicts,
} from '../../src/shared/route-auth';

/**
 * @description Write a manifest and read it through the real readManifest.
 * @param body - YAML appended to the required name/displayName.
 * @returns The parsed manifest.
 */
function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-routeauth-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const route = (mountPath: string, extra = '') =>
  `routes:\n  - module: routes/x.js\n    factory: createX\n    mountPath: ${mountPath}\n${extra}`;

describe('route auth mode resolution', () => {
  it('defaults to oidc when nothing is declared — safe by omission', () => {
    expect(resolveRouteAuthMode({})).toBe('oidc');
    expect(DEFAULT_ROUTE_AUTH_MODE).toBe('oidc');
  });

  it('honours each declared mode', () => {
    for (const m of ['oidc', 'service-or-oidc', 'service', 'operator', 'public'] as const) {
      expect(resolveRouteAuthMode({ auth: m })).toBe(m);
    }
  });

  // Defence in depth: readManifest throws on an unknown mode, so reaching the resolver with one
  // means the manifest arrived another way. The answer to "I don't understand this" is to demand a
  // login — never to open the door.
  it('resolves an UNKNOWN mode to oidc, never public', () => {
    expect(resolveRouteAuthMode({ auth: 'service-or-odic' })).toBe('oidc');
    expect(resolveRouteAuthMode({ auth: 'nonsense' })).toBe('oidc');
  });

  it('maps the legacy requiresAuth: false to public', () => {
    expect(resolveRouteAuthMode({ requiresAuth: false })).toBe('public');
    expect(resolveRouteAuthMode({ requiresAuth: true })).toBe('oidc');
  });

  it('detects a contradiction between auth and the legacy boolean', () => {
    expect(routeAuthContradicts({ auth: 'oidc', requiresAuth: false })).toBe(true);
    expect(routeAuthContradicts({ auth: 'public', requiresAuth: true })).toBe(true);
    expect(routeAuthContradicts({ auth: 'public', requiresAuth: false })).toBe(false);
    expect(routeAuthContradicts({ auth: 'service', requiresAuth: true })).toBe(false);
  });

  it('narrows only real modes', () => {
    expect(isRouteAuthMode('service')).toBe(true);
    expect(isRouteAuthMode('service-or-odic')).toBe(false);
  });
});

describe('readManifest — routes[] fail closed (ADR-085 D2)', () => {
  it('accepts each declared mode', () => {
    for (const m of ['oidc', 'service-or-oidc', 'service', 'operator'] as const) {
      expect(read(route('/api/x', `    auth: ${m}\n`)).routes?.[0].auth).toBe(m);
    }
  });

  it('REJECTS an unknown mode (a typo must never resolve silently)', () => {
    expect(() => read(route('/api/x', '    auth: service-or-odic\n'))).toThrow(/not a known mode/);
  });

  it('REJECTS auth and requiresAuth contradicting each other', () => {
    expect(() => read(route('/api/x', '    auth: oidc\n    requiresAuth: false\n'))).toThrow(/contradict/);
    expect(() => read(route('/api/x/y', '    auth: public\n    requiresAuth: true\n'))).toThrow(/contradict/);
  });

  it('REJECTS a malformed declaration', () => {
    expect(() => read('routes:\n  - factory: createX\n    mountPath: /api/x\n')).toThrow(/non-empty module/);
    expect(() => read('routes:\n  - module: r.js\n    factory: createX\n    mountPath: api/x\n')).toThrow(/must start with/);
    expect(() => read('routes: notanarray\n')).toThrow(/must be an array/);
  });

  // The package dispatcher runs BEFORE core's own /api mounts, so a short anonymous mountPath could
  // shadow them with no auth and a null-sub RLS context.
  it('REJECTS an auth: public route on too broad a mountPath', () => {
    expect(() => read(route('/api', '    auth: public\n'))).toThrow(/too broad/);
    expect(() => read(route('/api/world', '    auth: public\n')).routes?.[0].auth).toBeTruthy();
  });

  // The /api/lora shape: a service-secret ingest callback and an OIDC studio on ONE mountPath. The
  // mounter runs each entry's guards as it walks the chain, so mixed modes mean a stricter sibling
  // rejects requests meant for a laxer one purely by declaration order.
  it('REJECTS two modules on one mountPath declaring different modes', () => {
    const mixed =
      'routes:\n' +
      '  - module: routes/ingest.js\n    factory: createIngest\n    mountPath: /api/lora\n    auth: service\n' +
      '  - module: routes/studio.js\n    factory: createStudio\n    mountPath: /api/lora\n    auth: oidc\n';
    expect(() => read(mixed)).toThrow(/conflicting auth modes/);
  });

  it('ALLOWS several modules on one mountPath when they agree (the little-monsters shape)', () => {
    const same =
      'routes:\n' +
      '  - module: routes/a.js\n    factory: createA\n    mountPath: /api/education\n    auth: oidc\n' +
      '  - module: routes/b.js\n    factory: createB\n    mountPath: /api/education\n    auth: oidc\n';
    expect(read(same).routes).toHaveLength(2);
  });

  it('accepts a manifest with no routes at all', () => {
    expect(read('description: x\n').routes).toBeUndefined();
  });
});

// ── The standing guard ───────────────────────────────────────────────────────
// Eight manifests declared `requiresAuth: true` against routes that server.ts really mounts with
// serviceSecretOr — nobody noticed, because a manifest's route block is informational until the app
// carves. At the carve it becomes a 401 storm. This test makes the lie a CI failure BEFORE the carve.

/** @description Classify a server.ts `app.use(...)` line into an auth mode. @param line - Source line. @returns The mode. */
function classifyMount(line: string, mountPath: string): string {
  const after = line.slice(line.indexOf(`'${mountPath}'`) + mountPath.length + 2);
  if (after.includes('serviceSecretOr')) return 'service-or-oidc';
  if (after.includes('requiresOperator')) return 'operator';
  if (after.includes('requiresAuth')) return 'oidc';
  return 'self-guarded'; // no auth middleware at the mount — public or secret-guarded inside
}

describe('manifests tell the truth about their auth (the standing guard)', () => {
  const serverLines = readFileSync('src/app/server.ts', 'utf8').split('\n');
  const dirs = ['swarm-apps', 'swarm-apps-build'];

  const declarations = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) => {
        const m = yaml.load(readFileSync(join(dir, f), 'utf8')) as {
          routes?: Array<{ mountPath: string; auth?: string; requiresAuth?: boolean; module: string }>;
        };
        return (m.routes ?? []).map((r) => ({ file: `${dir}/${f}`, ...r }));
      }),
  );

  it('finds route declarations to check', () => {
    // Anti-empty-scan floor only — the real guards below run over whatever is found.
    // ADR-085 Wave 3 carved most route-declaring manifests to the app store (kernel now
    // declares 10; Wave G — kalshi/trading/world — takes it to 5). Floor sits below the
    // post-Wave-G count so the carve chain can't red-flag this guard again, while a
    // broken/empty scan (0 declarations) still fails loudly.
    expect(declarations.length).toBeGreaterThan(3);
  });

  it('every route declaration carries an EXPLICIT auth: (no relying on the default)', () => {
    const missing = declarations.filter((d) => !d.auth).map((d) => `${d.file} ${d.mountPath}`);
    expect(missing).toEqual([]);
  });

  it('every declared mode MATCHES what server.ts actually mounts', () => {
    const mismatches: string[] = [];

    for (const d of declarations) {
      const mounts = serverLines.filter((l) => l.includes(`app.use('${d.mountPath}'`));
      if (!mounts.length) continue; // carved / dynamically mounted — nothing in server.ts to compare

      const actual = [...new Set(mounts.map((l) => classifyMount(l, d.mountPath)))];
      // A self-guarded mount is declared `public` (genuinely anonymous) or `service` (secret
      // required inside the router) — both are legitimate readings of "no middleware at the mount".
      const ok = actual.every((a) =>
        a === 'self-guarded' ? d.auth === 'public' || d.auth === 'service' : a === d.auth,
      );
      if (!ok) {
        mismatches.push(`${d.file} ${d.mountPath}: declares ${d.auth}, server.ts mounts ${actual.join('+')}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
