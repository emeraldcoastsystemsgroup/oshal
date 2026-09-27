/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Test Lab registration guard for the shared-response-renderer card: it is in SCENARIOS, every suite it names exists on disk, and its steps — driven over real HTTP against express.static exactly as server.ts mounts /dist, serving the REAL renderer bundle and the REAL vendored Mermaid runtime from vite.config.ts's vendorMermaidRuntime — pass on a built server, report a deployment gap (not a pass) for a server without them or with a pre-profile bundle, and fail on a live image in the rendered hostile reply.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import {
  RESPONSE_RENDERER_SCENARIOS,
  bundleStep,
  classifyInertRender,
  inertRenderStep,
  mermaidStep,
} from '@/app/routes/test-lab-response-renderer-scenarios';
import { bundleResponseRenderer } from '../fixtures/shared-response-fixture';
import { vendorMermaidRuntime } from '../../vite.config';

const ROOT = path.resolve(__dirname, '../..');
const dirs: string[] = [];
const servers: Server[] = [];

/** Serve one directory at /dist the way server.ts does (express.static) and return its port. */
async function serveDist(dir: string): Promise<string> {
  const app = express();
  app.use('/dist', express.static(dir));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((ready) => server.once('listening', ready));
  servers.push(server);
  return String((server.address() as AddressInfo).port);
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'oshal-lab-rr-'));
  dirs.push(dir);
  return dir;
}

let builtPort = '';
let emptyPort = '';
let stalePort = '';

beforeAll(async () => {
  const built = tempDir();
  writeFileSync(path.join(built, 'response-renderer.js'), await bundleResponseRenderer());
  vendorMermaidRuntime(built);
  builtPort = await serveDist(built);

  emptyPort = await serveDist(tempDir());

  const stale = tempDir();
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, 'response-renderer.js'), 'export async function renderResponseHtml() { return { html: "", rich: false }; }');
  stalePort = await serveDist(stale);
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('shared-response-renderer Test Lab card', () => {
  it('is registered with every regression suite present on disk', () => {
    const card = SCENARIOS.find((scenario) => scenario.id === 'shared-response-renderer');
    expect(card).toBe(RESPONSE_RENDERER_SCENARIOS[0]);
    expect(card?.steps.map((step) => step.id)).toEqual(['bundle', 'mermaid', 'inert']);
    const missing = (card?.regressionTests ?? []).filter((suite) => !existsSync(path.join(ROOT, suite.path)));
    expect(missing).toEqual([]);
    expect(new Set(card?.regressionTests?.map((suite) => suite.level))).toEqual(new Set(['unit', 'integration', 'browser']));
  });

  it('passes on a server that publishes the profiled bundle and the vendored runtime', async () => {
    process.env.PORT = builtPort;
    expect(await bundleStep()).toMatchObject({ state: 'pass', status: 200 });
    const mermaid = await mermaidStep();
    expect(mermaid).toMatchObject({ state: 'pass', status: 200 });
    expect(mermaid.detail).toMatch(/Mermaid \d+\.\d+\.\d+ is served same-origin/);
  });

  it('reports a deployment gap, never a pass, when the bundle or runtime is missing or pre-profile', async () => {
    process.env.PORT = emptyPort;
    expect(await bundleStep()).toMatchObject({ state: 'gap', status: 404 });
    expect(await mermaidStep()).toMatchObject({ state: 'gap', status: 404 });
    process.env.PORT = stalePort;
    expect(await bundleStep()).toMatchObject({ state: 'gap', status: 200 });
  });

  it('renders the hostile reply inert in-process, and fails on a live image or lost fallback', async () => {
    expect(await inertRenderStep()).toMatchObject({ state: 'pass' });
    expect(classifyInertRender('<figure class="rr-block rr-gallery"><img src="https://attacker.example/x.png"></figure>').state).toBe('fail');
    expect(classifyInertRender('<div class="rr-block rr-markdown">only prose</div>').state).toBe('fail');
  });
});
