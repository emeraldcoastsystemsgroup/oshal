/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavior guard for the async conversion of scanDependencies (was execFileSync `npm audit` — up to 90s blocking the api event loop from POST /scan; the 07-15 wedge class). Proves via the injected runner: advisories map to findings, a rejecting runner degrades to available:false (never a silent clean bill), unparseable/empty audit output degrades honestly.
 */

import { describe, expect, it } from 'vitest';
import { scanDependencies } from '../../src/features/security/dependency-scanner';

const AUDIT_JSON = JSON.stringify({
  vulnerabilities: {
    'left-pad': {
      name: 'left-pad', severity: 'high', isDirect: true, range: '<1.0.1',
      via: [{ title: 'padding overflow', url: 'https://example.test/adv', severity: 'high' }],
      fixAvailable: { name: 'left-pad', version: '1.0.1' },
    },
    'tiny-lib': { name: 'tiny-lib', severity: 'low', isDirect: false, via: ['left-pad'], range: '*', fixAvailable: false },
  },
});

describe('dependency scanner — async npm audit (07-15 wedge-class conversion)', () => {
  it('maps advisories to findings through the async runner', async () => {
    const rep = await scanDependencies('/scan-root', async (root) => {
      expect(root).toBe('/scan-root');
      return AUDIT_JSON;
    });
    expect(rep.available).toBe(true);
    expect(rep.kind).toBe('posture');
    expect(rep.findings).toHaveLength(2);
    const byPkg = Object.fromEntries(rep.findings.map((f) => [(f.evidence as { package?: string }).package, f]));
    expect(byPkg['left-pad'].severity).toBe('high');
    expect(byPkg['left-pad'].title).toContain('left-pad');
    expect(byPkg['left-pad'].detail).toContain('fix: left-pad@1.0.1');
    expect(byPkg['left-pad'].fingerprint).toBe('dependency:left-pad');
    expect(byPkg['tiny-lib'].severity).toBe('low');
    expect(byPkg['tiny-lib'].detail).toContain('no fix available');
  });

  it('degrades to available:false when the runner rejects (npm missing / offline) — never a silent clean bill', async () => {
    const rep = await scanDependencies('/scan-root', () => Promise.reject(new Error('spawn npm ENOENT')));
    expect(rep.available).toBe(false);
    expect(rep.findings).toEqual([]);
    expect(rep.categories).toEqual(['dependency']);
    expect(rep.note).toMatch(/could not run/i);
    expect(rep.note).toContain('ENOENT');
  });

  it('degrades to available:false on unparseable audit output', async () => {
    const rep = await scanDependencies('/scan-root', async () => 'not json');
    expect(rep.available).toBe(false);
    expect(rep.note).toMatch(/unparseable/i);
  });

  it('degrades to available:false when audit returns no vulnerability data (likely offline)', async () => {
    const rep = await scanDependencies('/scan-root', async () => JSON.stringify({ error: { code: 'ENOAUDIT' } }));
    expect(rep.available).toBe(false);
    expect(rep.note).toMatch(/no vulnerability data/i);
  });
});
