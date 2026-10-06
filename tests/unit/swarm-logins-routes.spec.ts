/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (D2, step B5-4): GET /api/admin/swarm-logins answers an operator with the four vendor logins' presence and expiry and nothing that identifies an account (no email, no token, no file path), refuses a user, says per login whether this caller may adopt a pushed login exactly as that vendor's import route decides it (Claude Code, Gemini, Antigravity: DEMO_MODE on and the exact subject on OSHAL_OPERATOR_SUBS, never an email; Codex: any operator), reports Gemini's expired state, names exactly the vendors' own rails (each really mounted and each route present), wires the real deployment-mode rule in its production readers, and the page sends the vendors' own import body shapes and reads the real start reply, and is mounted behind requiresAuth + requiresOperator. Each fails on the tree before the fix.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSwarmLoginsRoutes, defaultSwarmLoginsDeps, readSwarmLogins, swarmLoginAdoptionReason, type SwarmLoginsDeps } from '@/app/routes/swarm-logins-routes';
import { requiresOperator } from '@/shared/middleware/authz';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

const OPERATOR = { sub: 'idp-operator', email: 'operator@example.test', iss: 'https://login.example.test/tenant' };
const USER = { sub: 'idp-user', email: 'user@example.test', iss: 'https://login.example.test/tenant' };
const IN_AN_HOUR = Date.now() + 3_600_000;

/** Readers that stand in for the vendors' files; the operator subject rule is the real one by default. */
function deps(overrides: Partial<SwarmLoginsDeps> = {}): SwarmLoginsDeps {
  return {
    claude: () => ({ present: true, expiresAt: IN_AN_HOUR, expired: false }),
    codex: () => ({ present: true, expiresAt: Date.now() - 1, expired: true }),
    gemini: () => ({ connected: false, method: 'none', reason: 'no-credentials' }),
    antigravity: () => true,
    demo: () => true,
    isOperatorSubject: (sub) => sub === OPERATOR.sub,
    ...overrides,
  };
}

const signIn: RequestHandler = (req, _res, next) => {
  const raw = req.headers['x-fixture-user'];
  if (typeof raw === 'string' && raw) Object.assign(req, { oidc: { isAuthenticated: () => true, user: JSON.parse(raw) } });
  next();
};
const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.status(401).json({ error: 'unauthorized' });
};

