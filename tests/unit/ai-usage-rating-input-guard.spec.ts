/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real ledger CLI against owned temporary manifests and the authoritative loader validator: refuse invented measurements and invalid declarations before writing. No model/runtime measurement claim.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateAppRating } from '@/features/swarm-apps/services/swarm-app-rating';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ warn: vi.fn() }) }));
const script = resolve(__dirname, '../../scripts/ai-usage-ledger.js');
const owned = new Set<string>();
type Rating = { memoryMb: Record<string, unknown>; features: Array<Record<string, unknown>>; [key: string]: unknown };
const rating = (): Rating => ({ memoryMb: { low: 32, high: 128, basis: 'declared' },
  features: [{ id: 'rank-jobs', unit: 'one posting', tier: 'T1', generation: 'none', degrade: 'disable', contextFloor: 4096 }] });

/** Actual filesystem fixture; JSON is valid YAML, so the production parser still handles these bytes. */
function fixture(declaration: unknown = rating(), kind: 'core' | 'store' = 'core') {
  const root = mkdtempSync(join(tmpdir(), 'oshal-ai-rating-input-')); owned.add(root);
  const dir = join(root, kind === 'core' ? 'swarm-apps' : 'example-package'); mkdirSync(dir);
  const file = join(dir, kind === 'core' ? 'example.yaml' : 'oshal-app.yaml');
  const replace = (value: unknown) => writeFileSync(file, JSON.stringify({ name: 'example-package', displayName: 'Example', version: '1.0.0', rating: value }), 'utf8');
  replace(declaration);
  return { root, file, replace, args: ['--' + kind, root], out: join(root, 'ledger.md') };
}
/** Real one-at-a-time Node CLI child, bounded at 128 MiB and 10 seconds, no inherited provider configuration. */
function run(args: string[]) {
  const options = { encoding: 'utf8' as const, stdio: 'pipe' as const, timeout: 10_000,
    env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() } };
  try { return { code: 0, output: execFileSync(process.execPath, ['--max-old-space-size=128', script, ...args], options) }; }
  catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    if (result.status !== 1) throw error; // A spawn failure, timeout or signal is not a validation refusal.
    return { code: result.status, output: String(result.stdout ?? '') + String(result.stderr ?? '') };
  }
}
function loaderRejects(value: unknown) {
  const manifest = { name: 'example-package', rating: value } as unknown as SwarmAppManifest;
  expect(() => validateAppRating(manifest, 'fixture/oshal-app.yaml')).toThrow();
}
afterEach(() => {
  for (const root of owned) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('oshal-ai-rating-input-')) throw new Error('fixture cleanup path refused');
    rmSync(root, { recursive: true, force: true });
  }
  owned.clear();
});

describe('AI usage ledger declaration boundary / actual CLI and loader, logger only doubled', () => {
  it.each(['tokensPerUnit', 'tokensPerTransaction', 'callsPerTransaction', 'outputTokens', 'modelsVerified', 'minimumTier', 'costPerUnit', 'cadence'])
    ('refuses hand-authored generated feature field %s even with --allow-unrated', field => {
      const data = fixture(); expect(run([...data.args, '--out', data.out]).code).toBe(0);
      const bad = rating(); bad.features[0][field] = field === 'modelsVerified' ? ['unverified-model-sentinel'] : { p50: 42, p95: 88 };
      loaderRejects(bad); data.replace(bad);
      const result = run([...data.args, '--check', data.out, '--allow-unrated']);
      expect(result.code).toBe(1); expect(result.output).toContain('unknown field'); expect(result.output).toContain(field);
    });

  it.each(['core', 'store'] as const)('refuses top-level and memory unknown fields for %s discovery', kind => {
    const data = fixture(rating(), kind); expect(run([...data.args, '--out', data.out]).code).toBe(0);
    for (const bad of [{ ...rating(), modelsVerified: ['unverified-model-sentinel'] },
      { ...rating(), memoryMb: { ...rating().memoryMb, measuredTokens: 12 } }]) {
      loaderRejects(bad); data.replace(bad);
      expect(run([...data.args, '--check', data.out]).code).toBe(1);
    }
  });

  it('never creates or overwrites --out for an invalid declaration, even if --check was not requested', () => {
    const bad = rating(); bad.features[0].tier = 'unverified-tier'; const data = fixture(bad);
    expect(run([...data.args, '--out', data.out]).code).toBe(1); expect(existsSync(data.out)).toBe(false);
    writeFileSync(data.out, 'existing-ledger-sentinel\n', 'utf8');
    expect(run([...data.args, '--out', data.out]).code).toBe(1);
    expect(readFileSync(data.out, 'utf8')).toBe('existing-ledger-sentinel\n');
  });
});

