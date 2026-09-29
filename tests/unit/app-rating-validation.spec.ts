/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-170 rating label: the closed tier/generation/degrade/basis sets, readManifest accepting a valid `rating:` block and refusing each malformed shape (unknown tier, memory low > high, bytes typed as MiB, duplicate id, `reduced` without text, unknown keys), a missing block staying warn-only, every in-repo kernel manifest rated, and the REAL ledger generator over a temp checkout going red on a stale file and on an unrated manifest.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expected ledger rows follow the generator dropping its Version column.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | T0 closed-set membership, T0 accepted for a hosted-generation feature, T0 with no generation refused.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  readManifest,
  APP_RATING_TIERS, isAppRatingTier,
  APP_RATING_GENERATIONS, isAppRatingGeneration,
  APP_RATING_DEGRADES, isAppRatingDegrade,
  APP_RATING_MEMORY_BASES, isAppRatingMemoryBasis,
  APP_RATING_MEMORY_MAX_MB,
} from '../../src/features/swarm-apps';

const REPO_ROOT = resolve(__dirname, '../..');
const LEDGER = join(REPO_ROOT, 'scripts/ai-usage-ledger.js');

const VALID = [
  'rating:',
  '  memoryMb: { low: 64, high: 512 }',
  '  features:',
  '    - id: digest',
  '      unit: " daily digest "',
  '      tier: T3',
  '      generation: none',
  '      degrade: reduced',
  '      reducedEdition: T2 summary over code-ranked signals',
  '      contextFloor: 16384',
  '',
].join('\n');

function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-rating-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\nsuite: ai-productivity\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('rating closed sets (ADR-170 D1/D9)', () => {
  it('are exactly the documented values', () => {
    expect([...APP_RATING_TIERS]).toEqual(['T0', 'T1', 'T2', 'T3', 'T4']);
    expect([...APP_RATING_GENERATIONS]).toEqual(['none', 'local', 'hosted']);
    expect([...APP_RATING_DEGRADES]).toEqual(['template', 'hosted', 'disable', 'reduced']);
    expect([...APP_RATING_MEMORY_BASES]).toEqual(['declared', 'observed']);
    expect(isAppRatingTier('T5')).toBe(false);
    expect(isAppRatingGeneration('cloud')).toBe(false);
    expect(isAppRatingDegrade('fallback')).toBe(false);
    expect(isAppRatingMemoryBasis('guessed')).toBe(false);
    expect(APP_RATING_MEMORY_MAX_MB).toBe(1_048_576);
  });
});

describe('readManifest and the rating block', () => {
  it('accepts a valid block and normalises it (basis defaults to declared, unit trimmed)', () => {
    const m = read(VALID);
    expect(m.rating).toEqual({
      memoryMb: { low: 64, high: 512, basis: 'declared' },
      features: [{
        id: 'digest', unit: 'daily digest', tier: 'T3', generation: 'none', degrade: 'reduced',
        contextFloor: 16384, reducedEdition: 'T2 summary over code-ranked signals',
      }],
    });
  });

  it('an EMPTY features list is a declaration: no model in the loop (T0)', () => {
    expect(read('rating:\n  memoryMb: { low: 32, high: 32 }\n  features: []\n').rating?.features).toEqual([]);
  });

  it('T0 is accepted for a generation-only feature (template prompt driving a hosted image model)', () => {
    const body = [
      'rating:',
      '  memoryMb: { low: 32, high: 128 }',
      '  features:',
      '    - id: portrait',
      '      unit: portrait',
      '      tier: T0',
      '      generation: hosted',
      '      degrade: disable',
      '',
    ].join('\n');
    expect(read(body).rating?.features[0]).toMatchObject({ tier: 'T0', generation: 'hosted' });
  });

  it('a MISSING block is allowed — installed pre-170 packages keep booting', () => {
    expect(read('').rating).toBeUndefined();
  });

  it.each([
    ['unknown tier', VALID.replace('tier: T3', 'tier: T5'), /tier "T5" is not one of T0, T1, T2, T3, T4/],
    ['T0 with no generation backend', VALID.replace('tier: T3', 'tier: T0'), /tier T0 is declared only for a generation-only feature/],
    ['unknown generation', VALID.replace('generation: none', 'generation: cloud'), /generation "cloud" is not one of/],
    ['unknown degrade', VALID.replace('degrade: reduced', 'degrade: fallback'), /degrade "fallback" is not one of/],
    ['reduced without text', VALID.replace('      reducedEdition: T2 summary over code-ranked signals\n', ''), /requires reducedEdition/],
    ['memory low above high', VALID.replace('{ low: 64, high: 512 }', '{ low: 640, high: 512 }'), /low \(640\) must not exceed high \(512\)/],
    ['memory typed in bytes', VALID.replace('{ low: 64, high: 512 }', '{ low: 64, high: 536870912 }'), /the unit is MiB, not bytes/],
    ['memory not an integer', VALID.replace('{ low: 64, high: 512 }', '{ low: 0.5, high: 512 }'), /positive integers/],
    ['memory basis unknown', VALID.replace('{ low: 64, high: 512 }', '{ low: 64, high: 512, basis: guessed }'), /basis "guessed" is not one of declared, observed/],
    ['missing unit', VALID.replace('      unit: " daily digest "\n', ''), /unit must name the thing/],
    ['id not kebab-case', VALID.replace('id: digest', 'id: Daily_Digest'), /id must be a kebab-case string/],
    ['unknown feature key', VALID.replace('      contextFloor: 16384', '      tokensPerUnit: 9000'), /rating\.features\[0\] has unknown field\(s\): tokensPerUnit/],
    ['unknown rating key', VALID.replace('  features:', '  tokens: 100\n  features:'), /rating has unknown field\(s\): tokens/],
    ['features not a list', 'rating:\n  memoryMb: { low: 1, high: 1 }\n  features: digest\n', /rating\.features must be a list/],
    ['rating not a mapping', 'rating: medium\n', /rating must be a mapping/],
  ])('REJECTS %s', (_label, body, message) => {
    expect(() => read(body)).toThrow(message);
  });

  it('REJECTS a duplicate feature id', () => {
    const twice = `${VALID}    - id: digest\n      unit: x\n      tier: T1\n      generation: none\n      degrade: disable\n`;
    expect(() => read(twice)).toThrow(/id "digest" is declared twice/);
  });
});

