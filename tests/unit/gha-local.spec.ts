/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | gha-local tests: expression evaluator (contexts, ==/&&/||/!, fallbacks, status fns, hashFiles), workflow parser (matrix product+include/exclude, needs topo, services), action mapping (never-push, unknown surfaced), planner (env merge, runtime-context deferral), and an ACCEPTANCE pass over the repo's real ci.yml.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evalExpr, interpolate, RUNTIME_CONTEXTS, type ExprWarnings } from '../../scripts/lib/gha/expr';
import { parseWorkflow, expandMatrix, orderJobs, type GhaJob } from '../../scripts/lib/gha/parse';
import { mapAction } from '../../scripts/lib/gha/actions-map';
import { buildPlan } from '../../scripts/lib/gha/plan';

const W = (): ExprWarnings => ({ warnings: [] });

describe('expression evaluator', () => {
  const ctx = {
    env: { NODE_VERSION: '20', REGISTRY: 'ghcr.io' },
    github: { ref: 'refs/heads/main', event_name: 'push', sha: 'abc123' },
    secrets: { TOKEN: 's3cr3t' },
    matrix: { node: 20 },
  };

  it('resolves dotted context lookups', () => {
    expect(evalExpr('env.NODE_VERSION', ctx, W())).toBe('20');
    expect(evalExpr('github.ref', ctx, W())).toBe('refs/heads/main');
    expect(evalExpr('matrix.node', ctx, W())).toBe(20);
  });

  it('evaluates == / != / && / || / ! with GHA truthiness', () => {
    expect(evalExpr("github.ref == 'refs/heads/main'", ctx, W())).toBe(true);
    expect(evalExpr("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'", ctx, W())).toBe(true);
    expect(evalExpr("!(github.event_name == 'push')", ctx, W())).toBe(false);
  });

  it('supports the || fallback idiom (secrets.X || literal)', () => {
    expect(evalExpr("secrets.MISSING || 'ghcr.io'", ctx, W())).toBe('ghcr.io');
    expect(evalExpr("secrets.TOKEN || 'fallback'", ctx, W())).toBe('s3cr3t');
  });

  it('status functions follow jobStatus; always() is unconditional', () => {
    expect(evalExpr('success()', { jobStatus: 'success' }, W())).toBe(true);
    expect(evalExpr('failure()', { jobStatus: 'success' }, W())).toBe(false);
    expect(evalExpr('failure()', { jobStatus: 'failure' }, W())).toBe(true);
    expect(evalExpr('always()', { jobStatus: 'failure' }, W())).toBe(true);
  });

  it('hashFiles hashes a literal file deterministically and warns on globs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-t-'));
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"a":1}');
    const a = evalExpr("hashFiles('lock.json')", { workspace: dir }, W());
    const b = evalExpr("hashFiles('lock.json')", { workspace: dir }, W());
    expect(a).toBe(b);
    expect(String(a)).toMatch(/^[0-9a-f]{64}$/);
    const w = W();
    evalExpr("hashFiles('**/*.json')", { workspace: dir }, w);
    expect(w.warnings.some((x) => x.includes('glob'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unknown contexts warn instead of silently failing', () => {
    const w = W();
    evalExpr('bogus.thing', ctx, w);
    expect(w.warnings.some((x) => x.includes('unknown context'))).toBe(true);
  });

  it('interpolate replaces expressions and defers runtime contexts when asked', () => {
    expect(interpolate('img:${{ env.NODE_VERSION }}', ctx, W())).toBe('img:20');
    const deferred = interpolate('tag=${{ steps.meta.outputs.tags }} n=${{ env.NODE_VERSION }}', ctx, W(), RUNTIME_CONTEXTS);
    expect(deferred).toBe('tag=${{ steps.meta.outputs.tags }} n=20');
  });
});

