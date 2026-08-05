/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavioral publication guards: run the real PowerShell publisher against a temporary Git remote, proving manifest-bound exact commits, operator-branch/staging isolation, provenance index fields, and fail-closed malformed-index handling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Identify the linked build fixture with the same explicit manifest kind required in production.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reject syntactically valid recap indexes with a scalar array replacement or duplicate dates.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reject a one-element root array instead of allowing PowerShell pipeline enumeration to unwrap it.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exercise destination-scoped URL policy so only ECSG preserves its exact historical AgenticFederal links.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Drive the shared index-policy helper directly against legacy and arbitrary external URL fixtures.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const publisher = join(root, 'scripts', 'publish-agenticfederal-recap.ps1');
const publicationHelper = join(root, 'scripts', 'lib', 'recap-publication.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-recap-publish-test-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim();

const artifact = (name: string, path: string) => {
  const bytes = readFileSync(path);
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

const createDelivery = (name: string) => {
  const out = join(scratch, `${name}-out`);
  mkdirSync(out, { recursive: true });
  const date = '2026-08-05';
  const sources = [
    ['deck-data.json', Buffer.from(JSON.stringify({ date: 'August 5, 2026', results: { pl: 42 } }))],
    ['deck.pptx', Buffer.alloc(20_000, 2)],
    ['presenter-head.png', Buffer.alloc(12_000, 3)],
    ['RECAP-BUILD-GOAL.md', Buffer.alloc(11_000, 4)],
    [`${date}.pdf`, Buffer.alloc(20_001, 5)],
    ['trade-recap.mp4', Buffer.alloc(1_100_000, 6)],
  ] as const;
  for (const [file, bytes] of sources) writeFileSync(join(out, file), bytes);

  const runId = 'a'.repeat(32);
  const deliveryId = 'b'.repeat(32);
  const inputNames = ['deck-data.json', 'deck.pptx', 'presenter-head.png', 'RECAP-BUILD-GOAL.md'];
  const inputs = inputNames.map((file) => artifact(file, join(out, file)));
  const pieceNames = ['presenter-intro.mp4', 'presenter-overview.mp4', 'presenter-close.mp4', 'deck-narrated.mp4'];
  const pieces = pieceNames.map((file, index) => ({ file, name: file, bytes: 400_000 + index, sha256: String(index + 1).repeat(64) }));
  const build = {
    schemaVersion: 1, manifestKind: 'recap-build', runId, requestedDate: date, status: 'complete',
    completedAt: '2026-08-05T23:20:00.000Z', inputs, pieces,
  };
  const buildName = `build-artifacts-${runId}.json`;
  const buildPath = join(out, buildName);
  writeFileSync(buildPath, JSON.stringify(build));
  const outputs = ['deck.pptx', `${date}.pdf`, 'trade-recap.mp4'].map((file) => artifact(file, join(out, file)));
  const delivery = {
    schemaVersion: 1, manifestKind: 'recap-delivery', runId, deliveryId, requestedDate: date,
    status: 'complete', completedAt: '2026-08-05T23:30:00.000Z',
    buildManifest: artifact(buildName, buildPath), inputs, pieces, outputs,
  };
  const manifest = join(out, 'RECAP.manifest.json');
  writeFileSync(manifest, JSON.stringify(delivery));
  return { out, date, manifest, delivery };
};

const createSite = (name: string, indexJson: string) => {
  const bare = join(scratch, `${name}-remote.git`);
  const site = join(scratch, `${name}-site`);
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', site], { stdio: 'ignore' });
  git(site, 'config', 'user.email', 'test@example.com');
  git(site, 'config', 'user.name', 'Recap Test');
  mkdirSync(join(site, 'media', 'recaps'), { recursive: true });
  writeFileSync(join(site, 'media', 'recaps', 'index.json'), indexJson);
  writeFileSync(join(site, 'media', 'recaps', '.gitkeep'), '');
  git(site, 'add', '.');
  git(site, 'commit', '-m', 'seed');
  git(site, 'remote', 'add', 'origin', bare);
  git(site, 'push', '-u', 'origin', 'main');
  git(site, 'switch', '-c', 'feature/wip');
  writeFileSync(join(site, 'wip.txt'), 'unfinished operator work');
  git(site, 'add', 'wip.txt');
  return { bare, site, seed: git(site, 'rev-parse', 'main') };
};

const runPublisher = (date: string, site: string, out: string, manifest: string) => spawnSync(powershell, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', publisher,
  '-Date', date, '-SiteRepo', site, '-Out', out, '-Manifest', manifest,
  '-SkipDeploy', '-SkipMirror', '-SkipJournal',
], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

const runIndexPolicy = (indexJson: string, policy: 'agenticfederal' | 'ecsg') => {
  const suffix = createHash('sha256').update(`${policy}:${indexJson}`).digest('hex').slice(0, 12);
  const indexPath = join(scratch, `policy-${suffix}.json`);
  const probePath = join(scratch, `policy-${suffix}.ps1`);
  writeFileSync(indexPath, indexJson);
  writeFileSync(probePath, String.raw`param([string]$Helper, [string]$Index, [string]$Policy)
. $Helper
try {
  $value = Read-RecapJsonStrict $Index 'test recap index'
  [void](Get-RecapIndexEntries $value 'test recap index' $Policy)
  '{"valid":true}'
} catch { Write-Error $_.Exception.Message; exit 1 }
`);
  return spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probePath,
    '-Helper', publicationHelper, '-Index', indexPath, '-Policy', policy,
  ], { encoding: 'utf8' });
};