async function serve(d: SwarmLoginsDeps) {
  const app = express();
  app.use(signIn);
  app.use('/api/admin/swarm-logins', requiresAuth, requiresOperator, createSwarmLoginsRoutes(d));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (user: Record<string, string> | null) => fetch(`${base}/api/admin/swarm-logins`, { headers: user ? { 'x-fixture-user': JSON.stringify(user) } : {} }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeEach(() => { delete process.env.OSHAL_OPERATOR_SUBS; delete process.env.OSHAL_OPERATOR_EMAILS; setPrivilegedIdentities([{ sub: OPERATOR.sub, email: OPERATOR.email, role: 'admin' }]); });
afterEach(() => clearPrivilegedIdentities());

describe('readSwarmLogins', () => {
  it('reports presence and expiry for the four logins and nothing that identifies an account', () => {
    const logins = readSwarmLogins(deps(), OPERATOR.sub);
    expect(logins.map((l) => [l.id, l.connected, l.expired])).toEqual([
      ['claude-code', true, false], ['openai-codex', false, true], ['gemini', false, false], ['antigravity', true, false],
    ]);
    expect(logins[0].expiresAt).toBe(new Date(IN_AN_HOUR).toISOString());
    expect(logins[2].detail).toBe('none: no-credentials');
    // Gemini's own expired state is reported, so a dead file can be cleared from the screen.
    expect(readSwarmLogins(deps({ gemini: () => ({ connected: false, method: 'oauth', reason: 'expired', expiresAt: '2026-01-01T00:00:00.000Z' }) }), OPERATOR.sub)[2]).toMatchObject({ connected: false, expired: true });
    const text = JSON.stringify(logins);
    for (const forbidden of ['email', 'token', 'refresh', 'access_', '/home/', '.json"']) expect(text, forbidden).not.toContain(forbidden);
  });
});

describe('adoption', () => {
  it('follows each import route: demo mode and the exact operator subject for Claude Code, Gemini and Antigravity; any operator for Codex', () => {
    expect(swarmLoginAdoptionReason(deps(), OPERATOR.sub)).toBe('ok');
    expect(swarmLoginAdoptionReason(deps({ demo: () => false }), OPERATOR.sub)).toBe('not-demo');
    expect(swarmLoginAdoptionReason(deps(), USER.sub)).toBe('not-operator-subject');
    expect(swarmLoginAdoptionReason(deps(), null)).toBe('not-operator-subject');
    const refused = readSwarmLogins(deps({ demo: () => false }), OPERATOR.sub);
    expect(refused.map((l) => [l.id, l.adoption.allowed, l.adoption.reason])).toEqual([
      ['claude-code', false, 'not-demo'], ['openai-codex', true, 'ok'], ['gemini', false, 'not-demo'], ['antigravity', false, 'not-demo'],
    ]);
  });

  it('the production readers wire the real deployment-mode rule and really read the files', () => {
    const saved = { demo: process.env.DEMO_MODE, subs: process.env.OSHAL_OPERATOR_SUBS };
    try {
      process.env.DEMO_MODE = 'true';
      process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
      const real = defaultSwarmLoginsDeps();
      expect(real.demo()).toBe(true);
      expect(real.isOperatorSubject(OPERATOR.sub)).toBe(true);
      expect(real.isOperatorSubject(OPERATOR.email)).toBe(false);
      process.env.DEMO_MODE = 'false';
      expect(real.demo()).toBe(false);
      for (const login of readSwarmLogins(real, OPERATOR.sub)) expect(typeof login.connected, login.id).toBe('boolean');
    } finally {
      if (saved.demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved.demo;
      if (saved.subs === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = saved.subs;
    }
  });
});

describe('GET /api/admin/swarm-logins', () => {
  it('refuses a user, and answers an operator with the logins and their adoption standing', async () => {
    const app = await serve(deps());
    try {
      expect((await app.get(USER)).status).toBe(403);
      expect((await app.get(null)).status).toBe(401);
      const res = await app.get(OPERATOR);
      expect(res.status).toBe(200);
      const body = await res.json() as { logins: Array<{ id: string; rails: Record<string, string>; adoption: { allowed: boolean; reason: string } }> };
      expect(body.logins.map((l) => l.id)).toEqual(['claude-code', 'openai-codex', 'gemini', 'antigravity']);
      expect(body.logins.every((l) => l.adoption.allowed && l.adoption.reason === 'ok')).toBe(true);
      // The rails are exactly the vendors' own routes, which are really mounted under these prefixes.
      expect(Object.fromEntries(body.logins.map((l) => [l.id, l.rails]))).toEqual({
        'claude-code': { status: '/api/claude-code/auth/status', start: '/api/claude-code/auth/start', submitCode: '/api/claude-code/auth/submit-code', import: '/api/claude-code/auth/import', signout: '/api/claude-code/auth/signout' },
        'openai-codex': { status: '/api/openai-codex/oauth/status', import: '/api/openai-codex/oauth/import', signout: '/api/openai-codex/oauth/signout' },
        gemini: { status: '/api/gemini/auth/status', import: '/api/gemini/auth/import', signout: '/api/gemini/auth/signout' },
        antigravity: { status: '/api/antigravity/auth/status', import: '/api/antigravity/auth/import', signout: '/api/antigravity/auth/signout' },
      });
      const mounts = fs.readFileSync(path.resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
      for (const prefix of ['/api/claude-code/auth', '/api/openai-codex/oauth', '/api/gemini/auth', '/api/antigravity/auth']) expect(mounts).toContain(`app.use('${prefix}'`);
      for (const [file, route] of [['claude-code-auth-routes.ts', "'/import'"], ['claude-code-auth-routes.ts', "'/submit-code'"], ['claude-code-auth-routes.ts', "'/start'"], ['gemini-auth-routes.ts', "'/import'"], ['antigravity-auth-routes.ts', "'/import'"], ['openai-codex-oauth-routes.ts', "'/import'"]]) {
        expect(fs.readFileSync(path.resolve(process.cwd(), 'src/app/routes', file), 'utf8'), `${file} ${route}`).toContain(route);
      }
      expect(JSON.stringify(body)).not.toMatch(/email|token/);
    } finally { await app.close(); }
  });

  it('tells an operator who is not the configured subject that pushed adoption is not theirs, except for Codex', async () => {
    const app = await serve(deps({ isOperatorSubject: () => false }));
    try {
      const body = await (await app.get(OPERATOR)).json() as { logins: Array<{ id: string; adoption: { allowed: boolean; reason: string } }> };
      expect(body.logins.find((l) => l.id === 'gemini')?.adoption).toEqual({ allowed: false, reason: 'not-operator-subject' });
      expect(body.logins.find((l) => l.id === 'openai-codex')?.adoption).toEqual({ allowed: true, reason: 'ok' });
    } finally { await app.close(); }
  });

  it('is mounted in server-auxiliary-routes behind requiresAuth and requiresOperator, and the page fetches it', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
    expect(source).toContain("app.use('/api/admin/swarm-logins', requiresAuth, requiresOperator, createSwarmLoginsRoutes());");
    const script = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/swarm-admin/logins/logins.js'), 'utf8');
    expect(script).toContain("requestJson('/api/admin/swarm-logins')");
    // The import bodies are the vendors' own shapes, the start reply's field is the real one, and the sign-in
    // handles an already-signed-in reply.
    expect(script).toContain("{ authJson: text } : { credentials: text }");
    expect(script).toContain('started.authUrl');
    expect(script).toContain('started.alreadyAuthenticated');
    expect(script).not.toContain('pendingAuthUrl');
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/swarm-admin/logins/logins.css'), 'utf8');
    expect(css).toMatch(/\.sl-import\[hidden\][\s\S]*display: none/);
  });
});
