/**
 * Dependency scanner (posture) — Security Center (ADR-055).
 *
 * Shells `npm audit --json` in the scan root and maps each advisory to a finding. `npm audit`
 * exits non-zero when it finds anything, so we read stdout off the thrown error too. It needs
 * registry access; in an offline container it will fail — we degrade to available:false with a
 * note rather than pretending the tree is clean (no silent "0 vulns").
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Declare categories:['dependency'] on reports so stale-finding reconciliation covers this scanner.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Event-loop hardening (the 07-15 spawnSync wedge class): scanDependencies ran `npm audit` via execFileSync — up to 90s blocking the whole api event loop from the POST /scan handler. Now async (execFile + awaited), with a trivy-style injectable runner so the mapping logic is unit-testable without shelling npm. Same degrade-to-available:false semantics, same timeout/maxBuffer.
 *
 * @module features/security/dependency-scanner
 */

import { execFile } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import type { RawFinding, ScannerReport, Severity } from './types';

const logger = createChildLogger({ module: 'security:dependency-scanner' });

/** npm severity -> our scale (npm has no 'high'->critical split issue; map directly). */
function mapSeverity(npmSev: string): Severity {
  switch ((npmSev || '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'moderate': return 'medium';
    case 'low': return 'low';
    default: return 'info';
  }
}

interface NpmVuln {
  name?: string;
  severity?: string;
  isDirect?: boolean;
  via?: Array<string | { title?: string; url?: string; severity?: string; source?: number }>;
  range?: string;
  fixAvailable?: boolean | { name?: string; version?: string };
}

/**
 * Default runner: `npm audit --json` in `root`, ASYNC (never execFileSync — a 90s sync npm
 * audit on the api event loop is the 07-15 wedge class). Resolves stdout; npm audit exits
 * non-zero when vulns exist, so a failure WITH stdout still resolves with that JSON. Rejects
 * only when there is no usable stdout (offline / npm missing).
 */
function defaultRun(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('npm', ['audit', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout) => {
      if (err && !String(stdout || '').trim()) { reject(err); return; }
      resolve(String(stdout));
    });
  });
}

/**
 * Run `npm audit --json` and turn advisories into findings.
 * @param root - Directory with package.json/lockfile (defaults to scan root / cwd).
 * @param run - Injectable runner (tests) resolving the raw audit JSON; defaults to the async npm shell-out.
 */
export async function scanDependencies(root = process.env.SECURITY_SCAN_ROOT || process.cwd(), run: (root: string) => Promise<string> = defaultRun): Promise<ScannerReport> {
  let raw: string;
  try {
    raw = await run(root);
  } catch (err) {
    const e = err as { message?: string };
    logger.warn({ err }, 'npm audit unavailable');
    return { kind: 'posture', available: false, findings: [], categories: ['dependency'], note: `npm audit could not run (offline or npm missing): ${e.message || 'unknown'}` };
  }

  let parsed: { vulnerabilities?: Record<string, NpmVuln>; error?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'posture', available: false, findings: [], categories: ['dependency'], note: 'npm audit returned unparseable output' };
  }
  if (parsed.error || !parsed.vulnerabilities) {
    return { kind: 'posture', available: false, findings: [], categories: ['dependency'], note: 'npm audit returned no vulnerability data (likely offline)' };
  }

  const findings: RawFinding[] = [];
  for (const [pkg, v] of Object.entries(parsed.vulnerabilities)) {
    const sev = mapSeverity(v.severity || '');
    const advisories = (v.via || []).filter((x): x is { title?: string; url?: string } => typeof x === 'object');
    const titles = advisories.map((a) => a.title).filter(Boolean) as string[];
    const fix = v.fixAvailable === false ? 'no fix available'
      : typeof v.fixAvailable === 'object' && v.fixAvailable?.version ? `fix: ${v.fixAvailable.name}@${v.fixAvailable.version}`
      : 'fix available via npm audit fix';
    findings.push({
      category: 'dependency',
      severity: sev,
      title: `${v.severity || 'unknown'} vulnerability in ${pkg}`,
      detail: `${pkg}${v.range ? ` (${v.range})` : ''} has a known ${v.severity} advisory${v.isDirect ? ' (direct dependency)' : ' (transitive)'}. `
        + (titles.length ? `${titles.slice(0, 3).join('; ')}. ` : '')
        + `${fix}.`,
      source: `package:${pkg}`,
      evidence: { package: pkg, severity: v.severity, isDirect: !!v.isDirect, range: v.range, fixAvailable: v.fixAvailable, advisories: advisories.slice(0, 5) },
      fingerprint: `dependency:${pkg}`,
    });
  }

  return { kind: 'posture', available: true, findings, categories: ['dependency'], note: `npm audit: ${findings.length} vulnerable package(s)` };
}
