/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Trivy Security Center scanner: proves offline/air-gap no-egress flags are ALWAYS present, Trivy JSON (vuln/misconfig/secret) maps to scoped findings with stable fingerprints, secret VALUES are never persisted, and a missing binary / unseeded DB degrades to available:false (never a silent clean bill).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | scanTrivy is now async (execFileSync -> execFile so a 15-min image scan can't block the api event loop — the 07-15 wedge class); degradation cases await it. SYNC injected runners are kept on purpose: they prove the sync-or-async `run` contract still accepts plain functions.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTrivyArgs,
  mapTrivySeverity,
  parseTrivyReport,
  scanTrivy,
  TRIVY_CATEGORIES,
} from '../../src/features/security/trivy-scanner';

describe('trivy scanner — air-gap invariants', () => {
  it('ALWAYS emits the no-egress flags (offline/IL6)', () => {
    const args = buildTrivyArgs('/app');
    expect(args).toContain('--skip-db-update');
    expect(args).toContain('--skip-java-db-update');
    expect(args).toContain('--offline-scan');
    // never a network-implying update flag
    expect(args).not.toContain('--download-db-only');
    // covers all three surfaces in one pass
    const scanners = args[args.indexOf('--scanners') + 1];
    expect(scanners).toBe('vuln,misconfig,secret');
    // fs mode (no docker socket / no privilege), target last
    expect(args[0]).toBe('fs');
    expect(args[args.length - 1]).toBe('/app');
  });

  it('passes the pre-seeded cache dir when configured', () => {
    expect(buildTrivyArgs('/app', '/var/trivy-cache')).toEqual(
      expect.arrayContaining(['--cache-dir', '/var/trivy-cache']),
    );
    expect(buildTrivyArgs('/app')).not.toContain('--cache-dir');
  });
});

describe('trivy scanner — severity mapping', () => {
  it('maps Trivy severities to the OSHAL scale, UNKNOWN -> info', () => {
    expect(mapTrivySeverity('CRITICAL')).toBe('critical');
    expect(mapTrivySeverity('HIGH')).toBe('high');
    expect(mapTrivySeverity('MEDIUM')).toBe('medium');
    expect(mapTrivySeverity('LOW')).toBe('low');
    expect(mapTrivySeverity('UNKNOWN')).toBe('info');
    expect(mapTrivySeverity('')).toBe('info');
  });
});

describe('trivy scanner — JSON -> findings mapping', () => {
  const report = JSON.stringify({
    Results: [
      {
        Target: 'app/package-lock.json',
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-2024-0001', PkgName: 'left-pad', InstalledVersion: '1.0.0',
            FixedVersion: '1.0.1', Severity: 'HIGH', Title: 'padding overflow',
            PrimaryURL: 'https://avd.aquasec.com/CVE-2024-0001',
          },
        ],
      },
      {
        Target: 'Dockerfile',
        Misconfigurations: [
          { AVDID: 'AVD-DS-0002', Title: 'root user', Severity: 'MEDIUM', Resolution: 'add USER', CauseMetadata: { StartLine: 12 } },
        ],
      },
      {
        Target: '.env',
        Secrets: [
          // Trivy would also send Match/Code with the actual value — we must NOT persist it.
          { RuleID: 'aws-access-key-id', Category: 'AWS', Severity: 'CRITICAL', Title: 'AWS Access Key', StartLine: 3, Match: 'AKIAIOSFODNN7EXAMPLE', Code: { Lines: [{ Content: 'AWS_SECRET=AKIAIOSFODNN7EXAMPLE' }] } },
        ],
      },
    ],
  });

  it('maps vuln, misconfig, and secret to distinct scoped categories', () => {
    const findings = parseTrivyReport(report);
    expect(findings.map((f) => f.category).sort()).toEqual(['trivy_misconfig', 'trivy_secret', 'trivy_vuln']);
    for (const f of findings) expect(TRIVY_CATEGORIES).toContain(f.category);
  });

  it('builds stable, location-scoped fingerprints so a re-scan dedups', () => {
    const findings = parseTrivyReport(report);
    const byCat = Object.fromEntries(findings.map((f) => [f.category, f]));
    expect(byCat.trivy_vuln.fingerprint).toBe('trivy:vuln:app/package-lock.json:CVE-2024-0001:left-pad:1.0.0');
    expect(byCat.trivy_misconfig.fingerprint).toBe('trivy:misconfig:Dockerfile:AVD-DS-0002:12');
    expect(byCat.trivy_secret.fingerprint).toBe('trivy:secret:.env:aws-access-key-id:3');
    // fingerprint is deterministic across parses
    expect(parseTrivyReport(report)[0].fingerprint).toBe(findings[0].fingerprint);
  });

  it('NEVER persists the matched secret value or code line (redaction)', () => {
    const secretFinding = parseTrivyReport(report).find((f) => f.category === 'trivy_secret')!;
    const blob = JSON.stringify(secretFinding);
    // The actual matched value + the surrounding code line must be absent — only rule/location kept.
    expect(blob).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(blob).not.toContain('AWS_SECRET=');
    expect(secretFinding.detail).toContain('redacted');
    // But the non-sensitive locators (rule id, category, line) ARE kept for triage.
    expect(secretFinding.source).toBe('.env:3');
    expect((secretFinding.evidence as { ruleId?: string }).ruleId).toBe('aws-access-key-id');
  });

  it('carries the fix version and severity through to the vuln finding', () => {
    const vuln = parseTrivyReport(report).find((f) => f.category === 'trivy_vuln')!;
    expect(vuln.severity).toBe('high');
    expect(vuln.detail).toContain('fixed in 1.0.1');
    expect((vuln.evidence as { fixedVersion?: string }).fixedVersion).toBe('1.0.1');
  });
});

describe('trivy scanner — graceful degradation (never a silent clean bill)', () => {
  it('reports available:false when the binary is missing (throws without JSON stdout)', async () => {
    const rep = await scanTrivy({ run: () => { throw Object.assign(new Error('ENOENT'), {}); } });
    expect(rep.available).toBe(false);
    expect(rep.kind).toBe('image');
    expect(rep.findings).toEqual([]);
    expect(rep.categories).toEqual(TRIVY_CATEGORIES);
    expect(rep.note).toMatch(/could not run/i);
  });

  it('reads JSON off a non-zero exit (findings present => exit code set)', async () => {
    const raw = JSON.stringify({ Results: [{ Target: 't', Vulnerabilities: [{ VulnerabilityID: 'CVE-9', PkgName: 'p', InstalledVersion: '1', Severity: 'LOW' }] }] });
    // Async rejection path too — mirrors the real execFile runner rejecting with .stdout attached.
    const rep = await scanTrivy({ run: () => Promise.reject(Object.assign(new Error('exit 1'), { stdout: raw })) });
    expect(rep.available).toBe(true);
    expect(rep.findings).toHaveLength(1);
    expect(rep.findings[0].category).toBe('trivy_vuln');
  });

  it('reports available:false on unparseable output', async () => {
    const rep = await scanTrivy({ run: () => 'not json' });
    expect(rep.available).toBe(false);
    expect(rep.note).toMatch(/unparseable/i);
  });

  it('reports available:true with zero findings on a clean tree', async () => {
    const rep = await scanTrivy({ run: () => JSON.stringify({ Results: [] }) });
    expect(rep.available).toBe(true);
    expect(rep.findings).toEqual([]);
  });
});
