/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real HTTP production verification: redirects, exact bytes, oversize and truncated responses, per-artifact diagnostics, and destination-policy rejection of hostile index paths.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove the HTTP verifier applies one total deadline to a slow-drip body rather than resetting a full timeout for every byte read.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Require monotonic deadline accounting and a post-read budget check so clock changes or timer granularity cannot turn a late final read into success.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Give the redirect proof a bounded PowerShell process-startup allowance without changing the production HTTP deadline asserted by the suite.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Give the remaining real PowerShell HTTP probes explicit process-startup headroom while retaining the 200ms slow-body deadline and all fail-closed assertions.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Measure the slow-body wall clock from an explicit production-helper boundary handshake, excluding unrelated PowerShell startup starvation while retaining the 200ms HTTP deadline and a 3s fail-closed ceiling.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const helper = join(root, 'scripts', 'lib', 'recap-publication.ps1');
const helperSource = readFileSync(helper, 'utf8');
const publisherSources = [
  readFileSync(join(root, 'scripts', 'publish-agenticfederal-recap.ps1'), 'utf8'),
  readFileSync(join(root, 'scripts', 'publish-ecsg-recap.ps1'), 'utf8'),
];
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-recap-production-verify-'));
const probe = join(scratch, 'probe.ps1');
const exactBytes = Buffer.alloc(64, 0x41);
const exactHash = createHash('sha256').update(exactBytes).digest('hex');
let server: Server;
let baseUri = '';

const indexJson = (policy: 'agenticfederal' | 'ecsg'): Buffer => Buffer.from(JSON.stringify({ recaps: [{
  date: '2026-08-05',
  label: 'August 5, 2026',
  deck: policy === 'agenticfederal'
    ? 'https://attacker.invalid/media/recaps/2026-08-05.pptx'
    : '/downloads/recaps/2026-08-05/../stolen.pptx',
  video: policy === 'agenticfederal'
    ? 'recaps/2026-08-05.mp4'
    : '/downloads/recaps/2026-08-05.mp4',
  pdf: policy === 'agenticfederal' ? 'recaps/2026-08-05.pdf' : '',
}] }));

/** @description Sends one complete body with an explicit HTTP byte boundary. */
const sendBody = (response: ServerResponse, body: Buffer): void => {
  response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
  response.end(body);
};

/**
 * @description Serves adversarial response shapes through a real network stream.
 * @param path request path selected by the probe
 * @param response Node response used to control declared and actual byte lengths
 * @returns nothing
 */
const serveFixture = (path: string, response: ServerResponse): void => {
  if (path === '/redirect') {
    response.writeHead(302, { Location: '/exact' });
    response.end();
  } else if (path === '/exact') {
    sendBody(response, exactBytes);
  } else if (path === '/oversize') {
    sendBody(response, Buffer.concat([exactBytes, Buffer.from([0x42])]));
  } else if (path === '/truncated') {
    response.writeHead(200, { 'Content-Length': exactBytes.length });
    response.end(exactBytes.subarray(0, 13));
  } else if (path === '/wrong-hash') {
    sendBody(response, Buffer.alloc(exactBytes.length, 0x42));
  } else if (path === '/slow-drip') {
    response.writeHead(200, { 'Content-Length': exactBytes.length });
    const timer = setInterval(() => response.write(Buffer.from([0x41])), 75);
    response.once('close', () => clearInterval(timer));
  } else if (path === '/bad-index-agenticfederal') {
    sendBody(response, indexJson('agenticfederal'));
  } else if (path === '/bad-index-ecsg') {
    sendBody(response, indexJson('ecsg'));
  } else {
    response.writeHead(404, { 'Content-Length': 0 });
    response.end();
  }
};

writeFileSync(probe, String.raw`param(
  [Parameter(Mandatory)][string]$Helper,
  [Parameter(Mandatory)][ValidateSet('artifact', 'bounded', 'failures', 'index')][string]$Operation,
  [Parameter(Mandatory)][string]$Uri,
  [Parameter(Mandatory)][string]$Sha256,
  [string]$Policy = 'agenticfederal',
  [int]$TimeoutMs = 45000
)
. $Helper
$artifact = [pscustomobject]@{ bytes = 64; sha256 = $Sha256 }
try {
  if ($Operation -eq 'artifact') {
    [void](Test-RemoteRecapArtifact $Uri $artifact)
    [pscustomobject]@{ valid = $true } | ConvertTo-Json -Compress
  } elseif ($Operation -eq 'bounded') {
    $temp = Join-Path $env:TEMP ("oshal-recap-deadline-" + [guid]::NewGuid().ToString('N'))
    try {
      [Console]::Out.WriteLine('__OSHAL_RECAP_BOUNDARY_READY__')
      [Console]::Out.Flush()
      [void](Save-BoundedRecapHttpResponse $Uri $temp 64 64 $TimeoutMs)
      [pscustomobject]@{ valid = $true } | ConvertTo-Json -Compress
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
  } elseif ($Operation -eq 'failures') {
    $checks = @(
      @{ Label = 'exact'; Uri = "$Uri/exact"; Artifact = $artifact },
      @{ Label = 'oversize'; Uri = "$Uri/oversize"; Artifact = $artifact },
      @{ Label = 'truncated'; Uri = "$Uri/truncated"; Artifact = $artifact },
      @{ Label = 'wrong-hash'; Uri = "$Uri/wrong-hash"; Artifact = $artifact }
    )
    $failures = @(Get-RemoteRecapArtifactFailures $checks)
    [pscustomobject]@{ valid = $failures.Count -eq 0; failures = $failures } | ConvertTo-Json -Compress
  } else {
    $remote = Read-RemoteRecapIndex $Uri $Policy 'production test index'
    [pscustomobject]@{ valid = $true; count = @($remote.Entries).Count } | ConvertTo-Json -Compress
  }
} catch {
  [Console]::Error.WriteLine("production verification probe failed: $($_.Exception.Message)")
  [pscustomobject]@{ valid = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
`, 'utf8');

type ProbeResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  body: Record<string, unknown>;
  boundaryElapsedMs: number | null;
};

/**
 * @description Runs the real PowerShell helper while the in-process HTTP fixture remains responsive.
 * @param operation production verifier path to execute
 * @param uri endpoint supplied to the verifier
 * @param policy destination policy for index operations
 * @returns process result and its final JSON contract
 */
const runProbe = (operation: 'artifact' | 'bounded' | 'failures' | 'index', uri: string, policy = 'agenticfederal', timeoutMs = 45_000):
Promise<ProbeResult> => new Promise((resolve, reject) => {
  const child = spawn(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe,
    '-Helper', helper, '-Operation', operation, '-Uri', uri, '-Sha256', exactHash,
    '-Policy', policy, '-TimeoutMs', String(timeoutMs),
  ]);
  let stdout = '';
  let stderr = '';
  let boundaryReadyAt: number | null = null;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (boundaryReadyAt === null && stdout.includes('__OSHAL_RECAP_BOUNDARY_READY__')) {
      boundaryReadyAt = Date.now();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (status) => {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) return reject(new Error(`PowerShell probe returned no JSON: ${stderr}`));
    resolve({
      status,
      stdout,
      stderr,
      body: JSON.parse(line) as Record<string, unknown>,
      boundaryElapsedMs: boundaryReadyAt === null ? null : Date.now() - boundaryReadyAt,
    });
  });
});

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    serveFixture(path, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(scratch, { recursive: true, force: true });
});

describe('bounded recap production downloads', () => {
  it('accepts an exact artifact through an automatic redirect', async () => {
    const result = await runProbe('artifact', `${baseUri}/redirect`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.body).toEqual({ valid: true });
  }, 15_000);

  it('retains a distinct byte or hash reason for every failed artifact', async () => {
    const result = await runProbe('failures', baseUri);
    expect(result.status, result.stderr).toBe(0);
    const failures = result.body.failures as string[];
    expect(failures).toHaveLength(3);
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^oversize: declared response length 65 exceeds the 64-byte safety limit$/),
      expect.stringMatching(/^truncated: .*after \d+ of 64 (?:declared )?bytes/i),
      expect.stringMatching(/^wrong-hash: SHA-256 mismatch/i),
    ]));
  }, 20_000);

  it('applies one wall-clock budget to a slow-drip response body', async () => {
    const result = await runProbe('bounded', `${baseUri}/slow-drip`, 'agenticfederal', 200);
    expect(result.status).toBe(1);
    expect(String(result.body.error)).toMatch(/deadline|timed? out|timeout/i);
    expect(result.boundaryElapsedMs).not.toBeNull();
    expect(result.boundaryElapsedMs!).toBeLessThan(3_000);
  }, 15_000);

  it('keeps bounded reads, redirect handling, and connect/read timeouts in the production helper', () => {
    expect(helperSource).toMatch(/AllowAutoRedirect\s*=\s*\$true/);
    expect(helperSource).toMatch(/MaximumAutomaticRedirections\s*=\s*5/);
    expect(helperSource).toMatch(/\[int\]\$TimeoutMs\s*=\s*45000/);
    expect(helperSource).toMatch(/\.Timeout\s*=\s*\$TimeoutMs/);
    expect(helperSource).toMatch(/\.ReadWriteTimeout\s*=\s*\$TimeoutMs/);
    expect(helperSource).toMatch(/\[Diagnostics\.Stopwatch\]::StartNew\(\)/);
    expect(helperSource).toMatch(/\$TimeoutMs - \$timer\.ElapsedMilliseconds/);
    expect(helperSource).toMatch(/\.ReadTimeout\s*=\s*\[Math\]::Max\(1,\s*\$remainingMs\)/);
    expect(helperSource).toMatch(/\$received \+= \$count[\s\S]{0,180}\$timer\.ElapsedMilliseconds -ge \$TimeoutMs/);
    expect(helperSource).toMatch(/while \(\$received -lt \$declared\)/);
  });
});

describe('strict production recap indexes', () => {
  it.each(['agenticfederal', 'ecsg'] as const)('rejects hostile %s paths before entry selection', async (policy) => {
    const result = await runProbe('index', `${baseUri}/bad-index-${policy}`, policy);
    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${String(result.body.error)}`).toMatch(/unsafe deck path/i);
  }, 20_000);

  it('routes both live publishers through strict indexes and labeled artifact diagnostics', () => {
    for (const source of publisherSources) {
      expect(source).toMatch(/Read-RemoteRecapIndex \$indexUri '(?:agenticfederal|ecsg)'/);
      expect(source).toContain('Get-RemoteRecapArtifactFailures $checks');
      expect(source).toMatch(/production verification attempt \$attempt failed:/);
    }
  });
});
