import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorMarketplaceService } from '../../../src/app/connectors/runtime/marketplace';
import { buildConnectorAuditExport, connectorAuditExportCsv } from '../../../src/app/routes/connector-marketplace-routes';

describe('connector marketplace audit export', () => {
  it('exports audit, risk, source, and onboarding data for operators', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-audit-export-'));
    const specDir = path.join(root, 'connectors');
    const statePath = path.join(root, 'state.json');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, 'demo.yaml'),
      [
        'provider: demo',
        'displayName: Demo Service',
        'baseUrl: https://api.demo.test',
        'auth: { type: oauth2, scopes: [read:demo] }',
        'rateLimit: { burst: 2, perSecond: 1 }',
        'retry: { maxRetries: 1 }',
        'resources:',
        '  - { name: list-items, tool: demo-list-items, method: GET, path: /items }',
      ].join('\n'),
    );

    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath });
      const exported = buildConnectorAuditExport(service.list());
      expect(exported.totals.entries).toBe(1);
      expect(exported.entries[0]).toMatchObject({
        id: 'demo',
        label: 'Demo Service',
        authType: 'oauth2',
        onboarding: {
          mode: 'oauth-app',
          setupLevel: 'operator-assisted',
          credentialScope: 'per-user',
        },
        audit: { pass: true, errors: 0 },
      });

      const csv = connectorAuditExportCsv(exported);
      expect(csv).toContain('id,label,category,installState,enabled,riskLevel,authType');
      // 'Uncategorized', not 'General': this fixture spec declares no category and carries no
      // signal that identifies a provider, and the catalog no longer invents a plausible shelf
      // label for that case — it says so, and logs it (src/app/connectors/runtime/curation.ts).
      expect(csv).toContain('demo,Demo Service,Uncategorized,available,false,medium,oauth2');
      expect(csv).toContain('oauth-app,operator-assisted,per-user');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
