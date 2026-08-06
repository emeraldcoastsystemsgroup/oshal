/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavioral guard for stable AgenticFederal deployment: execute the real publisher function and checkout helper against temporary Git repos, prove origin drift triggers a retry from the descendant commit, pin deployed-HEAD equality, preserve the operator checkout, and reject rewritten main before upload.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bound the spawned PowerShell deploy probe and give the two-attempt real-Git drift scenario full-suite process-startup headroom.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const publisherPath = join(repoRoot, 'scripts', 'publish-agenticfederal-recap.ps1');
const helperPath = join(repoRoot, 'scripts', 'lib', 'recap-publication.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-recap-deploy-drift-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** @description Runs Git without a shell so fixture paths cannot alter the command. */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim();

/** @description Captures all checkout state that an isolated deployment is forbidden to mutate. */
const operatorState = (site: string) => ({
  branch: git(site, 'branch', '--show-current'),
  head: git(site, 'rev-parse', 'HEAD'),
  status: git(site, 'status', '--short'),
  remoteMain: git(site, 'rev-parse', 'refs/remotes/origin/main'),
});

/**
 * @description Writes the fake deployer committed in A and inherited by B.
 * Attempt one records A, then advances origin/main with a descendant B. Later attempts only
 * record what they deployed, making success evidence independent of the function's log text.
 */
const writeAdvancingDeployScript = (path: string): void => writeFileSync(path, String.raw`
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$head = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { exit 10 }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::AppendAllText(
  $env:OSHAL_RECAP_DEPLOY_TEST_LOG,
  ($head + [Environment]::NewLine),
  $utf8
)

if (-not (Test-Path -LiteralPath $env:OSHAL_RECAP_DEPLOY_TEST_PUSHED)) {
  [IO.File]::WriteAllText($env:OSHAL_RECAP_DEPLOY_TEST_PUSHED, 'attempt-one', $utf8)
  $writer = Join-Path ([IO.Path]::GetTempPath()) ("oshal-recap-deploy-writer-" + [guid]::NewGuid().ToString('N'))
  try {
    $origin = (& git -C $repo remote get-url origin).Trim()
    & git clone --quiet --branch main --single-branch --no-tags -- $origin $writer 2>&1 | Out-Null
    $cloneExit = $LASTEXITCODE
    if ($cloneExit -ne 0) { exit 11 }
    & git -C $writer config user.name 'OSHAL Maintainer'
    & git -C $writer config user.email 'maintainer@emeraldcoastsystemsgroup.com'
    [IO.File]::WriteAllText((Join-Path $writer 'generation.txt'), 'B', $utf8)
    & git -C $writer add -- generation.txt
    if ($LASTEXITCODE -ne 0) { exit 12 }
    & git -C $writer commit --quiet -m 'advance main during fake deploy'
    if ($LASTEXITCODE -ne 0) { exit 13 }
    & git -C $writer push --quiet origin HEAD:main
    if ($LASTEXITCODE -ne 0) { exit 14 }
  } finally {
    if (Test-Path -LiteralPath $writer) {
      Remove-Item -LiteralPath $writer -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
exit 0
`);

/**
 * @description Builds a real origin/main plus a dirty operator feature branch.
 * The deploy script is versioned so each disposable production clone executes its own HEAD's
 * implementation, matching the production trust boundary rather than injecting a mock function.
 */
const createSite = (name: string) => {
  const bare = join(scratch, `${name}-origin.git`);
  const site = join(scratch, `${name}-operator`);
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', site], { stdio: 'ignore' });
  git(site, 'config', 'user.name', 'OSHAL Maintainer');
  git(site, 'config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  mkdirSync(join(site, 'scripts'), { recursive: true });
  writeAdvancingDeployScript(join(site, 'scripts', 'deploy-cloudflare-pages.ps1'));
  writeFileSync(join(site, 'generation.txt'), 'A');
  git(site, 'add', '--', 'generation.txt', 'scripts/deploy-cloudflare-pages.ps1');
  git(site, 'commit', '--quiet', '-m', 'seed deploy generation A');
  git(site, 'remote', 'add', 'origin', bare);
  git(site, 'push', '--quiet', '-u', 'origin', 'main');
  const requiredCommit = git(site, 'rev-parse', 'HEAD');
  git(site, 'switch', '--quiet', '-c', 'feature/operator-wip');
  writeFileSync(join(site, 'operator-wip.txt'), 'staged but unfinished operator work');
  git(site, 'add', '--', 'operator-wip.txt');
  return { bare, site, requiredCommit };
};

/**
 * @description Writes a thin harness around the exact production function AST.
 * Parsing the function instead of dot-sourcing the publisher prevents its command-line main from
 * running while ensuring this test cannot silently drift to a copied implementation.
 */
const writeFunctionProbe = (path: string): void => writeFileSync(path, String.raw`
param(
  [Parameter(Mandatory)][string]$Publisher,
  [Parameter(Mandatory)][string]$Helper,
  [Parameter(Mandatory)][string]$SiteRepo,
  [Parameter(Mandatory)][string]$RequiredCommit
)
$ErrorActionPreference = 'Continue'
. $Helper
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Publisher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'publisher source did not parse' }
$definitions = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-StableAgenticFederalDeploy'
}, $true))
if ($definitions.Count -ne 1) { throw 'stable deploy function was not uniquely defined' }
. ([ScriptBlock]::Create($definitions[0].Extent.Text))
function Note($message) { Write-Host ("[deploy-test] " + $message) }
Invoke-StableAgenticFederalDeploy $SiteRepo $RequiredCommit
`);

/** @description Executes the real stable-deploy function in a separate PowerShell process. */
const runStableDeploy = (site: string, requiredCommit: string, log: string, marker: string) => {
  const probe = join(scratch, `invoke-${Math.random().toString(16).slice(2)}.ps1`);
  writeFunctionProbe(probe);
  return spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe,
    '-Publisher', publisherPath, '-Helper', helperPath,
    '-SiteRepo', site, '-RequiredCommit', requiredCommit,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 50_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      OSHAL_RECAP_DEPLOY_TEST_LOG: log,
      OSHAL_RECAP_DEPLOY_TEST_PUSHED: marker,
    },
  });
};

