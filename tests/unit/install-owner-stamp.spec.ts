/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove an unowned app load adopts the deployment's install owner while any existing owner is left alone — the rule that keeps person-scoped packages staged before first login from being invisible to everyone.
 */
import { describe, expect, it } from 'vitest';

import { withInstallOwner } from '@/features/swarm-apps/services/swarm-app-service';

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
