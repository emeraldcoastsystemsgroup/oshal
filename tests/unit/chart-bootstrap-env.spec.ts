/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for rbac.botLauncher=false crash-looping the api. BOT_DATABASE_URL was emitted only inside the botLauncher block while OSHAL_APP_ROLE_BOOTSTRAP stayed "true", so the bootstrap ran scripts/governance/provision-app-role.mjs, which refuses with "BOT_DATABASE_URL is required", and the command's own `exit 1` restarted the pod forever - on a posture values.yaml documents as a supported degrade. The env the bootstrap needs is DERIVED, never hand-listed: every name the rendered command dereferences ($NAME, ${NAME...}, process.env.NAME) that the command does not assign itself, plus every URL provision-app-role.mjs passes to parsePostgresUrl, traced back through its main() to the process.env names that feed it. Each must be supplied by the render itself (explicit env, or an envFrom source the chart creates). The real script then runs: the provision line is cut out of the RENDERED command, given --dry-run, and executed by a POSIX shell with exactly the env the render supplies - it must accept, and the same run without BOT_DATABASE_URL must refuse naming it, so the check cannot pass against a script that stopped validating.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, envValue, helmTemplate, resolvedEnv,
  type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

const PROVISION_REL = 'scripts/governance/provision-app-role.mjs';
const PROVISION_SRC = fs.readFileSync(path.join(REPO_ROOT, PROVISION_REL), 'utf8');
const BOOTSTRAP_SWITCH = 'OSHAL_APP_ROLE_BOOTSTRAP';

/** Postures under test: the documented degrade, on the chart defaults and on the overlay that ran live. */
const POSTURES: Array<[string, RenderOptions]> = [
  ['defaults, rbac.botLauncher=false', { sets: ['rbac.botLauncher=false'] }],
  ['values-docker-desktop.yaml, rbac.botLauncher=false', { valuesFiles: [DOCKER_DESKTOP_VALUES], sets: ['rbac.botLauncher=false'] }],
  ['defaults, rbac.botLauncher=true', {}],
];

/**
 * @description The shell script the api container runs (command /bin/sh -c, script in args[0]).
 * @param container the api container
 * @returns {string} the script
 */
function bootstrapScript(container: Record<string, any>): string {
  const cmd = container.command ?? [];
  if (cmd[0] !== '/bin/sh' || cmd[1] !== '-c' || typeof container.args?.[0] !== 'string') {
    throw new Error('the api container no longer runs its bootstrap as `/bin/sh -c <script>` - re-read this guard');
  }
  return container.args[0];
}

/**
 * @description Names the script sets for itself: standalone `NAME=value;` statements and loop variables.
 * A `NAME=value cmd` prefix is NOT counted - it scopes to that one command only.
 * @param script shell script
 * @returns {Set<string>} names the script owns
 */
function scriptOwned(script: string): Set<string> {
  const owned = new Set<string>();
  for (const m of script.matchAll(/(?:^|[;{]|\n)\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s;]*)\s*;/g)) owned.add(m[1]);
  for (const m of script.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) owned.add(m[1]);
  return owned;
}

/**
 * @description Names the script dereferences: shell `$NAME` / `${NAME...}` and `process.env.NAME` in
 * its inline node programs. `$(` (command substitution) is not a name.
 * @param script shell script
 * @returns {Set<string>} dereferenced names
 */