describe('workflow parser', () => {
  it('expands a matrix product with exclude and include', () => {
    const combos = expandMatrix({ node: [18, 20], os: ['linux', 'win'], exclude: [{ node: 18, os: 'win' }], include: [{ node: 22, os: 'linux' }] });
    expect(combos).toHaveLength(4); // 2x2 - 1 excluded + 1 included
    expect(combos.some((c) => c.node === 22)).toBe(true);
    expect(combos.some((c) => String(c.node) === '18' && c.os === 'win')).toBe(false);
  });

  it('orders jobs topologically by needs and throws on a cycle', () => {
    const j = (id: string, needs: string[]): GhaJob => ({ id, baseId: id, name: id, runsOn: 'x', needs, env: {}, services: [], steps: [], outputs: {} });
    const ordered = orderJobs([j('c', ['b']), j('a', []), j('b', ['a'])]).map((x) => x.id);
    expect(ordered).toEqual(['a', 'b', 'c']);
    expect(() => orderJobs([j('a', ['b']), j('b', ['a'])])).toThrow(/cycle/);
  });

  it('parses a minimal workflow with services and step shapes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-t-'));
    const f = path.join(dir, 'wf.yml');
    fs.writeFileSync(f, [
      'name: t', 'on: [push]', 'env: { G: "1" }',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    services:',
      '      pg: { image: "postgres:16", ports: ["5432:5432"], env: { POSTGRES_DB: x }, options: "--health-cmd pg_isready" }',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: hi',
      '        run: echo hi',
      '        continue-on-error: true',
    ].join('\n'));
    const wf = parseWorkflow(f);
    expect(wf.triggers).toEqual(['push']);
    expect(wf.jobs[0].services[0]).toMatchObject({ name: 'pg', image: 'postgres:16' });
    expect(wf.jobs[0].steps[1]).toMatchObject({ run: 'echo hi', continueOnError: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('action mapping (local semantics)', () => {
  it('checkout/cache are noops; login is a deliberate skip', () => {
    expect(mapAction('actions/checkout@v4', {}).kind).toBe('noop');
    expect(mapAction('actions/cache@v4', {}).kind).toBe('noop');
    expect(mapAction('docker/login-action@v3', {}).kind).toBe('skip');
  });

  it('build-push NEVER pushes locally, even when the workflow wanted push', () => {
    const m = mapAction('docker/build-push-action@v5', { push: 'true', file: 'Dockerfile.oshal', tags: 'x:1' });
    expect(m.kind).toBe('shell');
    expect(m.cmd).toContain('docker build');
    expect(m.cmd).not.toContain('push');
    expect(m.note).toContain('never pushed');
  });

  it('metadata-action synthesizes local tags as step outputs', () => {
    const m = mapAction('docker/metadata-action@v5', { images: 'ghcr.io/x/y' }, 'deadbeefcafe');
    expect(m.kind).toBe('outputs');
    expect(m.outputs!.tags).toBe('ghcr.io/x/y:local-deadbeefcafe');
  });

  it('unknown actions are surfaced, never silently dropped', () => {
    expect(mapAction('some/exotic-action@v1', {}).kind).toBe('unknown');
  });
});

describe('planner + ACCEPTANCE against the real ci.yml', () => {
  const CI = path.resolve(__dirname, '../../.github/workflows/ci.yml');

  it('plans the repo ci.yml: every job present, no unknown-action steps', () => {
    const plan = buildPlan(parseWorkflow(CI), { cwd: path.resolve(__dirname, '../..') });
    expect(plan.jobs.length).toBeGreaterThanOrEqual(5);
    const kinds = new Set(plan.jobs.flatMap((j) => j.steps.map((s) => s.kind)));
    expect(kinds.has('unknown')).toBe(false); // every action in the REAL pipeline maps locally
  });

  it('merges workflow env into step commands (NODE_VERSION interpolates)', () => {
    const plan = buildPlan(parseWorkflow(CI), { cwd: path.resolve(__dirname, '../..') });
    const all = plan.jobs.flatMap((j) => j.steps);
    expect(all.some((s) => s.env.NODE_VERSION === '20')).toBe(true);
  });

  it('carries the test job services (postgres + redis) into the plan', () => {
    const plan = buildPlan(parseWorkflow(CI), { cwd: path.resolve(__dirname, '../..') });
    const test = plan.jobs.find((j) => j.services.length > 0);
    expect(test).toBeDefined();
    expect(test!.services.map((s) => s.image).join(' ')).toMatch(/postgres/);
  });
});
