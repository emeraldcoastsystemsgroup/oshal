/**
 * Trivy scanner (image scope) — Security Center (ADR-055).
 *
 * Runs Aqua **Trivy** over the platform's own tree in ONE pass covering three supply-chain
 * surfaces — OS/library CVEs (`vuln`), IaC/Dockerfile/compose misconfiguration (`misconfig`),
 * and embedded secrets (`secret`) — and maps every hit to a {@link RawFinding} the Security
 * Center persists + triages like any other finding. It is a pure collector: it shells `trivy`,
 * parses JSON, and returns; the route layer owns persistence, dedup, and escalation.
 *
 * ── Air-gap / FIPS 140-3 / IL6 posture (the whole point) ─────────────────────────────────
 * This is built to run in a DISCONNECTED enclave. It NEVER reaches the internet at scan time:
 *   - `--skip-db-update` + `--skip-java-db-update` — never fetch the vuln DB (use the pre-seeded
 *     cache). The DB is provisioned OUT OF BAND (a mounted `--cache-dir`, or an internal OCI
 *     registry via the `TRIVY_DB_REPOSITORY` / `TRIVY_JAVA_DB_REPOSITORY` env Trivy reads itself).
 *   - `--offline-scan` — no external advisory/API lookups (e.g. Maven Central) during the scan.
 * FIPS is a DEPLOY concern (pin a FIPS-validated `trivy` binary/image); this collector only runs
 * whatever `trivy` is on PATH / at `TRIVY_BIN`. If the DB was never seeded, Trivy fails closed and
 * we report `available:false` with a note — never a silent "0 vulns".
 *
 * The scanner shells the LOCAL `trivy` binary against the filesystem (`trivy fs`), so it needs NO
 * docker socket and NO elevated privilege — the right least-privilege model for IL6. Scanning an
 * arbitrary image (`trivy image`, which needs the socket) is deliberately NOT the default.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — offline/air-gap Trivy fs scan (vuln+misconfig+secret) mapped to Security Center findings with stable, scoped fingerprints; graceful available:false when trivy or its DB is absent; secret VALUES never persisted.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Event-loop hardening (the 07-15 spawnSync wedge class): the default runner used execFileSync with a 15-MINUTE timeout — an image scan froze the entire api event loop for its whole duration. Now async (execFile + awaited); scanTrivy returns a Promise. The injectable `run` accepts sync OR async so existing test injections keep working; degrade semantics (stdout-on-throw, unavailable, unparseable) unchanged.
 *
 * @module features/security/trivy-scanner
 */

import { execFile } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import type { FindingCategory, RawFinding, ScannerReport, Severity } from './types';

const logger = createChildLogger({ module: 'security:trivy-scanner' });

/** Categories Trivy OWNS — kept distinct from the posture scanners so stale-finding
 *  reconciliation only auto-resolves Trivy findings on a run where Trivy actually ran. */
export const TRIVY_CATEGORIES: FindingCategory[] = ['trivy_vuln', 'trivy_misconfig', 'trivy_secret'];

/** Trivy severity string -> our scale. UNKNOWN maps to info (never dropped). */
export function mapTrivySeverity(sev: string): Severity {
  switch ((sev || '').toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    case 'LOW': return 'low';
    default: return 'info';
  }
}

/* ── Trivy JSON result shapes (only the fields we read) ────────────────────────── */

interface TrivyVuln {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  PrimaryURL?: string;
}
interface TrivyMisconfig {
  ID?: string;
  AVDID?: string;
  Title?: string;
  Description?: string;
  Severity?: string;
  Resolution?: string;
  PrimaryURL?: string;
  CauseMetadata?: { StartLine?: number; EndLine?: number };
}
interface TrivySecret {
  RuleID?: string;
  Category?: string;
  Severity?: string;
  Title?: string;
  StartLine?: number;
  EndLine?: number;
  // NOTE: Trivy also returns `Match`/`Code` with the secret VALUE — we NEVER read or persist it.
}
interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Vulnerabilities?: TrivyVuln[];
  Misconfigurations?: TrivyMisconfig[];
  Secrets?: TrivySecret[];
}
interface TrivyReport { Results?: TrivyResult[] }

/** Options for one Trivy scan. All have air-gap-safe defaults. */
export interface TrivyScanOptions {
  /** Binary to invoke (default `TRIVY_BIN` env or `trivy`). */
  bin?: string;
  /** Filesystem target to scan (default `TRIVY_FS_TARGET` / `SECURITY_SCAN_ROOT` / `/app`). */
  target?: string;
  /** Pre-seeded cache dir holding the offline vuln DB (default `TRIVY_CACHE_DIR` if set). */
  cacheDir?: string;
  /** Inject a runner (for tests). Returns raw stdout (sync or async); may throw/reject with
   *  `.stdout` on non-zero exit. */
  run?: (bin: string, args: string[]) => string | Promise<string>;
}

/** Default shell-out runner: `trivy` with a bounded buffer/timeout; JSON stays on stdout.
 *  ASYNC (never execFileSync — a sync 15-minute scan on the api event loop is the 07-15 wedge
 *  class). Mirrors the sync semantics: rejects with `.stdout` attached on non-zero exit. */
function defaultRun(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) { reject(Object.assign(err, { stdout })); return; }
      resolve(String(stdout));
    });
  });
}

/**
 * @description Builds the offline, air-gap-safe Trivy argument vector for an `fs` scan across
 * all three scanners. Exported so a test can assert the no-egress flags are always present.
 * @param target - Filesystem path to scan.
 * @param cacheDir - Optional pre-seeded cache dir.
 * @returns The `trivy` argv (without the binary).
 */
