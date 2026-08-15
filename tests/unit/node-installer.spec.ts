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
import { nodePackageSpec, renderNodeInstaller } from '@/app/routes/node-installer-routes';
import { sharedSecretRetired } from '@/features/remote-client';

const VALID = {
  controlPlaneUrl: 'http://192.168.1.5:35457',
  token: 'oshal_pat_AbCdEf0123456789-_',
  clientId: 'node-2f1c9e2a-0000-4a1b-9c3d-5e6f70819200',
  nodeName: 'roger-laptop',
  nodePackage: '@oshal/chat',
};

describe('the one-click node installer script', () => {
  it('carries the device credential and the control plane, ready to run', () => {
    const script = renderNodeInstaller(VALID);
    expect(script).toContain(VALID.token);
    expect(script).toContain(VALID.controlPlaneUrl);
    expect(script).toContain(VALID.clientId);
    // Seeded as environment, which is what the app's ConfigStore reads on first launch.
    expect(script).toContain('OSHAL_ENROLLMENT_TOKEN');
    expect(script).toContain('OSHAL_CLIENT_ID');
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

  it('never re-interpolates a value at the call site', () => {
    const script = renderNodeInstaller(VALID);
    const invocation = script.split('\r\n').find((line) => line.includes('npm install -g'));
    expect(invocation).toBeTruthy();
    // The call site must reference variables, never interpolate the values again — that is
    // what keeps the one escaping decision in one place.
    expect(invocation).not.toContain(VALID.nodePackage);
    expect(invocation).toContain('$NodePackage');
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

describe('the checkout installer still accepts the device id, for the offline path', () => {
  it('takes -ClientId and hands it to the app', async () => {
    // install-node.ps1 is no longer what the DOWNLOAD uses, but it is still the path for a
    // machine that has a checkout or is offline — and it needs the same id handoff, since
    // the token is bound to that device either way.
    const fs2 = await import('fs');
    const installer = await fs2.promises.readFile('installer/lib/install-node.ps1', 'utf8');
    expect(installer).toContain('[string]$ClientId');
    expect(installer).toContain('$env:OSHAL_CLIENT_ID = $ClientId');
    const config = await fs2.promises.readFile(
      'packages/oshal-chat/src/main/config.ts', 'utf8');
    expect(config).toMatch(/seed.clientId = OSHAL_CLIENT_ID/);
  });
});

describe('the install path a bare machine can actually take', () => {
  it('installs the node app from npm rather than building it from a checkout', () => {
    // The download used to shell installer/lib/install-node.ps1, which BUILDS the app from
    // packages/oshal-chat — so it only ever worked on a machine that already had the repo,
    // which is never the machine being enrolled.
    const script = renderNodeInstaller(VALID);
    expect(script).toContain('npm install -g $NodePackage');
    expect(script).toContain(VALID.nodePackage);
    expect(script).not.toContain('install-node.ps1');
    expect(script).not.toMatch(/Open Swarm folder/);
    expect(script).not.toContain('-JoinCode');
  });

  it('checks the one prerequisite it actually has, and says so rather than failing oddly', () => {
    const script = renderNodeInstaller(VALID);
    expect(script).toContain('node --version');
    expect(script).toMatch(/Node\.js 20 or newer is required/);
    expect(script).toMatch(/nodejs\.org/);
    // An npm failure is the common real-world one (proxy, offline), so it is named.
    expect(script).toMatch(/npm could not install/);
  });

  it('parses the Node version with a literal split, never a regex one', () => {
    // The defect: the source wrote -split "\." intending a literal dot, but '\.' in a
    // JavaScript string literal is just '.', so the EMITTED PowerShell read -split "."
    // — and -split takes a regex, where "." matches every character. "24.11.0" split that
    // way yields 8 empty strings; [int]"" is 0; 0 -lt 20 reported Node 24 as too old. It
    // failed identically on every machine, and no string-level test noticed because the
    // source looked correct. Verified live: the fixed form parses v24.11.0 as 24.
    const script = renderNodeInstaller(VALID);
    expect(script).toContain('.Split(".")');
    expect(script).not.toMatch(/-split\s+"\."/);
    // Any regex-taking operator here is the same trap wearing a different hat.
    expect(script).not.toMatch(/-split\s+"[^"]*\\/);
  });
});

describe('the batch header that makes the download runnable', () => {
  it('hands off to PowerShell with the policy bypass, so a double-click works', () => {
    // A downloaded .ps1 is refused as "not digitally signed" under the default RemoteSigned
    // policy, and right-click "Run with PowerShell" passes no bypass. A .cmd is outside
    // execution policy entirely. Proven live against a Zone.Identifier-tagged file.
    const script = renderNodeInstaller(VALID);
    expect(script.startsWith('@echo off')).toBe(true);
    expect(script).toContain('-ExecutionPolicy Bypass');
    expect(script).toContain('Invoke-Expression');
    expect(script).toContain('exit /b');
  });

  it('finds the marker BELOW the header, not the one inside the header', () => {
    // The defect this exists for: the launcher line spelled the marker out literally, so
    // IndexOf matched that line and executed the batch header as PowerShell. The symptom was
    // a PowerShell parse error, and only running a rendered copy surfaced it.
    const script = renderNodeInstaller(VALID);
    const marker = '#___POWERSHELL_BELOW___';
    // Reproduce exactly what the emitted command does: first occurrence wins.
    const i = script.indexOf(marker);
    expect(i).toBeGreaterThan(-1);
    const executed = script.slice(i + marker.length);
    // What follows must be the script, not the tail of the batch header.
    expect(executed.trimStart().startsWith('# OSHAL worker node')).toBe(true);
    expect(executed).not.toContain('@echo off');
    expect(executed).not.toContain('exit /b');
    // Exactly one literal occurrence: the marker line itself.
    expect(script.split(marker).length - 1).toBe(1);
  });

  it('seeds every value the node needs to come up owned and correctly identified', () => {
    const script = renderNodeInstaller(VALID);
    for (const seeded of ['OSHAL_CONTROL_PLANE_URL', 'OSHAL_SHARED_SECRET',
      'OSHAL_ENROLLMENT_TOKEN', 'OSHAL_CLIENT_ID', 'OSHAL_CLIENT_NAME']) {
      expect(script).toContain(seeded);
    }
    // OSHAL_CLIENT_ID is the one that took a live run to find: the token is bound to that
    // id, and a node that invents its own is refused at registration.
    expect(script).toMatch(/OSHAL_CLIENT_ID\s*=\s*\$ClientId/);
    expect(script).toContain('Start-Process -FilePath "oshal-chat"');
  });

  it('takes the package from configuration, so a fork or a pin is not a code change', () => {
    expect(nodePackageSpec({} as NodeJS.ProcessEnv)).toBe('@oshal/chat');
    expect(nodePackageSpec({ OSHAL_NODE_PACKAGE: '@acme/node@1.2.3' } as NodeJS.ProcessEnv))
      .toBe('@acme/node@1.2.3');
    expect(nodePackageSpec({ OSHAL_NODE_PACKAGE: '  ' } as NodeJS.ProcessEnv)).toBe('@oshal/chat');
  });
});

describe('the package is publishable, which is what makes the npm path exist', () => {
  const pkg = () => import('fs').then((fs) => JSON.parse(
    fs.readFileSync('packages/oshal-chat/package.json', 'utf8')));

  it('is not marked private and carries the repo\u2019s real license', async () => {
    const p = await pkg();
    expect(p.private).toBeUndefined();
    // The root LICENSE is AGPLv3 and package.json declares AGPL-3.0-or-later; this package
    // said UNLICENSED, which contradicted the repo it ships from.
    expect(p.license).toBe('AGPL-3.0-or-later');
    expect(p.bin).toHaveProperty('oshal-chat');
  });

  it('does not install other people\u2019s CLIs on a stranger\u2019s machine', async () => {
    const setup = await import('fs').then((fs) => fs.promises.readFile(
      'packages/oshal-chat/scripts/setup-clis.js', 'utf8'));
    // As a postinstall this runs on every `npm install`. Opting OUT meant one install
    // globally installing three other packages at @latest, unasked.
    expect(setup).toContain('OSHAL_INSTALL_CLI_TOOLS');
    expect(setup).not.toContain('if (process.env.OSHAL_SKIP_CLI_SETUP)');
    const gate = setup.slice(setup.indexOf('function main()'), setup.indexOf('function main()') + 600);
    expect(gate).toMatch(/if \(!askedFor\)/);
  });
});
