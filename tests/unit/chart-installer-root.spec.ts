/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AUTH-03 guard for the Kubernetes first-root path. Against the REAL chart (helm template, NOTES rendered offline): outside MOCK_OIDC the install notes print the one-use installer command as a kubectl exec into the api container that the render actually creates, in its local-account and exact identity-provider forms; the REAL setup script accepts exactly those flags (it reaches its posture check, not its argument refusal); the image ships the script; no rendered object in any posture runs the script (a Job or hook would keep the code in pod logs); and the mock posture says no root ceremony applies instead of printing a command.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmNotes, helmTemplate, type RenderOptions } from '../helpers/helm-template';

const SCRIPT = 'scripts/oshal-setup-root.mjs';
const REAL_AUTH: RenderOptions = { sets: ['api.extraEnv.MOCK_OIDC=false'] };
const COMMAND = /kubectl -n (\S+) exec -ti deploy\/(\S+) -c (\S+) -- node (scripts\/oshal-setup-root\.mjs) (--origin [^\n]+)/g;

/**
 * @description Every installer command the rendered notes print, split into its parts.
 * @param notes rendered NOTES.txt
 * @returns namespace, deployment, container, script and the flag string of each command
 */
function printedCommands(notes: string): Array<{ namespace: string; deployment: string; container: string; script: string; flags: string }> {
  return [...notes.matchAll(COMMAND)].map((m) => ({ namespace: m[1], deployment: m[2], container: m[3], script: m[4], flags: m[5] }));
}

/**
 * @description Run the real setup script with the printed flags (placeholders filled) under MOCK_OIDC, which
 * the script refuses AFTER parsing its arguments - so the refusal it names shows the flags parsed.
 * @param flags the flag string the notes print
 * @returns the script's stderr and exit status
 */
function parseWithRealScript(flags: string): { status: number | null; stderr: string } {
  const filled = flags.replace('<exact cockpit origin>', 'https://oshal.example.com')
    .replace('<issuer>', 'https://login.example.test/tenant-a/v2.0').replace('<subject>', 'fixture-subject');
  const result = spawnSync(process.execPath, [SCRIPT, ...filled.split(' ')], { cwd: REPO_ROOT, encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', MOCK_OIDC: 'true' }, timeout: RENDER_TIMEOUT_MS });
  return { status: result.status, stderr: result.stderr };
}

describe('chart first-root path (AUTH-03)', () => {
  it('prints the local and identity-provider installer commands as an exec into the api container the render creates', () => {
    const notes = helmNotes(REAL_AUTH);
    const commands = printedCommands(notes);
    expect(commands.map((c) => c.flags)).toEqual([
      '--origin <exact cockpit origin>',
      '--origin <exact cockpit origin> --issuer <issuer> --subject <subject>',
    ]);
    for (const command of commands) {
      expect(command.namespace).toBe('oshal');
      expect(containerOf(helmTemplate(REAL_AUTH), 'Deployment', command.deployment, command.container)).toBeTruthy();
      expect(command.script).toBe(SCRIPT);
    }
    expect(notes).toMatch(/never run it\s+as a Job or hook/);
    expect(notes).not.toContain('MOCK_OIDC is on');
  }, RENDER_TIMEOUT_MS);

  it('prints only flags the real setup script parses, and the image ships that script', () => {
    for (const command of printedCommands(helmNotes(REAL_AUTH))) {
      const parsed = parseWithRealScript(command.flags);
      expect(parsed.status).toBe(1);
      expect(parsed.stderr).toContain('disable MOCK_OIDC before root setup');
    }
    expect(fs.existsSync(path.join(REPO_ROOT, SCRIPT))).toBe(true);
    expect(fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.oshal'), 'utf8')).toMatch(/^COPY scripts\/oshal-\*\.mjs \.\/scripts\/$/m);
  }, RENDER_TIMEOUT_MS);

  it('never runs the setup script from a rendered object, in any posture', () => {
    for (const opts of [{}, REAL_AUTH, { valuesFiles: [DOCKER_DESKTOP_VALUES] }, { valuesFiles: [DOCKER_DESKTOP_VALUES], sets: REAL_AUTH.sets }]) {
      const rendered = JSON.stringify(helmTemplate(opts));
      expect(rendered, JSON.stringify(opts)).not.toContain('oshal-setup-root');
    }
  }, RENDER_TIMEOUT_MS);

  it('with MOCK_OIDC on (the chart default) states that no root ceremony applies instead of printing a command', () => {
    const notes = helmNotes({});
    expect(printedCommands(notes)).toEqual([]);
    expect(notes).toContain('MOCK_OIDC is on, so every visitor is the one mock identity and no first-root');
    expect(notes).toContain('a multi-user tenant uses deploy/terraform');
  }, RENDER_TIMEOUT_MS);
});