describe('recap publication safety (behavioral)', () => {
  it('publishes only manifest-authorized paths without touching the operator branch or staged work', () => {
    const delivery = createDelivery('success');
    const site = createSite('success', JSON.stringify({ recaps: [] }));
    const result = runPublisher(delivery.date, site.site, delivery.out, delivery.manifest);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(git(site.site, 'branch', '--show-current')).toBe('feature/wip');
    expect(git(site.site, 'diff', '--cached', '--name-only')).toBe('wip.txt');
    const changed = git(site.bare, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main').split(/\r?\n/).sort();
    expect(changed).toEqual([
      `media/recaps/${delivery.date}.mp4`,
      `media/recaps/${delivery.date}.pdf`,
      `media/recaps/${delivery.date}.pptx`,
      'media/recaps/index.json',
      'media/trade-recap-deck.pptx',
      'media/trade-recap.mp4',
    ].sort());
    expect(changed).not.toContain('wip.txt');

    const rawIndex = git(site.bare, 'show', 'main:media/recaps/index.json');
    const entry = JSON.parse(rawIndex).recaps[0];
    expect(entry).toMatchObject({
      date: delivery.date,
      runId: delivery.delivery.runId,
      deliveryId: delivery.delivery.deliveryId,
      deckSha256: delivery.delivery.outputs[0].sha256,
      pdfSha256: delivery.delivery.outputs[1].sha256,
      videoSha256: delivery.delivery.outputs[2].sha256,
    });
  }, 30_000);

  it('fails closed on malformed site JSON and leaves origin/main byte-for-byte unchanged', () => {
    const delivery = createDelivery('malformed');
    const site = createSite('malformed', '{ definitely-not-json');
    const result = runPublisher(delivery.date, site.site, delivery.out, delivery.manifest);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/FAILED:.*index.*unreadable/i);
    expect(git(site.bare, 'rev-parse', 'main')).toBe(site.seed);
    expect(git(site.site, 'branch', '--show-current')).toBe('feature/wip');
    expect(git(site.site, 'diff', '--cached', '--name-only')).toBe('wip.txt');
  }, 30_000);
});

describe('recap publication index schema (behavioral)', () => {
  it.each([
    ['scalar recaps', JSON.stringify({ recaps: { date: '2026-08-04' } }), /must contain a recaps array/i],
    ['duplicate dates', JSON.stringify({ recaps: [{ date: '2026-08-04' }, { date: '2026-08-04' }] }), /duplicate recap date/i],
    ['root-array index', JSON.stringify([{ recaps: [] }]), /root must be an object/i],
  ])('fails closed on %s', (_label, indexJson, expectedError) => {
    const suffix = `schema-${createHash('sha256').update(indexJson).digest('hex').slice(0, 8)}`;
    const delivery = createDelivery(suffix);
    const site = createSite(suffix, indexJson);
    const result = runPublisher(delivery.date, site.site, delivery.out, delivery.manifest);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(expectedError);
    expect(git(site.bare, 'rev-parse', 'main')).toBe(site.seed);
    expect(git(site.site, 'branch', '--show-current')).toBe('feature/wip');
    expect(git(site.site, 'diff', '--cached', '--name-only')).toBe('wip.txt');
  }, 30_000);
});

describe('recap publication destination URL policy', () => {
  const legacy = JSON.stringify({ recaps: [{
    date: '2026-07-10', label: 'July 10, 2026',
    deck: 'https://agenticfederal.us/media/recaps/2026-07-10.pdf',
    video: 'https://agenticfederal.us/media/recaps/2026-07-10.mp4',
  }] });

  it('allows the exact historical AF origin only for the ECSG index', () => {
    expect(runIndexPolicy(legacy, 'ecsg').status).toBe(0);
    const af = runIndexPolicy(legacy, 'agenticfederal');
    expect(af.status).toBe(1);
    expect(`${af.stdout}\n${af.stderr}`).toMatch(/unsafe deck path/i);
  });

  it('rejects an arbitrary external origin for ECSG', () => {
    const hostile = legacy.replaceAll('agenticfederal.us', 'attacker.invalid');
    const result = runIndexPolicy(hostile, 'ecsg');
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsafe deck path/i);
  });

  it('rejects markup in an ECSG operator note before it reaches innerHTML consumers', () => {
    const unsafeNote = JSON.stringify({ recaps: [{
      date: '2026-08-05', label: 'August 5, 2026',
      deck: '/downloads/recaps/2026-08-05.pdf', note: '<img src=x onerror=alert(1)>',
    }] });
    const result = runIndexPolicy(unsafeNote, 'ecsg');
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsafe note text/i);
  });
});