/** @description Force-publishes an unrelated root commit to emulate a rewritten main. */
const rewriteMain = (bare: string, name: string): string => {
  const repo = join(scratch, `${name}-rewrite`);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'OSHAL Maintainer');
  git(repo, 'config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  writeFileSync(join(repo, 'unrelated-root.txt'), 'history replacement');
  git(repo, 'add', '--', 'unrelated-root.txt');
  git(repo, 'commit', '--quiet', '-m', 'rewrite main from unrelated root');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '--force', 'origin', 'HEAD:main');
  return git(repo, 'rev-parse', 'HEAD');
};

describe('stable AgenticFederal deployment (behavioral)', () => {
  it('detects attempt-one drift and succeeds only after deploying the descendant origin/main', () => {
    const fixture = createSite('advance');
    const before = operatorState(fixture.site);
    const log = join(scratch, 'advance-deployed-heads.log');
    const marker = join(scratch, 'advance-pushed.marker');

    const result = runStableDeploy(fixture.site, fixture.requiredCommit, log, marker);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const originMain = git(fixture.bare, 'rev-parse', 'refs/heads/main');
    const deployedHeads = readFileSync(log, 'utf8').trim().split(/\r?\n/);
    expect(deployedHeads).toEqual([fixture.requiredCommit, originMain]);
    expect(git(fixture.bare, 'rev-parse', 'refs/heads/main^')).toBe(fixture.requiredCommit);
    expect(git(fixture.bare, 'show', 'refs/heads/main:generation.txt')).toBe('B');
    expect(result.stdout).toContain(`origin/main advanced to ${originMain}`);
    expect(result.stdout).toContain(`deploying origin/main ${originMain} to Cloudflare Pages (attempt 2/3)`);
    expect(operatorState(fixture.site)).toEqual(before);
  }, 60_000);

  it('rejects a required commit absent from rewritten main before invoking deploy', () => {
    const fixture = createSite('rewrite');
    const before = operatorState(fixture.site);
    const rewrittenHead = rewriteMain(fixture.bare, 'rewrite');
    const log = join(scratch, 'rewrite-deployed-heads.log');
    const marker = join(scratch, 'rewrite-pushed.marker');

    const result = runStableDeploy(fixture.site, fixture.requiredCommit, log, marker);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/origin\/main no longer contains the verified recap commit/i);
    expect(git(fixture.bare, 'rev-parse', 'refs/heads/main')).toBe(rewrittenHead);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(operatorState(fixture.site)).toEqual(before);
  }, 30_000);
});
