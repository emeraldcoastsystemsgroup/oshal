/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the four previously invisible route surfaces to executable internal-guard contracts and prove guard removal becomes a route_auth finding.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  auditRouteSurfaceContracts,
  auditRoutes,
  ROUTE_SURFACE_CONTRACTS,
} from '@/features/security';

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_FILE = path.join(ROOT, 'src', 'app', 'server.ts');
const SERVER_SOURCE = fs.readFileSync(SERVER_FILE, 'utf8');

describe('non-standard route surface inventory', () => {
  it('contains exactly the known helper, mixed-auth, and non-/api blind spots', () => {
    expect(ROUTE_SURFACE_CONTRACTS.map((contract) => contract.route).sort()).toEqual([
      '/api/channels/telegram/webhook',
      '/api/hooks/:provider/:event',
      '/auth/facebook/data-deletion',
      '/node/*',
    ]);
  });

  it('keeps every declared contract tied to a live server registration', () => {
    for (const contract of ROUTE_SURFACE_CONTRACTS) {
      expect(
        SERVER_SOURCE.includes(contract.registrationMarker),
        `${contract.route} contract is stale or its registration changed without review`,
      ).toBe(true);
    }
  });

  it('has no missing guard markers in the real source tree', () => {
    expect(auditRouteSurfaceContracts(SERVER_SOURCE, ROOT)).toEqual([]);
    const report = auditRoutes(SERVER_FILE);
    expect(report.findings.filter((finding) => finding.fingerprint.startsWith('route_auth:contract:'))).toEqual([]);
    expect(report.note).toContain('4 active non-standard route contracts');
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
