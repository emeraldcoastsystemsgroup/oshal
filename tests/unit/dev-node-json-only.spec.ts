/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the operator's "Jarvis doctype error entering development mode" (2026-07-24): the host dev-node answered unmatched paths with Express's HTML "<!DOCTYPE" 404 page and body-parser errors with an HTML 400 page carrying a full stack trace, and the api's /api/dev-console proxy forwarded both verbatim into the cockpit dev pane as `SyntaxError: Unexpected token '<'`. Goes red if the dev-node app ever answers non-JSON on any route (real HTTP round-trips against the REAL app), if the error path ever leaks a stack/host paths again, or if jsonOnlyBody (the proxy's wall) ever lets a non-JSON body through.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | repoRoot is now a git-init'd temp dir instead of the checkout root: DevSessionEngine requires `.git` at construction, and ci-local's --head mode runs from a git-archive export that has none — this spec failed EVERY nightly --head run since it landed (masked by the broken failure-alert email, fixed same day). A spec must not assume the checkout it runs from is a git repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createDevNodeApp,
  jsonOnlyBody,
  DevSessionEngine,
  DevSessionManager,
  DevSessionOrchestrator,
  SandboxedAgentRunner,
} from '../../src/features/dev-console';

const SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef';

describe('dev-node app — JSON-only on every path (never Express HTML "<!DOCTYPE")', () => {
  let server: Server;
  let base: string;
  let repoRoot: string;

  beforeAll(async () => {
    // A git-init'd temp dir, NOT the checkout root: DevSessionEngine requires `.git` at
    // construction, and ci-local --head runs this spec from a git-archive export with no .git —
    // the spec must carry its own repo rather than assume one.
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'oshal-devnode-spec-'));
    execSync('git init --quiet', { cwd: repoRoot });
    const manager = new DevSessionManager(
      new DevSessionEngine({ repoRoot }),
      new DevSessionOrchestrator(new DevSessionEngine({ repoRoot }), new SandboxedAgentRunner(), path.join(repoRoot, '..', 'oshal-dev-scratch-test')),
    );
    const app = createDevNodeApp({ secret: SECRET, manager });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  });

  it('GET /health answers JSON liveness', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ ok: true });
  });

  it('unmatched path → JSON 404, not the Express HTML "<!DOCTYPE" page', async () => {
    const r = await fetch(`${base}/definitely-not-a-route`);
    const text = await r.text();
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(text).not.toContain('<!DOCTYPE');
    expect(JSON.parse(text)).toEqual({ error: 'not found', path: '/definitely-not-a-route' });
  });

  it('malformed JSON body → JSON 400 envelope with NO stack trace / host paths', async () => {
    const r = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-node-secret': SECRET },
      body: '{bad json',
    });
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type')).toContain('application/json');
    // The pre-fix Express default error page was HTML AND leaked the full stack
    // (absolute host paths, node_modules internals) on a LAN-exposed port.
    expect(text).not.toContain('<!DOCTYPE');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('    at ');
    expect(typeof (JSON.parse(text) as { error?: unknown }).error).toBe('string');
  });

  it('missing/wrong shared secret → JSON 401', async () => {
    for (const headers of [{}, { 'x-dev-node-secret': 'wrong' }] as Array<Record<string, string>>) {
      const r = await fetch(`${base}/sessions`, { headers });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
  });
});

describe('jsonOnlyBody — the api proxy wall for /api/dev-console', () => {
  it('passes valid JSON through byte-for-byte', () => {
    const body = '{"sessionId":"abc","nested":{"ok":true}}';
    expect(jsonOnlyBody(202, body)).toBe(body);
  });

  it('converts an Express HTML "<!DOCTYPE" page to a readable JSON error envelope', () => {
    const html = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Error</title></head>\n<body><pre>Cannot POST /sessions</pre></body>\n</html>';
    const out = jsonOnlyBody(404, html);
    expect(out).not.toContain('<!DOCTYPE');
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toContain('non-JSON');
    expect(parsed.error).toContain('404');
  });

  it('converts an empty body to a JSON error envelope (a JSON-parsing client never sees "")', () => {
    const parsed = JSON.parse(jsonOnlyBody(502, '')) as { error: string };
    expect(parsed.error).toContain('502');
  });
});