export function buildTrivyArgs(target: string, cacheDir?: string): string[] {
  return [
    'fs',
    '--format', 'json',
    '--quiet',
    '--scanners', 'vuln,misconfig,secret',
    // ── no-egress guarantees (IL6/air-gap) ──
    '--skip-db-update',
    '--skip-java-db-update',
    '--offline-scan',
    ...(cacheDir ? ['--cache-dir', cacheDir] : []),
    target,
  ];
}

/** Maps one Trivy Result's vulns/misconfigs/secrets into findings. */
function mapResult(r: TrivyResult): RawFinding[] {
  const target = r.Target || 'unknown';
  const out: RawFinding[] = [];

  for (const v of r.Vulnerabilities ?? []) {
    const id = v.VulnerabilityID || 'UNKNOWN';
    const pkg = v.PkgName || 'unknown';
    const ver = v.InstalledVersion || '?';
    out.push({
      category: 'trivy_vuln',
      severity: mapTrivySeverity(v.Severity || ''),
      title: `${id} in ${pkg} ${ver}`,
      detail: `${v.Title || id} — ${pkg}@${ver}`
        + (v.FixedVersion ? `, fixed in ${v.FixedVersion}` : ', no fixed version')
        + ` (${target}).`,
      source: `${target}:${pkg}`,
      evidence: {
        vulnerabilityId: id, pkg, installedVersion: ver, fixedVersion: v.FixedVersion,
        target, primaryUrl: v.PrimaryURL,
      },
      fingerprint: `trivy:vuln:${target}:${id}:${pkg}:${ver}`,
    });
  }

  for (const m of r.Misconfigurations ?? []) {
    const id = m.AVDID || m.ID || 'UNKNOWN';
    const line = m.CauseMetadata?.StartLine ?? 0;
    out.push({
      category: 'trivy_misconfig',
      severity: mapTrivySeverity(m.Severity || ''),
      title: `${id}: ${m.Title || 'misconfiguration'}`,
      detail: `${m.Description || m.Title || id} (${target}${line ? `:${line}` : ''}).`
        + (m.Resolution ? ` Fix: ${m.Resolution}` : ''),
      source: `${target}${line ? `:${line}` : ''}`,
      evidence: { id, target, startLine: line, endLine: m.CauseMetadata?.EndLine, primaryUrl: m.PrimaryURL },
      fingerprint: `trivy:misconfig:${target}:${id}:${line}`,
    });
  }

  for (const s of r.Secrets ?? []) {
    const rule = s.RuleID || 'UNKNOWN';
    const line = s.StartLine ?? 0;
    out.push({
      category: 'trivy_secret',
      severity: mapTrivySeverity(s.Severity || 'CRITICAL'),
      // Title/category only — the matched secret VALUE is deliberately never read or stored.
      title: `Secret (${rule}) in ${target}`,
      detail: `${s.Title || s.Category || 'A secret'} detected at ${target}:${line}. Value redacted.`,
      source: `${target}:${line}`,
      evidence: { ruleId: rule, category: s.Category, target, startLine: line, endLine: s.EndLine },
      fingerprint: `trivy:secret:${target}:${rule}:${line}`,
    });
  }

  return out;
}

/**
 * @description Parses a Trivy JSON report string into findings. Pure — exported for tests.
 * @param raw - Trivy `--format json` stdout.
 * @returns Findings across all results, or [] when the report has none.
 * @throws When the JSON is unparseable (caller degrades to available:false).
 */
export function parseTrivyReport(raw: string): RawFinding[] {
  const parsed = JSON.parse(raw) as TrivyReport;
  return (parsed.Results ?? []).flatMap(mapResult);
}

/**
 * @description Runs Trivy offline over the local tree and returns a Security Center report.
 * Degrades to `available:false` (never a silent clean bill) when the binary is missing, the
 * offline DB was never seeded, or the output is unparseable. Reuse the exact flags in
 * {@link buildTrivyArgs} so no scan can accidentally egress.
 * @param opts - Scan options (all air-gap-safe defaults).
 * @returns A ScannerReport of kind 'image'.
 */
export async function scanTrivy(opts: TrivyScanOptions = {}): Promise<ScannerReport> {
  const bin = opts.bin || process.env.TRIVY_BIN || 'trivy';
  const target = opts.target || process.env.TRIVY_FS_TARGET || process.env.SECURITY_SCAN_ROOT || '/app';
  const cacheDir = opts.cacheDir || process.env.TRIVY_CACHE_DIR || undefined;
  const run = opts.run || defaultRun;
  const args = buildTrivyArgs(target, cacheDir);

  let raw: string;
  try {
    raw = await run(bin, args);
  } catch (err) {
    // Trivy exits non-zero when it finds issues (with `--exit-code`) — the JSON is still on
    // stdout. A missing binary / unseeded DB throws WITHOUT usable stdout → unavailable.
    const e = err as { stdout?: string | Buffer; message?: string };
    const stdout = e.stdout ? e.stdout.toString() : '';
    if (stdout.trim().startsWith('{')) {
      raw = stdout;
    } else {
      logger.warn({ err, bin, target }, 'trivy unavailable (binary missing or offline DB not seeded)');
      return {
        kind: 'image', available: false, findings: [], categories: TRIVY_CATEGORIES,
        note: `trivy could not run (binary missing or offline DB not seeded): ${e.message || 'unknown'}`,
      };
    }
  }

  let findings: RawFinding[];
  try {
    findings = parseTrivyReport(raw);
  } catch {
    return { kind: 'image', available: false, findings: [], categories: TRIVY_CATEGORIES, note: 'trivy returned unparseable output' };
  }

  return {
    kind: 'image', available: true, findings, categories: TRIVY_CATEGORIES,
    note: `trivy fs (offline): ${findings.length} finding(s) across vuln/misconfig/secret`,
  };
}
