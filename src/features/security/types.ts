/**
 * Security Center — shared types (ADR-055).
 *
 * A scanner is a pure collector: it produces `RawFinding`s and never touches the database.
 * The route layer upserts them into `oshal_security_findings` keyed by `fingerprint`, so a
 * re-scan refreshes a finding in place instead of duplicating it. Keep `fingerprint` STABLE
 * across runs for the same underlying issue (location + signature), or dedup breaks.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ScannerReport.categories — posture scanners declare the categories they own so the route layer can auto-resolve findings a fresh scan no longer emits (stale-finding reconciliation).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ScanKind 'image' (Trivy container/fs/config supply-chain scope) + FindingCategories trivy_vuln/trivy_misconfig/trivy_secret. Trivy owns dedicated categories (not the posture ones) so stale-finding reconciliation stays scoped to a run where Trivy actually ran. Air-gap/FIPS: the scanner runs offline (no DB egress) — see trivy-scanner.ts.
 *
 * @module features/security/types
 */

/** The scan scopes the Security Center covers. `image` = Trivy supply-chain (CVE/misconfig/secret). */
export type ScanKind = 'posture' | 'runtime' | 'ledger' | 'audit' | 'image';

/** Finding categories (a finer split than ScanKind; posture and image each fan out). */
export type FindingCategory =
  | 'secret'          // posture: a credential committed / present in a scannable file
  | 'route_auth'      // posture: an Express route mounted without auth
  | 'dependency'      // posture: a dependency with a known advisory
  | 'threat'          // runtime: anomalous bot/tool/auth activity
  | 'ledger'          // money: an anomalous trading/payment/purchase row
  | 'audit'           // access: a cross-app access-control violation
  | 'trivy_vuln'      // image: OS/library CVE found by Trivy (offline DB)
  | 'trivy_misconfig' // image: IaC/Dockerfile/compose misconfiguration found by Trivy
  | 'trivy_secret';   // image: a secret found in the scanned tree by Trivy (value redacted)

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** A single issue a scanner found, before it is persisted. */
export interface RawFinding {
  category: FindingCategory;
  severity: Severity;
  title: string;
  detail: string;
  /** File path / route / table / agent the hit came from. */
  source?: string;
  /** Structured, REDACTED context. NEVER put a live secret value here. */
  evidence?: Record<string, unknown>;
  /** Stable dedup key for this exact issue. */
  fingerprint: string;
}

/** What a scanner reports back about its own run (so the UI can show coverage honestly). */
export interface ScannerReport {
  kind: ScanKind;
  /** false when the scanner could not run (e.g. npm unavailable, table missing). */
  available: boolean;
  findings: RawFinding[];
  /** Human note when unavailable or partial (shown so coverage is never silently dropped). */
  note?: string;
  /**
   * Finding categories this scanner OWNS (not just emitted this run). Set by the posture
   * scanners so the route layer can auto-resolve a previously-open finding that a fresh,
   * successful scan of the same category no longer produces. Event-shaped scanners
   * (runtime/ledger/audit) must leave this unset — their findings describe history, not
   * current state, and are never auto-resolved.
   */
  categories?: FindingCategory[];
}

/** Rank for sorting / "worst severity" rollups. Higher = worse. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};
