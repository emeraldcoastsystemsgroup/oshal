/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove an unowned app load adopts the deployment's install owner while any existing owner is left alone — the rule that keeps person-scoped packages staged before first login from being invisible to everyone.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The adopting owner becomes the application's administrator exactly once, never over an existing tier, and a failed grant never fails the load: an operator who held no tier saw none of the 58 protected applications on a fresh install.
 */
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { AppAccessService } from '@/features/swarm-apps/services/app-access-service';
import { adoptedInstallOwner, grantInstallOwnerAdmin, withInstallOwner } from '@/features/swarm-apps/services/install-owner';

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
    expect(sql).toContain('ON CONFLICT (user_sub, app_name) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(params.slice(0, 4)).toEqual([OWNER, 'cad-studio', 'admin', OWNER]);
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