describe('every in-repo kernel manifest is rated', () => {
  const MANIFEST_DIRS = ['swarm-apps', 'swarm-apps-build'];
  it('all manifests in every manifest dir declare a valid rating', () => {
    const unrated: string[] = [];
    for (const dir of MANIFEST_DIRS) {
      const abs = join(REPO_ROOT, dir);
      for (const file of readdirSync(abs).filter((f) => f.endsWith('.yaml'))) {
        const m = readManifest(join(abs, file)); // a malformed block throws here
        if (!m.rating) unrated.push(`${dir}/${file}`);
      }
    }
    expect(unrated).toEqual([]);
  });
});

describe('the ledger generator (real script, temp checkout)', () => {
  function checkout(withRating: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-ledger-'));
    mkdirSync(join(dir, 'swarm-apps'));
    writeFileSync(join(dir, 'swarm-apps/a.yaml'), `name: a\ndisplayName: A\nversion: 1.0.0\n${VALID}`, 'utf8');
    writeFileSync(join(dir, 'swarm-apps/b.yaml'), `name: b\ndisplayName: B\nversion: 2.0.0\n${withRating ? 'rating:\n  memoryMb: { low: 16, high: 64 }\n  features: []\n' : ''}`, 'utf8');
    return dir;
  }
  function run(args: string[]): { code: number; output: string } {
    try {
      return { code: 0, output: execFileSync('node', [LEDGER, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('writes a deterministic ledger and --check passes on it', () => {
    const dir = checkout(true);
    try {
      const out = join(dir, 'ledger.md');
      expect(run(['--core', dir, '--out', out]).code).toBe(0);
      const text = readFileSync(out, 'utf8');
      expect(text).toContain('Coverage: 2 manifests, 2 rated, 0 unrated.');
      expect(text).toContain('| a | 64 / 512 (declared) | digest | daily digest | T3 (context ≥ 16384) | none | reduced: T2 summary over code-ranked signals | not yet measured | none recorded |');
      expect(text).toContain('| b | 16 / 64 (declared) | none (T0, no model in the loop) |');
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates: the check must not churn per commit
      expect(run(['--core', dir, '--check', out]).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check goes RED on a stale ledger', () => {
    const dir = checkout(true);
    try {
      const out = join(dir, 'ledger.md');
      run(['--core', dir, '--out', out]);
      writeFileSync(out, readFileSync(out, 'utf8').replace('64 / 512', '64 / 8192'), 'utf8'); // a hand-typed number
      const result = run(['--core', dir, '--check', out]);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/is stale; regenerate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check goes RED on an unrated manifest, and --allow-unrated only lists it', () => {
    const dir = checkout(false);
    try {
      const out = join(dir, 'ledger.md');
      run(['--core', dir, '--out', out]);
      expect(readFileSync(out, 'utf8')).toContain('Unrated: b.');
      const strict = run(['--core', dir, '--check', out]);
      expect(strict.code).toBe(1);
      expect(strict.output).toMatch(/unrated manifest\(s\): swarm-apps\/b\.yaml/);
      expect(run(['--core', dir, '--check', out, '--allow-unrated']).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
