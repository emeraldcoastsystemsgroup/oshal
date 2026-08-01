/**
 * Security Center feature (ADR-055) — public surface.
 *
 * A swarm app that scans the platform's OWN security posture and runtime across four scopes:
 *  - posture (active scan): committed secrets, unauthenticated routes, vulnerable dependencies
 *  - runtime (threat detection): anomalous bot/tool/auth activity
 *  - ledger (money anomalies): suspicious trading/purchase rows
 *  - audit (access): dispatch-trail anomalies
 *
 * Each scanner is a pure collector returning a {@link ScannerReport}; the route layer persists
 * the findings and the security-analyst bot triages them. `runScan` is the one-call orchestrator
 * the route uses to run a selected subset of scopes.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | runScan awaits the now-async scanDependencies + scanTrivy (were execFileSync — npm audit blocked the api event loop up to 90s and a trivy image scan up to 15min from the POST /scan handler; the 07-15 spawnSync wedge class). scanSecrets/auditRoutes stay sync (CPU-bound in-process collectors, no shell-out on their hot path).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | runScan accepts optional manifestRoutes (the active app manifests' routes[] flattened to ManifestRouteAuditEntry) and forwards them to auditRoutes — carved apps mount dynamically (ADR-085), so a server.ts-only route audit decays as apps carve. Omission keeps the old server.ts-only behavior for existing callers.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced the hardening middleware presets (webhook HMAC guard, rate-limit presets, global-skip predicate, CSP builder) consumers were deep-importing from ./hardening/*.
 *
 * @module features/security
 */

import type { Pool } from 'pg';
import { scanSecrets } from './secret-scanner';
import { auditRoutes, type ManifestRouteAuditEntry } from './route-audit';
import { scanDependencies } from './dependency-scanner';
import { detectThreats } from './threat-detector';
import { monitorLedgers } from './ledger-monitor';
import { auditAccess } from './audit-trail';
import { scanTrivy } from './trivy-scanner';
import type { ScanKind, ScannerReport } from './types';

export * from './types';
export { scanSecrets, auditRoutes, scanDependencies, detectThreats, monitorLedgers, auditAccess };
export { PUBLIC_BY_DESIGN, type ManifestRouteAuditEntry } from './route-audit';
export { scanTrivy, buildTrivyArgs, parseTrivyReport, mapTrivySeverity, TRIVY_CATEGORIES } from './trivy-scanner';

// FSD deep-import burn-down (2026-07-24): hardening middleware presets surfaced through the barrel.
export { hmacWebhookGuard } from './hardening/webhook-hmac';
export { makeLimiter, internalMeshLimiter, expensiveOpLimiter } from './hardening/rate-limit-presets';
export {
  createGlobalJsonParser,
  isReservedBodyParserPath,
  jsonBodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  RESERVED_BODY_PARSER_PREFIXES,
} from './hardening/body-limits';
export { shouldSkipGlobalRateLimit } from './hardening/global-rate-limit-skip';
export {
  cspFromEnv,
  cspMode,
  buildStrictCsp,
  shouldLogCspReport,
  resetCspReportDedupe,
  DEFAULT_CSP_REPORT_URI,
  type CspMode,
  type CspHelmetValue,
  type StrictCspOptions,
} from './hardening/strict-csp';

export const ALL_KINDS: ScanKind[] = ['posture', 'runtime', 'ledger', 'audit', 'image'];

/**
 * Run the selected scan scopes and return one report per scanner that ran.
 * `posture` fans out to three collectors (secrets + routes + deps); `image` runs Trivy
 * (offline vuln/misconfig/secret); the others are one each.
 *
 * @param pool - Postgres pool (for the runtime/ledger/audit detectors).
 * @param sub  - The signed-in operator's OIDC sub (owner-scopes the ledger reads).
 * @param kinds - Which scopes to run (defaults to all).
 * @param manifestRoutes - Active app manifests' route declarations for the route audit
 *   (ADR-085 dynamic mounts are invisible to a server.ts scan). Omit ⇒ server.ts-only.
 */
export async function runScan(
  pool: Pool,
  sub: string,
  kinds: ScanKind[] = ALL_KINDS,
  manifestRoutes?: ManifestRouteAuditEntry[],
): Promise<ScannerReport[]> {
  const want = new Set(kinds);
  const reports: ScannerReport[] = [];

  if (want.has('posture')) {
    // scanSecrets/auditRoutes are synchronous CPU-bound in-process collectors; run them inline.
    reports.push(scanSecrets());
    reports.push(auditRoutes(undefined, manifestRoutes));
    // scanDependencies shells `npm audit` — ASYNC + awaited so the (up to 90s) child process
    // never blocks the api event loop (the 07-15 spawnSync wedge class).
    reports.push(await scanDependencies());
  }
  // Trivy shells out (offline, up to 15min) — async + awaited for the same reason; it
  // self-degrades to available:false when the binary or its pre-seeded DB is absent, so this
  // is safe to run even where Trivy isn't installed.
  if (want.has('image')) reports.push(await scanTrivy());
  if (want.has('runtime')) reports.push(await detectThreats(pool));
  if (want.has('ledger')) reports.push(await monitorLedgers(pool, sub));
  if (want.has('audit')) reports.push(await auditAccess(pool));

  return reports;
}
