/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the four previously invisible route surfaces to executable internal-guard contracts and prove guard removal becomes a route_auth finding.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Registrations are checked against the whole controller composition (every registrar), not server.ts alone, after the 2026-09-24 decomposition moved registrations into server-auxiliary-routes.ts and left this spec red. A new case pins the fail-open it exposed: a contract whose registration lives outside server.ts must still count as active.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  auditRouteSurfaceContracts,
  auditRoutes,
  discoverControllerRegistrars,
  ROUTE_SURFACE_CONTRACTS,
} from '@/features/security';

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_FILE = path.join(ROOT, 'src', 'app', 'server.ts');
const SERVER_SOURCE = fs.readFileSync(SERVER_FILE, 'utf8');
/** Every controller registrar's source, joined: where a registration may legitimately live. */
const COMPOSITION_SOURCE = discoverControllerRegistrars(ROOT).map((registrar) => registrar.text).join('\n');

describe('non-standard route surface inventory', () => {
  it('contains exactly the known helper, mixed-auth, and non-/api blind spots', () => {
    expect(ROUTE_SURFACE_CONTRACTS.map((contract) => contract.route).sort()).toEqual([
      '/api/channels/telegram/webhook',
      '/api/hooks/:provider/:event',
      '/auth/facebook/data-deletion',
      '/node/*',
    ]);
  });

  it('keeps every declared contract tied to a live controller registration', () => {
    for (const contract of ROUTE_SURFACE_CONTRACTS) {
      expect(
        COMPOSITION_SOURCE.includes(contract.registrationMarker),
        `${contract.route} contract is stale or its registration changed without review`,
      ).toBe(true);
    }
  });

  it('has no missing guard markers in the real source tree', () => {
    expect(auditRouteSurfaceContracts(COMPOSITION_SOURCE, ROOT)).toEqual([]);
    const report = auditRoutes(SERVER_FILE);
    expect(report.findings.filter((finding) => finding.fingerprint.startsWith('route_auth:contract:'))).toEqual([]);
    expect(report.note).toContain('4 active non-standard route contracts');
  });

  it('keeps a contract active when its registration lives outside server.ts', () => {
    // The fail-open this pins: activation used to test server.ts source alone, so a registration
    // moved into a registrar module silently switched its contract OFF. At least one contract's
    // registration lives outside server.ts today, and the auditor must still count it active.
    const movedOut = ROUTE_SURFACE_CONTRACTS.filter((contract) => !SERVER_SOURCE.includes(contract.registrationMarker));
    expect(movedOut.length, 'no contract registration lives outside server.ts any more; this pin can be retired').toBeGreaterThan(0);
    const active = auditRouteSurfaceContracts(COMPOSITION_SOURCE, ROOT, movedOut, () => 'guards removed');
    expect(active.map((finding) => finding.fingerprint).sort()).toEqual(
      movedOut.map((contract) => `route_auth:contract:${contract.id}`).sort(),
    );
  });
});

describe('non-standard route contract failure behavior', () => {
  it('raises a high finding when an active route loses its internal guard', () => {
    const contract = ROUTE_SURFACE_CONTRACTS.find((entry) => entry.id === 'node-pool-control-plane')!;
    const findings = auditRouteSurfaceContracts(
      contract.registrationMarker,
      ROOT,
      [contract],
      () => 'export const routerWithoutAuthentication = true;',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'route_auth',
      severity: 'high',
      fingerprint: 'route_auth:contract:node-pool-control-plane',
    });
    expect(findings[0].detail).toContain('router.use(requireServiceSecret);');
  });

  it('does not apply a contract to a surface absent from the supplied composition root', () => {
    expect(auditRouteSurfaceContracts('app.get("/health", handler);', ROOT)).toEqual([]);
  });
});
