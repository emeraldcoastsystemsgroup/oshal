import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminDir = path.join(process.cwd(), 'src/pages/admin');

describe('buyer-grade admin console surface', () => {
  it('uses shared glass/theme assets and keeps behavior in external JS', () => {
    const html = readFileSync(path.join(adminDir, 'index.html'), 'utf8');

    expect(html).toContain('/shared/ui/css/surface-glass.css');
    expect(html).toContain('/fonts/codicon.css');
    expect(html).toContain('/admin/admin.css');
    expect(html).toContain('/admin/admin.js');
    expect(html).toContain('data-admin-console="buyer-grade"');
    expect(html).not.toContain('<style>');
  });

  it('covers the buyer-control sections procurement asks for', () => {
    const html = readFileSync(path.join(adminDir, 'index.html'), 'utf8');
    const sections = [
      'identity-rbac',
      'security-posture',
      'tenant-isolation',
      'tenants-users',
      'connectors',
      'tools-approvals',
      'audit-search',
      'cost-governance',
      'procurement-readiness',
    ];

    for (const section of sections) {
      expect(html).toContain(`data-admin-section="${section}"`);
    }
  });

  it('fetches the governance APIs that answer buyer questions', () => {
    const js = readFileSync(path.join(adminDir, 'admin.js'), 'utf8');

    expect(js).toContain('/api/governance/whoami');
    expect(js).toContain('/api/governance/posture');
    expect(js).toContain('/api/connectors/marketplace');
    expect(js).toContain('/api/tenants');
    expect(js).toContain('/api/llm-governance/status');
    expect(js).toContain('/api/governance/readiness');
    expect(js).toContain('/api/governance/audit/export');
  });
});