describe('AI usage ledger validator parity / actual CLI and loader', () => {
  it.each([
    ['blank unit', (r: Rating) => { r.features[0].unit = '   '; }],
    ['bad feature id', (r: Rating) => { r.features[0].id = 'Rank Jobs'; }],
    ['duplicate feature id', (r: Rating) => { r.features.push({ ...r.features[0] }); }],
    ['zero memory', (r: Rating) => { r.memoryMb.low = 0; }],
    ['negative memory', (r: Rating) => { r.memoryMb.low = -1; }],
    ['fractional memory', (r: Rating) => { r.memoryMb.low = 1.5; }],
    ['reversed memory bounds', (r: Rating) => { r.memoryMb.low = 256; }],
    ['bytes as MiB', (r: Rating) => { r.memoryMb.high = 1_048_577; }],
    ['unknown basis', (r: Rating) => { r.memoryMb.basis = 'guessed'; }],
    ['unknown tier', (r: Rating) => { r.features[0].tier = 'T5'; }],
    ['unknown generation', (r: Rating) => { r.features[0].generation = 'invented'; }],
    ['unknown degrade', (r: Rating) => { r.features[0].degrade = 'invented'; }],
    ['T0 without generation', (r: Rating) => { r.features[0].tier = 'T0'; }],
    ['zero context', (r: Rating) => { r.features[0].contextFloor = 0; }],
    ['fractional context', (r: Rating) => { r.features[0].contextFloor = 1.5; }],
    ['missing reduced description', (r: Rating) => { r.features[0].degrade = 'reduced'; }],
    ['blank reduced description', (r: Rating) => { r.features[0].reducedEdition = ' '; }],
    ['non-text reduced description', (r: Rating) => { r.features[0].reducedEdition = 12; }],
  ] as const)('matches authoritative declaration refusal: %s', (_name, mutate) => {
    const bad = rating(); mutate(bad); loaderRejects(bad); const data = fixture(bad);
    const result = run(data.args); expect(result.code).toBe(1); expect(result.output).not.toContain('| Package |');
  });

  it.each([null, [], { memoryMb: null, features: [] }, { memoryMb: { low: 1, high: 2 }, features: null },
    { memoryMb: { low: 1, high: 2 }, features: [null] }])('refuses malformed declarations before rendering/writing %#', bad => {
    loaderRejects(bad); const data = fixture(bad); const result = run([...data.args, '--out', data.out]);
    expect(result.code).toBe(1); expect(result.output).not.toContain('TypeError'); expect(existsSync(data.out)).toBe(false);
  });
});

describe('AI usage ledger output safety and compatibility / actual CLI and filesystem', () => {
  it('keeps valid output deterministic and unmeasured; a hand-edited ledger still fails', () => {
    const data = fixture(); expect(run([...data.args, '--out', data.out]).code).toBe(0);
    const text = readFileSync(data.out, 'utf8'); expect(text).toContain('not yet measured | none recorded');
    expect(run([...data.args, '--check', data.out]).code).toBe(0);
    expect(run(data.args).output).toBe(text);
    writeFileSync(data.out, text.replace('| not yet measured | none recorded |', '| 42 tokens (measured) | none recorded |'), 'utf8');
    expect(run([...data.args, '--check', data.out]).code).toBe(1);
  });

  it('does not let combined --out and --check repair a stale checked file or write another output before failing', () => {
    const data = fixture(); const sentinel = 'stale-ledger-sentinel\n'; writeFileSync(data.out, sentinel, 'utf8');
    expect(run([...data.args, '--check', data.out, '--out', data.out]).code).toBe(1);
    expect(readFileSync(data.out, 'utf8')).toBe(sentinel);
    const other = join(data.root, 'other-ledger.md');
    expect(run([...data.args, '--check', data.out, '--out', other]).code).toBe(1);
    expect(existsSync(other)).toBe(false);
  });

  it.each([
    { memoryMb: { low: 1, high: 1 }, features: [] },
    { ...rating(), memoryMb: { low: 1, high: 1_048_576, basis: 'observed' } },
    { ...rating(), features: [{ ...rating().features[0], tier: 'T0', generation: 'local' }] },
    { ...rating(), features: [{ ...rating().features[0], tier: 'T0', generation: 'hosted' }] },
    { ...rating(), features: [{ ...rating().features[0], degrade: 'reduced', reducedEdition: 'fewer templates' }] },
  ])('retains valid legacy declaration compatibility %#', valid => {
    const manifest = { name: 'example-package', rating: valid } as unknown as SwarmAppManifest;
    expect(() => validateAppRating(manifest, 'fixture/oshal-app.yaml')).not.toThrow();
    const data = fixture(valid); expect(run([...data.args, '--out', data.out]).code).toBe(0);
    expect(run([...data.args, '--check', data.out]).code).toBe(0);
  });

  it('keeps missing-rating rollout behavior separate from malformed-rating refusal', () => {
    const data = fixture(); data.replace(undefined);
    expect(run([...data.args, '--out', data.out]).code).toBe(0);
    expect(run([...data.args, '--check', data.out]).code).toBe(1);
    expect(run([...data.args, '--check', data.out, '--allow-unrated']).code).toBe(0);
  });
});
