/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: guard mode fail-closure and prove every core install/update/native boundary invokes the canonical audited installer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolvePackageAuditMode } from '../../src/features/swarm-apps';
import { installerLogTail } from '../../src/app/routes/update-check-cron';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('APP-02 mode boundary', () => {
  it('defaults compatible and fails closed on unknown configuration', () => {
    expect(resolvePackageAuditMode(undefined)).toBe('compatible');
    expect(resolvePackageAuditMode(' ENFORCE ')).toBe('enforce');
    expect(() => resolvePackageAuditMode('observe')).toThrow(/compatible or enforce/);
  });

  it('forwards the same validated mode through registry and update installer children', () => {
    for (const path of ['src/app/routes/app-store-remote.ts', 'src/app/routes/update-check-cron.ts']) {
      const text = source(path);
      expect(text).toContain('const auditMode = resolvePackageAuditMode();');
      expect(text).toContain('OSHAL_PACKAGE_AUDIT_MODE: auditMode');
    }
    expect(source('docker-compose.oshal-local.yml'))
      .toContain('OSHAL_PACKAGE_AUDIT_MODE: ${OSHAL_PACKAGE_AUDIT_MODE:-compatible}');
  });

  it('retains the explicit unverified warning in a bounded API log tail', () => {
    const output = [
      'WARNING: sample-app is NOT AUDIT-VERIFIED; compatible mode grants no pin.',
      ...Array.from({ length: 20 }, (_, index) => `validation line ${index}`),
    ].join('\n');
    const tail = installerLogTail(output, 'secret-not-present');
    expect(tail).toContain('NOT AUDIT-VERIFIED');
    expect(tail.split('\n').length).toBeLessThanOrEqual(16);
  });
});

describe('codebase-free installers share the audited CLI', () => {
  it('routes Bash and PowerShell staging through oshal-app install without raw package copying', () => {
    const bash = source('scripts/oshal-install.sh');
    const powershell = source('scripts/oshal-install.ps1');
    for (const text of [bash, powershell]) {
      expect(text).toContain('/app/scripts/oshal-app.js install');
      expect(text).toContain('OSHAL_PACKAGE_AUDIT_MODE');
      expect(text).toContain('--audit-mode');
      expect(text).not.toContain('cp -r /src /ws/deployed-apps');
      expect(text).not.toContain('codeload.github.com/emeraldcoastsystemsgroup/oshal-apps');
    }
    expect(bash).toContain('INSTALL_ENV+=(-e OSHAL_STORE_TOKEN)');
    expect(powershell).toContain("$installEnv += @('-e', 'OSHAL_STORE_TOKEN')");
    expect(source('Dockerfile.oshal')).toContain('COPY scripts/oshal-*.js ./scripts/');
  });
});
