/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove an unowned app load adopts the deployment's install owner while any existing owner is left alone — the rule that keeps person-scoped packages staged before first login from being invisible to everyone.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The adopting owner becomes the application's administrator exactly once, never over an existing tier, and a failed grant never fails the load: an operator who held no tier saw none of the 58 protected applications on a fresh install.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | The grant is issuer-keyed after migration 145: it conflicts on (user_sub, app_name, principal_issuer) and names the issuer the owner signs in under, because a row written against the wrong issuer resolves for nobody.
 */
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { AppAccessService } from '@/features/swarm-apps/services/app-access-service';
import { adoptedInstallOwner, grantInstallOwnerAdmin, installOwnerIssuer, withInstallOwner } from '@/features/swarm-apps/services/install-owner';

const OWNER = 'local-465e37a0f03a4012';

describe('install owner stamping', () => {
  it('adopts the install owner when the row has none', () => {
    expect(withInstallOwner(undefined, null, OWNER)).toEqual({ ownerSub: OWNER });
    expect(withInstallOwner({ scope: 'person' }, null, OWNER)).toEqual({ scope: 'person', ownerSub: OWNER });
  });

  it('never restamps a row that already names an owner', () => {
    // An explicit publish outranks the install default, and the upsert would otherwise
    // overwrite the real owner on every boot.
    expect(withInstallOwner(undefined, 'local-someone-else', OWNER)).toBeUndefined();
    expect(withInstallOwner({ scope: 'person', ownerSub: 'local-publisher' }, null, OWNER))
      .toEqual({ scope: 'person', ownerSub: 'local-publisher' });
  });

  it('leaves scope untouched when no install owner is configured', () => {
    for (const configured of [undefined, '', '   ']) {
      expect(withInstallOwner(undefined, null, configured)).toBeUndefined();
      expect(withInstallOwner({ scope: 'public' }, null, configured)).toEqual({ scope: 'public' });
    }
  });
});

describe('install owner adoption', () => {
  it('names the owner only when this load adopted the row', () => {
    expect(adoptedInstallOwner(undefined, { ownerSub: OWNER })).toBe(OWNER);
    // The caller published with its own owner: nothing was adopted.
    expect(adoptedInstallOwner({ ownerSub: 'local-publisher' }, { ownerSub: 'local-publisher' })).toBeNull();
    // A later boot: the owner was already stored, so withInstallOwner persisted nothing new.
    expect(adoptedInstallOwner(undefined, undefined)).toBeNull();
  });
});

describe('install owner administrator grant', () => {
  const poolReturning = (rowCount: number) => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount });
    return { access: new AppAccessService({ query } as unknown as Pool), query };
  };

  it('grants admin without overriding an existing tier', async () => {
    const { access, query } = poolReturning(1);
    await expect(grantInstallOwnerAdmin(access, 'cad-studio', OWNER)).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    // Keyed by (subject, issuer) since migration 145: a grant on the subject-only key would
    // resolve for nobody, and DO UPDATE would overwrite a tier someone set.
    expect(sql).toContain('ON CONFLICT (user_sub, app_name, principal_issuer) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(params.slice(0, 4)).toEqual([OWNER, 'cad-studio', 'admin', OWNER]);
    expect(params[5]).toBe('urn:oshal:local-auth');
  });

  it('names the issuer the owner actually signs in under', () => {
    const saved = { issuer: process.env.OSHAL_INSTALL_OWNER_ISSUER, mock: process.env.MOCK_OIDC };
    try {
      delete process.env.OSHAL_INSTALL_OWNER_ISSUER; delete process.env.MOCK_OIDC;
      expect(installOwnerIssuer()).toBe('urn:oshal:local-auth');
      process.env.MOCK_OIDC = 'true';
      expect(installOwnerIssuer()).toBe('urn:oshal:mock-oidc');
      process.env.OSHAL_INSTALL_OWNER_ISSUER = 'https://accounts.example.test';
      expect(installOwnerIssuer()).toBe('https://accounts.example.test');
    } finally {
      if (saved.issuer === undefined) delete process.env.OSHAL_INSTALL_OWNER_ISSUER; else process.env.OSHAL_INSTALL_OWNER_ISSUER = saved.issuer;
      if (saved.mock === undefined) delete process.env.MOCK_OIDC; else process.env.MOCK_OIDC = saved.mock;
    }
  });

  it('reports nothing granted when a tier already exists', async () => {
    const { access } = poolReturning(0);
    await expect(grantInstallOwnerAdmin(access, 'cad-studio', OWNER)).resolves.toBe(false);
  });

  it('never throws — a boot must not die over a grant the cockpit can make by hand', async () => {
    const access = { grantIfAbsent: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    await expect(grantInstallOwnerAdmin(access, 'cad-studio', OWNER)).resolves.toBe(false);
  });
});