function scriptDerefs(script: string): Set<string> {
  const names = new Set<string>();
  for (const m of script.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const m of script.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  return names;
}

/**
 * @description The source of one top-level function of provision-app-role.mjs, so a pattern is
 * matched inside that function and nowhere else.
 * @param name function name
 * @returns {string} function source
 */
function provisionFunction(name: string): string {
  const start = PROVISION_SRC.search(new RegExp(`\\bfunction ${name}\\(`));
  if (start < 0) throw new Error(`${PROVISION_REL} has no function ${name} - re-read this guard`);
  const rest = PROVISION_SRC.slice(start);
  const end = rest.slice(1).search(/\n(?:export |async |function |const )/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/**
 * @description What provision-app-role.mjs refuses to run without, read from its source: each URL
 * runtimeCredentials() hands to parsePostgresUrl (a missing one throws "<LABEL> is required"),
 * traced through main() to the process.env names that feed it, first-found alternative first.
 * @returns {Array<{ param: string, label: string, envs: string[] }>} required URL groups
 */
function provisionRequiredEnv(): Array<{ param: string; label: string; envs: string[] }> {
  const main = provisionFunction('main');
  const feeds = new Map<string, string[]>();
  for (const m of main.matchAll(/(\w+):\s*(process\.env\.\w+(?:\s*\|\|\s*process\.env\.\w+)*)/g)) {
    feeds.set(m[1], [...m[2].matchAll(/process\.env\.(\w+)/g)].map((x) => x[1]));
  }
  const creds = provisionFunction('runtimeCredentials');
  const groups = [...creds.matchAll(/parsePostgresUrl\(\s*(\w+)\s*,\s*'([A-Z_]+)'\s*\)/g)].map((m) => ({
    param: m[1], label: m[2], envs: feeds.get(m[1]) ?? [],
  }));
  if (groups.length === 0) throw new Error(`${PROVISION_REL} runtimeCredentials() validates no URL - re-read this guard`);
  for (const g of groups) {
    if (g.envs.length === 0) throw new Error(`main() in ${PROVISION_REL} feeds ${g.param} from no process.env name`);
  }
  return groups;
}

/**
 * @description The script's line that runs provision-app-role.mjs, and the names that line assigns
 * as command prefixes (they reach that one command only).
 * @param script shell script
 * @returns {{ line: string, prefixed: Set<string> }}
 */
function provisionLine(script: string): { line: string; prefixed: Set<string> } {
  const lines = script.split('\n').filter((l) => l.includes(PROVISION_REL));
  if (lines.length !== 1) throw new Error(`expected one line running ${PROVISION_REL} in the api bootstrap, found ${lines.length}`);
  const line = lines[0].trim();
  const head = line.slice(0, line.indexOf(`node ${PROVISION_REL}`));
  const prefixed = new Set([...head.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]));
  return { line, prefixed };
}

/**
 * @description A POSIX shell to run the rendered line with: /bin/sh, or on Windows the sh.exe that
 * ships beside git-bash. A missing shell is a loud failure - this guard does not skip.
 * @returns {string} shell executable path
 */
function posixShell(): string {
  if (process.platform !== 'win32') {
    if (fs.existsSync('/bin/sh')) return '/bin/sh';
    throw new Error('/bin/sh not found - this guard runs the rendered bootstrap line in a POSIX shell');
  }
  const probe = spawnSync('where', ['sh'], { encoding: 'utf8' });
  const sh = (probe.stdout ?? '').split(/\r?\n/).map((l) => l.trim())
    .find((l) => l.toLowerCase().endsWith('sh.exe') && !l.toLowerCase().includes('system32') && fs.existsSync(l));
  if (!sh) throw new Error('no sh.exe on PATH (git-bash) - this guard runs the rendered bootstrap line in a POSIX shell');
  return sh;
}

/**
 * @description Run the RENDERED provision line with --dry-run (validate, build the SQL, connect to
 * nothing) under a POSIX shell whose environment is exactly what the render supplies.
 * @param line the rendered provision line
 * @param env the container's resolved environment
 * @returns {{ status: number | null, out: string }}
 */
function dryRunProvision(line: string, env: Record<string, string>): { status: number | null; out: string } {
  const invocation = `node ${PROVISION_REL}`;
  if (line.split(invocation).length !== 2) throw new Error(`the provision line does not invoke "${invocation}" exactly once`);
  const dry = line.replace(invocation, `${invocation} --dry-run`);
  const host = { PATH: process.env.PATH ?? process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' };
  const res = spawnSync(posixShell(), ['-c', dry], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...env, ...host }, timeout: 60_000 });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * @description The api container of a render plus the environment the render supplies to it.
 * @param objects rendered objects
 * @returns {{ api: Record<string, any>, env: Record<string, string> }}
 */
function apiWithEnv(objects: K8sObject[]): { api: Record<string, any>; env: Record<string, string> } {
  const api = containerOf(objects, 'Deployment', 'oshal-api', 'api');
  return { api, env: resolvedEnv(objects, api) };
}

describe('the api bootstrap has every env it dereferences, whatever rbac.botLauncher is', () => {
  it('provision-app-role.mjs still refuses without each URL, and the parse sees BOT_DATABASE_URL among them', () => {
    const groups = provisionRequiredEnv();
    // If this fails the extractor stopped seeing the script, and every posture below is vacuous.
    expect(groups.map((g) => g.label)).toEqual(expect.arrayContaining(['BOOTSTRAP_DATABASE_URL', 'DATABASE_URL', 'BOT_DATABASE_URL']));
    expect(groups.find((g) => g.label === 'BOT_DATABASE_URL')?.envs).toEqual(['BOT_DATABASE_URL']);
    expect(PROVISION_SRC, 'the script no longer throws "<LABEL> is required" for a missing URL').toMatch(/fail\(`\$\{label\} is required`\)/);
  });

  it.each(POSTURES)('%s: every name the rendered command and provision-app-role.mjs need is supplied by the render', (_label, opts) => {
    const { api, env } = apiWithEnv(helmTemplate(opts));
    const script = bootstrapScript(api);
    // The precondition that makes the bootstrap branch run at all; without it this proves nothing.
    expect(envValue(api, BOOTSTRAP_SWITCH), `${BOOTSTRAP_SWITCH} must be on for this posture to exercise the bootstrap`).toBe('true');
    expect(script, 'the bootstrap branch is gated on a different switch').toContain(`"$${BOOTSTRAP_SWITCH}" = "true"`);
    const owned = scriptOwned(script);
    const fromScript = [...scriptDerefs(script)].filter((n) => !owned.has(n));
    expect(fromScript.length, 'the command dereferences nothing - the parse is broken').toBeGreaterThan(2);
    const { prefixed } = provisionLine(script);
    const missing = [
      ...fromScript.filter((n) => env[n] === undefined).map((n) => `${n} (dereferenced by the api command)`),
      ...provisionRequiredEnv()
        .filter((g) => !g.envs.some((n) => env[n] !== undefined || prefixed.has(n)))
        .map((g) => `${g.envs.join(' or ')} (${PROVISION_REL} refuses: "${g.label} is required")`),
    ];
    expect(missing, 'the api would restart forever: its bootstrap reads env the chart does not supply').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it.each(POSTURES)('%s: the real provision script accepts the rendered env (dry run), and refuses it without BOT_DATABASE_URL', (_label, opts) => {
    const { api, env } = apiWithEnv(helmTemplate(opts));
    const { line } = provisionLine(bootstrapScript(api));
    const ok = dryRunProvision(line, env);
    expect(ok.status, `the rendered provision line failed under the rendered env:\n${ok.out}`).toBe(0);
    expect(ok.out).toContain('dry run - nothing executed');
    // Control: the same line, same env, BOT_DATABASE_URL removed - the defect's exact shape.
    const withoutBot = { ...env };
    delete withoutBot.BOT_DATABASE_URL;
    const refused = dryRunProvision(line, withoutBot);
    expect(refused.status, 'provision-app-role.mjs accepted an env with no BOT_DATABASE_URL - this check has no teeth').not.toBe(0);
    expect(refused.out).toContain('BOT_DATABASE_URL is required');
  }, RENDER_TIMEOUT_MS);
});
