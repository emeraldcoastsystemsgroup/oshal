import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ConnectorMarketplaceService } from '../../../src/app/connectors/runtime/marketplace';

describe('ConnectorMarketplaceService', () => {
  it('builds an audited catalog and persists enable/disable state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-marketplace-'));
    const specDir = path.join(root, 'connectors');
    const statePath = path.join(root, 'state', 'marketplace.json');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, 'demo.yaml'),
      [
        'provider: demo',
        'displayName: Demo CRM',
        'version: 1.0.0',
        'metadata:',
        '  tags: [crm, accounts]',
        '  icon: hubspot',
        'baseUrl: https://api.demo.test',
        'auth: { type: apiKeyHeader, header: X-Api-Key }',
        'rateLimit: { burst: 5, perSecond: 2 }',
        'retry: { maxRetries: 1 }',
        'resources:',
        '  - name: list-accounts',
        '    tool: demo-list-accounts',
        '    method: GET',
        '    path: /accounts',
        '  - name: create-account',
        '    tool: demo-create-account',
        '    method: POST',
        '    path: /accounts',
        '    body: { name: "{name}" }',
        '    retry: { maxRetries: 0 }',
      ].join('\n'),
    );

    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath });
      const initial = service.list();
      expect(initial.totals.entries).toBe(1);
      expect(initial.totals.actionCount).toBe(2);
      expect(initial.totals.available).toBe(1);
      expect(initial.entries[0]).toMatchObject({
        id: 'demo',
        label: 'Demo CRM',
        tags: expect.arrayContaining(['crm', 'accounts', 'action:read', 'action:write']),
        icon: 'hubspot',
        authType: 'apiKeyHeader',
        onboarding: {
          mode: 'user-key',
          label: 'User-owned API key',
          credentialScope: 'per-user',
          setupLevel: 'self-serve',
        },
        installState: 'available',
        riskLevel: 'high',
        resourceCount: 2,
        toolCount: 2,
        writeCount: 1,
        destructiveCount: 0,
        actions: expect.arrayContaining([
          expect.objectContaining({ resource: 'list-accounts', actionType: 'read', requiresConfirmation: false }),
          expect.objectContaining({ resource: 'create-account', actionType: 'write', requiresConfirmation: true }),
        ]),
        audit: { pass: true, errors: 0 },
      });
      expect(service.isProviderEnabled('demo')).toBe(false);

      const enabled = service.enableProvider('demo');
      expect(enabled.installState).toBe('enabled');
      expect(service.isProviderEnabled('demo')).toBe(true);

      const removed = service.removeProvider('demo');
      expect(removed.installState).toBe('removed');
      expect(service.isProviderEnabled('demo')).toBe(false);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).removedProviders).toEqual(['demo']);

      const reenabled = service.enableProvider('demo');
      expect(reenabled.installState).toBe('enabled');
      expect(service.isProviderEnabled('demo')).toBe(true);

      const disabled = service.disableProvider('demo');
      expect(disabled.installState).toBe('disabled');
      expect(service.isProviderEnabled('demo')).toBe(false);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).disabledProviders).toEqual(['demo']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('audit-refresh blocks and de-enables a connector that no longer passes the gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-marketplace-'));
    const specDir = path.join(root, 'connectors');
    const statePath = path.join(root, 'state', 'marketplace.json');
    const specPath = path.join(specDir, 'demo.yaml');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      specPath,
      [
        'provider: demo',
        'displayName: Demo CRM',
        'version: 1.0.0',
        'baseUrl: https://api.demo.test',
        'auth: { type: apiKeyHeader, header: X-Api-Key }',
        'rateLimit: { burst: 5, perSecond: 2 }',
        'retry: { maxRetries: 1 }',
        'resources:',
        '  - name: list-accounts',
        '    tool: demo-list-accounts',
        '    method: GET',
        '    path: /accounts',
      ].join('\n'),
    );

    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath });
      expect(service.enableProvider('demo').installState).toBe('enabled');
      fs.writeFileSync(
        specPath,
        [
          'provider: demo',
          'displayName: Demo CRM',
          'version: 1.0.0',
          'baseUrl: https://api.demo.test',
          'auth: { type: apiKeyHeader, header: X-Api-Key }',
          'rateLimit: { burst: 5, perSecond: 2 }',
          'retry: { maxRetries: 1 }',
          'resources:',
          '  - name: a',
          '    tool: dup',
          '    method: GET',
          '    path: /a',
          '  - name: b',
          '    tool: dup',
          '    method: GET',
          '    path: /b',
        ].join('\n'),
      );

      const refreshed = service.refreshProviderAudit('demo');
      expect(refreshed.installState).toBe('blocked');
      expect(refreshed.audit.pass).toBe(false);
      expect(service.isProviderEnabled('demo')).toBe(false);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).enabledProviders).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges generated connector spec directories without duplicating providers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-connector-marketplace-multidir-'));
    const curatedDir = path.join(root, 'curated');
    const generatedDir = path.join(root, 'generated');
    const statePath = path.join(root, 'state.json');
    fs.mkdirSync(curatedDir, { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
    const demoSpec = [
      'provider: demo',
      'displayName: Demo',
      'baseUrl: https://api.demo.test',
      'auth: { type: none }',
      'rateLimit: { burst: 1, perSecond: 1 }',
      'retry: { maxRetries: 1 }',
      'resources:',
      '  - { name: ping, tool: demo-ping, method: GET, path: /ping }',
    ].join('\n');
    fs.writeFileSync(path.join(curatedDir, 'demo.yaml'), demoSpec);
    fs.writeFileSync(path.join(generatedDir, 'demo.yaml'), demoSpec);
    fs.writeFileSync(
      path.join(generatedDir, 'generated.yaml'),
      [
        'provider: generated',
        'displayName: Generated',
        'metadata: { tags: [imported] }',
        'baseUrl: https://api.generated.test',
        'auth: { type: apiKeyHeader, header: X-Api-Key }',
        'rateLimit: { burst: 1, perSecond: 1 }',
        'retry: { maxRetries: 1 }',
        'resources:',
        '  - { name: ping, tool: generated-ping, method: GET, path: /ping }',
      ].join('\n'),
    );

    try {
      const service = new ConnectorMarketplaceService({ specDir: curatedDir, specDirs: [generatedDir], statePath });
      const ids = service.list().entries.map((entry) => entry.id).sort();
      expect(ids).toEqual(['demo', 'generated']);
      expect(service.get('generated')?.tags).toEqual(expect.arrayContaining(['imported']));
      expect(service.get('generated')?.onboarding).toMatchObject({ mode: 'user-key', setupLevel: 'self-serve' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
