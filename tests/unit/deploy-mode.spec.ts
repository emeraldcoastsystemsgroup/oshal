/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 guard. The composition is the thing most likely to be got wrong, so the mode table is tested AS a table. The cases that matter are the ones that currently fail open and silently: MOCK_OIDC on a deployment that serves other people, a mode that promises off-LAN reach with no overlay configured, and node tokens left optional while the retired swarm-wide shared secret is still accepted. Also pinned: an UNSET mode changes nothing and raises no violation, because a default chosen here would silently re-posture every existing box - the exact failure the mechanism exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  DEPLOY_MODES,
  deployViolationError,
  describeDeployment,
  detectMode,
  parseDeployMode,
  postureFor,
  resolveDeployPosture,
  type DeployMode,
} from '@/shared/deploy-mode';

/** A minimal coherent environment for each mode, so a test states only its deviation. */
const COHERENT: Record<DeployMode, NodeJS.ProcessEnv> = {
  demo: { OSHAL_DEPLOY_MODE: 'demo', MOCK_OIDC: 'true' },
  home: { OSHAL_DEPLOY_MODE: 'home', LOCAL_AUTH: 'true', REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'true' },
  connected: {
    OSHAL_DEPLOY_MODE: 'connected',
    LOCAL_AUTH: 'true',
    REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'true',
    HEADSCALE_URL: 'https://headscale.internal',
  },
  tenant: {
    OSHAL_DEPLOY_MODE: 'tenant',
    OIDC_ISSUER_BASE_URL: 'https://idp.example.com',
    REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'true',
  },
};

describe('deploy modes (ADR-137)', () => {
  it('every declared mode has a coherent environment that boots', () => {
    for (const mode of DEPLOY_MODES) {
      const resolved = resolveDeployPosture(COHERENT[mode]);
      expect(resolved.mode, mode).toBe(mode);
      expect(resolved.violations, `${mode} should be coherent`).toEqual([]);
      expect(deployViolationError(resolved), mode).toBeNull();
    }
  });

  it('an unset mode changes nothing and raises no violation', () => {
    // Load-bearing: choosing a default here would silently re-posture every
    // existing deployment, which is what this mechanism exists to prevent.
    const resolved = resolveDeployPosture({ MOCK_OIDC: 'true' });
    expect(resolved.advisory).toBe(true);
    expect(resolved.mode).toBeNull();
    expect(resolved.violations).toEqual([]);
    expect(describeDeployment(resolved)).toMatch(/behaviour unchanged/);
    expect(describeDeployment(resolved)).toMatch(/looks like 'demo'/);
  });

  it('refuses open auth in every mode that serves someone else', () => {
    for (const mode of ['home', 'connected', 'tenant'] as DeployMode[]) {
      const resolved = resolveDeployPosture({ ...COHERENT[mode], MOCK_OIDC: 'true' });
      const violation = resolved.violations.find((v) => v.setting === 'MOCK_OIDC');
      expect(violation, `${mode} must refuse MOCK_OIDC`).toBeTruthy();
      expect(violation?.reason).toMatch(/publicly callable/);
      expect(deployViolationError(resolved)?.message).toContain('MOCK_OIDC');
    }
    // ...and permits it in the one mode where it is the point.
    expect(resolveDeployPosture(COHERENT.demo).violations).toEqual([]);
  });

  it('refuses a tenant deployment with no identity provider', () => {
    const resolved = resolveDeployPosture({
      OSHAL_DEPLOY_MODE: 'tenant', REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'true',
    });
    expect(resolved.violations.map((v) => v.setting)).toContain('OIDC_ISSUER_BASE_URL');
  });

  it('refuses tenancy enforcement being explicitly switched off in tenant mode', () => {
    const resolved = resolveDeployPosture({ ...COHERENT.tenant, MULTI_TENANT_ENABLED: 'false' });
    expect(resolved.violations.map((v) => v.setting)).toContain('MULTI_TENANT_ENABLED');
  });

  it('refuses connected mode with no overlay configured', () => {
    // The failure this prevents: an off-LAN join request silently emitting a
    // LAN-only code because the overlay was never there.
    const resolved = resolveDeployPosture({
      OSHAL_DEPLOY_MODE: 'connected', LOCAL_AUTH: 'true', REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'true',
    });
    const violation = resolved.violations.find((v) => v.setting === 'HEADSCALE_URL');
    expect(violation).toBeTruthy();
    expect(violation?.reason).toMatch(/other networks/);
  });

  it('reports an optional node token as a deviation rather than failing the boot', () => {
    // Legitimate during re-enrolment, and never silent: the retired swarm-wide
    // shared secret still authenticates nodes while this is false.
    const resolved = resolveDeployPosture({ ...COHERENT.home, REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'false' });
    expect(resolved.violations).toEqual([]);
    const deviation = resolved.deviations.find((d) => d.setting === 'REMOTE_CLIENT_REQUIRE_NODE_TOKEN');
    expect(deviation?.note).toMatch(/shared secret/);
  });

  it('rejects an unrecognized mode instead of falling back to unset', () => {
    // Falling back would let a deployer believe they had declared a posture.
    const resolved = resolveDeployPosture({ OSHAL_DEPLOY_MODE: 'prod' });
    expect(resolved.advisory).toBe(false);
    expect(resolved.violations[0].setting).toBe('OSHAL_DEPLOY_MODE');
    expect(resolved.violations[0].reason).toMatch(/demo, home, connected, tenant/);
  });

  it('names its assertions at boot, not just the mode', () => {
    const line = describeDeployment(resolveDeployPosture(COHERENT.tenant));
    expect(line).toContain("deploy mode 'tenant'");
    expect(line).toContain('openAuth=refused');
    expect(line).toContain('idp=required');
    expect(line).toContain('nodeToken=required');
    expect(line).toContain('multiTenant=true');
  });

  it('detects the shape of an undeclared environment', () => {
    expect(detectMode({ MOCK_OIDC: 'true' })).toBe('demo');
    expect(detectMode({ OIDC_ISSUER_BASE_URL: 'https://idp' })).toBe('tenant');
    expect(detectMode({ LOCAL_AUTH: 'true', HEADSCALE_URL: 'https://hs' })).toBe('connected');
    expect(detectMode({ LOCAL_AUTH: 'true' })).toBe('home');
    // LOCAL_AUTH with an IdP configured is a LOCAL_AUTH box, not a tenant one.
    expect(detectMode({ LOCAL_AUTH: 'true', OIDC_ISSUER_BASE_URL: 'https://idp' })).toBe('home');
  });

  it('parses modes and treats blank as unset', () => {
    expect(parseDeployMode(undefined)).toBeNull();
    expect(parseDeployMode('   ')).toBeNull();
    expect(parseDeployMode('TENANT')).toBe('tenant');
    expect(parseDeployMode('nope')).toBe('invalid');
  });

  it('postures are copies, so a caller cannot mutate the table', () => {
    const first = postureFor('demo');
    first.openAuthAllowed = false;
    expect(postureFor('demo').openAuthAllowed).toBe(true);
  });

  it('only demo permits open auth, and only tenant is multi-tenant', () => {
    const open = DEPLOY_MODES.filter((m) => postureFor(m).openAuthAllowed);
    expect(open).toEqual(['demo']);
    const multi = DEPLOY_MODES.filter((m) => postureFor(m).multiTenant);
    expect(multi).toEqual(['tenant']);
  });
});
