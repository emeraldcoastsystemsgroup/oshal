/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                   | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the render-node lease metadata survives the host's native-command argument boundary, in the host's own mode and in the legacy mode that silently ate the quotes, and pin the market-session check ahead of the durable lease.
 */
import { spawnSync } from 'node:child_process';
import {
  afterAll, describe, expect, it,
} from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const runner = join(repoRoot, 'scripts', 'run-daily-recap.ps1');
const leaseCli = join(repoRoot, 'scripts', 'oshal-node-lease.js');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-recap-lease-args-'));
const sidecar = join(scratch, 'received.json');
const probeDate = '2026-08-05';
const probeNode = 'probe-render-node-1';

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The stand-in answers exactly as the containerised CLI does: it parses --metadata-json with THAT
// CLI's own exported parser, then prints one acquire-shaped record. A refused argument reports the
// parser's message, which is what the runner turns into its nightly failure.
const probeTarget = join(scratch, 'node-lease-argument-probe.js');
writeFileSync(probeTarget, `'use strict';
const { writeFileSync } = require('node:fs');
const { metadata } = require(${JSON.stringify(leaseCli)});
const index = process.argv.indexOf('--metadata-json');
const raw = index >= 0 ? process.argv[index + 1] : null;
let parsed = null;
let error = null;
try { parsed = metadata(); } catch (failure) { error = failure.message; }
writeFileSync(${JSON.stringify(sidecar)}, JSON.stringify({ argv: process.argv.slice(2), raw, parsed, error }));
if (error) {
  process.stdout.write(JSON.stringify({ acquired: false, message: error }) + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  acquired: true,
  lease_id: '11111111-2222-4333-8444-555555555555',
  expires_at: '2026-08-05T23:00:00.000Z',
  metadata: parsed,
}) + '\\n');
`);

// Windows PowerShell 5.1 - the host the scheduled task actually runs - builds the child command
// line itself and drops embedded double quotes. PowerShell 7.3+ passes native arguments verbatim
// instead, so forcing Legacy is how a modern host reproduces the nightly's failure exactly.
const legacyWrapper = join(scratch, 'force-legacy-argument-passing.ps1');
writeFileSync(legacyWrapper, [
  "$PSNativeCommandArgumentPassing = 'Legacy'",
  `& ${JSON.stringify(runner)} -Date '${probeDate}' -Node '${probeNode}' -NodeLeaseArgumentProbe ${JSON.stringify(probeTarget)}`,
  'exit $LASTEXITCODE',
].join('\n'));

/** @description Runs one probe and returns the runner's verdict plus what the CLI actually received. */
const runProbe = (psArgs: string[]) => {
  rmSync(sidecar, { force: true });
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...psArgs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, TEMP: tmpdir(), OSHAL_RECAP_NODE_LEASE_MINUTES: '360' },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const received = JSON.parse(readFileSync(sidecar, 'utf8'));
  return { status: result.status, output, received };
};

describe('daily recap render-node lease metadata argument', () => {
  it('reaches the lease CLI as parseable JSON in the host default argument mode', () => {
    const probe = runProbe([
      '-File', runner, '-Date', probeDate, '-Node', probeNode, '-NodeLeaseArgumentProbe', probeTarget,
    ]);

    expect(probe.received.error, probe.output).toBeNull();
    expect(probe.received.raw.startsWith('{"'), `CLI received: ${probe.received.raw}`).toBe(true);
    expect(probe.received.parsed).toEqual({ requestedDate: probeDate, nodeClientId: probeNode });
    expect(probe.status, probe.output).toBe(0);
    expect(probe.output).toContain('"acquired":true');
  }, 90_000);

  it('still reaches it intact when the host strips quotes from native arguments', () => {
    const probe = runProbe(['-File', legacyWrapper]);

    expect(probe.received.error, probe.output).toBeNull();
    expect(probe.received.parsed).toEqual({ requestedDate: probeDate, nodeClientId: probeNode });
    expect(probe.status, probe.output).toBe(0);
    expect(probe.output).not.toMatch(/returned no JSON|position 1/i);
  }, 90_000);

  it('sends the full acquire capability alongside the metadata', () => {
    const probe = runProbe([
      '-File', runner, '-Date', probeDate, '-Node', probeNode, '-NodeLeaseArgumentProbe', probeTarget,
    ]);
    const argv: string[] = probe.received.argv;

    expect(argv[0]).toBe('acquire');
    expect(argv[argv.indexOf('--resource') + 1]).toBe(`vids-render-node:${probeNode}`);
    expect(argv[argv.indexOf('--purpose') + 1]).toBe('daily-recap-build-publish');
    expect(argv[argv.indexOf('--ttl-seconds') + 1]).toBe('21600');
  }, 90_000);
});

describe('daily recap market-session guard placement', () => {
  const source = readFileSync(runner, 'utf8');

  it('asks the market calendar before taking the durable render-node lease', () => {
    const session = source.indexOf('(Get-RecapMarketSession) -eq \'none\'');
    const acquire = source.indexOf('$sharedNodeLease = Enter-SharedNodeLease');
    const preflight = source.indexOf('# 1) PREFLIGHT');
    expect(session).toBeGreaterThan(0);
    expect(session).toBeLessThan(acquire);
    expect(acquire).toBeLessThan(preflight);
    expect(source.match(/\(Get-RecapMarketSession\) -eq 'none'/g)?.length).toBe(1);
  });

  it('leaves a non-trading day with no lease to release and nothing to alert about', () => {
    const guard = source.slice(
      source.indexOf('(Get-RecapMarketSession) -eq \'none\''),
      source.indexOf('$sharedNodeLease = Enter-SharedNodeLease'),
    );
    expect(guard).toContain('nothing to recap');
    expect(guard).toContain('exit 0');
    expect(guard).not.toContain('Fail ');
  });
});
