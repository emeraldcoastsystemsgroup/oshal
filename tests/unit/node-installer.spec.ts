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
    expect(script).toContain('-EnrollmentToken $NodeToken');
    // The device id travels as a PARAMETER, not an env var — nothing ever read the env
    // var the first version set, which is how the id mismatch survived to a live run.
    expect(script).toContain('-ClientId $ClientId');
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

describe('the installer the download actually invokes', () => {
  const installer = () => import('fs').then((fs) => fs.promises.readFile(
    'installer/lib/install-node.ps1', 'utf8'));

  it('accepts a URL plus an enrollment token as a COMPLETE target', async () => {
    // The defect this exists for: the download was refused by the script it invokes.
    // Resolve-JoinTarget knew a join code, or a URL plus the SWARM-WIDE secret — the one
    // thing the one-click file deliberately does not carry — and nothing else. Every unit
    // test passed, because they all tested the renderer and none ran the installer.
    const source = await installer();
    const resolver = source.slice(
      source.indexOf('function Resolve-JoinTarget'),
      source.indexOf('function Connect-Tailnet'));
    expect(resolver).toContain('$ControlPlaneUrl -and $EnrollmentToken');
    // ...and the token must land in the slot the node sends as its bearer credential
    // (config.sharedSecret, see mesh-client.ts), or it authenticates nothing.
    const tokenBranch = resolver.slice(resolver.indexOf('$ControlPlaneUrl -and $EnrollmentToken'));
    expect(tokenBranch).toMatch(/SharedSecret\s*=\s*\$EnrollmentToken/);
  });

  it('still accepts the two older forms, so existing installs keep working', async () => {
    const source = await installer();
    expect(source).toContain('if ($JoinCode) {');
    expect(source).toContain('$ControlPlaneUrl -and $SharedSecret');
  });

  it('names the token form in its own refusal, so the dead end is escapable', async () => {
    const source = await installer();
    const refusal = source.slice(source.indexOf('Stop-WithError "No join code supplied."'));
    expect(refusal.slice(0, 300)).toMatch(/one-click|Set up this computer/i);
  });
});

describe('the generated script does not promise what it cannot do', () => {
  it('refuses plainly when it is not in an Open Swarm folder', () => {
    const script = renderNodeInstaller(VALID);
    // The first version fetched an install script from a route that never existed — and
    // even fetching it would have died on the missing packages/oshal-chat. A refusal that
    // names the requirement beats getting one step further and failing anyway.
    expect(script).not.toContain('Invoke-WebRequest');
    expect(script).not.toContain('/api/join/install-node.ps1');
    expect(script).toMatch(/Move this file into your Open Swarm folder/);
    expect(script).toContain('exit 1');
  });
});

describe('the device id the token is bound to reaches the node', () => {
  it('is passed to the installer, which passes it to the app', async () => {
    // The last blocker, and the one only a live run found: the node minted its OWN
    // `oshal-chat-<uuid>` on first launch, so the control plane refused every one-click
    // enrolment with "node-bound token named a different device". A bound token names the
    // device it may register as; the node has to adopt that id, not invent one.
    const script = renderNodeInstaller(VALID);
    expect(script).toContain('-ClientId $ClientId');

    const fs = await import('fs');
    const installer = await fs.promises.readFile('installer/lib/install-node.ps1', 'utf8');
    expect(installer).toContain('[string]$ClientId');
    expect(installer).toContain('$env:OSHAL_CLIENT_ID = $ClientId');

    const config = await fs.promises.readFile(
      'packages/oshal-chat/src/main/config.ts', 'utf8');
    expect(config).toContain('OSHAL_CLIENT_ID');
    expect(config).toMatch(/seed\.clientId = OSHAL_CLIENT_ID/);
  });
});
