/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the one-click node installer: no swarm-wide secret in the download, a refusal when a per-device token would not be enough, and no way to break out of a PowerShell literal.
 */

/**
 * Guards for the one-click worker-node installer.
 *
 * This route hands a person a file with a credential in it, so the interesting assertions are
 * about what the file must NOT contain and when the route must refuse rather than help.
 */
import { describe, expect, it } from 'vitest';
import { renderNodeInstaller } from '@/app/routes/node-installer-routes';
import { sharedSecretRetired } from '@/features/remote-client';

const VALID = {
  controlPlaneUrl: 'http://192.168.1.5:35457',
  token: 'oshal_pat_AbCdEf0123456789-_',
  clientId: 'node-2f1c9e2a-0000-4a1b-9c3d-5e6f70819200',
  nodeName: 'roger-laptop',
};

describe('the one-click node installer script', () => {
  it('carries the device credential and the control plane, ready to run', () => {
    const script = renderNodeInstaller(VALID);
    expect(script).toContain(VALID.token);
    expect(script).toContain(VALID.controlPlaneUrl);
    expect(script).toContain(VALID.clientId);
    // The two env vars are what make the node authenticate AND register owned.
    expect(script).toContain('REMOTE_CLIENT_CONTROL_PLANE_TOKEN');
    expect(script).toContain('REMOTE_CLIENT_CLIENT_ID');
    expect(script).toContain('-EnrollmentToken $NodeToken');
    // Windows line endings: a LF-only .ps1 still runs, but every editor the operator opens
    // it in shows one long line, and this file is meant to be read before it is trusted.
    expect(script).toContain('\r\n');
  });

  it('tells the person what they are holding', () => {
    const script = renderNodeInstaller(VALID);
    // A file containing a credential must say so. The autofill bookmarklet set this
    // precedent in career-hunter; the rule is the same wherever we hand one over.
    expect(script).toMatch(/YOUR credential/i);
    expect(script).toMatch(/do not share/i);
    expect(script).toMatch(/revoke/i);
  });

  it('never puts a swarm-wide credential in a per-user download', () => {
    const script = renderNodeInstaller(VALID);
    // The whole reason this route can be non-operator: the file is worth exactly one
    // device. A join code (OSJOIN1.*) or a shared secret here would be worth every node.
    expect(script).not.toContain('OSJOIN1');
    expect(script).not.toMatch(/SharedSecret/i);
    expect(script).not.toMatch(/REMOTE_CLIENT_SHARED_SECRET/);
    expect(script).not.toContain('-JoinCode');
  });

  it('refuses to render rather than escape its way out of a quoted literal', () => {
    // Every value is server-produced, so a quote means something upstream is wrong. The
    // alternative — escaping — is the version that ships a subtle injection the day some
    // upstream value starts carrying a user's text.
    for (const field of ['controlPlaneUrl', 'token', 'clientId', 'nodeName'] as const) {
      for (const bad of ["'", '"', '`', '$', '\n', '\\']) {
        expect(() => renderNodeInstaller({ ...VALID, [field]: VALID[field] + bad }))
          .toThrow(/quotable character/);
      }
    }
  });

  it('does not smuggle a second command past the installer invocation', () => {
    const script = renderNodeInstaller(VALID);
    const invocation = script.split('\r\n').find((line) => line.startsWith('& $installer'));
    expect(invocation).toBeTruthy();
    // The call site must reference variables, never interpolate the values again — that is
    // what keeps the one escaping decision in one place.
    expect(invocation).not.toContain(VALID.token);
    expect(invocation).toContain('$NodeToken');
  });
});

describe('the precondition the installer depends on', () => {
  it('reads the fail-closed switch that retires the swarm-wide secret', () => {
    // The download is only safe to hand a non-operator because a per-device token is
    // SUFFICIENT. That is exactly what this flag decides, so the route consults it.
    for (const on of ['true', '1', 'on', 'yes']) {
      expect(sharedSecretRetired({ REMOTE_CLIENT_REQUIRE_NODE_TOKEN: on } as NodeJS.ProcessEnv))
        .toBe(true);
    }
    for (const off of ['', 'false', '0', 'no', undefined as unknown as string]) {
      expect(sharedSecretRetired({ REMOTE_CLIENT_REQUIRE_NODE_TOKEN: off } as NodeJS.ProcessEnv))
        .toBe(false);
    }
  });

  it('is wired into the route module, so the refusal cannot be dropped silently', async () => {
    const source = await import('fs').then((fs) => fs.promises.readFile(
      'src/app/routes/node-installer-routes.ts', 'utf8'));
    expect(source).toContain('sharedSecretRetired()');
    expect(source).toContain('node_token_not_required');
    // ...and a loopback control plane is refused too: a localhost URL in a downloaded
    // installer points the NEW computer at itself.
    expect(source).toContain('loopback_control_plane');
  });
});
