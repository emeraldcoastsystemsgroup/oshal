/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for swarm.extraEnv and the Docker Desktop overlay's use of it. On the first Docker Desktop Kubernetes install (2026-09-21) every ADR-149 protected store app failed activation closed with "Protected application routes require APP_PACKAGE_DYNAMIC_ROUTES=1": compose sets that switch by default and the chart had no way to set it, so the apps' bots were never registered. The fix renders swarm.extraEnv into the oshal-shared-env ConfigMap, which the api and every bot envFrom. This renders the REAL chart for both roles (main and bot-pod) and requires a --set key to arrive in that ConfigMap as a string and to reach every oshal runtime; and it reads the flag's NAME and its accepted values out of the platform source that raises that refusal, rather than copying either, so renaming the flag in src/ without the overlay following goes red here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmTemplate, type K8sObject,
} from '../helpers/helm-template';

const SHARED_ENV = 'oshal-shared-env';
const REFUSAL = /Protected application routes require ([A-Z][A-Z0-9_]*)=1/;

/**
 * @description Every .ts file under a directory, recursively.
 * @param dir directory to walk
 * @returns {string[]} absolute file paths
 */
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.isFile() && e.name.endsWith('.ts') ? [p] : [];
  });
}

/**
 * @description The env flag the platform names when it refuses a protected app's routes, and the
 * values the same file accepts as "on" - both read from src/, never copied into this guard.
 * @returns {{ name: string, accepted: string[], file: string }}
 */
function dynamicRoutesFlag(): { name: string; accepted: string[]; file: string } {
  const hits = tsFiles(path.join(REPO_ROOT, 'src'))
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => REFUSAL.test(text));
  if (hits.length !== 1) throw new Error(`expected one src/ file raising the protected-routes refusal, found ${hits.length}`);
  const { file, text } = hits[0];
  const name = REFUSAL.exec(text)?.[1] as string;
  const check = new RegExp(`\\[([^\\]]*)\\]\\.includes\\(\\s*\\(?\\s*process\\.env\\.${name}\\b`).exec(text);
  if (!check) throw new Error(`${path.relative(REPO_ROOT, file)} raises the refusal but does not read process.env.${name} against a list`);
  const accepted = [...check[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  return { name, accepted, file };
}

/**
 * @description The data map of the shared-env ConfigMap in a render; throws when absent.
 * @param objects rendered objects
 * @returns {Record<string, unknown>} ConfigMap data
 */
function sharedEnv(objects: K8sObject[]): Record<string, unknown> {
  const cm = objects.find((o) => o.kind === 'ConfigMap' && o.metadata.name === SHARED_ENV);
  if (!cm?.data) throw new Error(`render has no ConfigMap ${SHARED_ENV}`);
  return cm.data;
}

/**
 * @description Every container that runs the oshal image in a render: the api (main role) and
 * each bot Deployment (label oshal.io/bot=true) - the runtimes extraEnv exists to reach.
 * @param objects rendered objects
 * @returns {Array<{ owner: string, container: Record<string, any> }>}
 */
function oshalRuntimes(objects: K8sObject[]): Array<{ owner: string; container: Record<string, any> }> {
  return objects
    .filter((o) => o.kind === 'Deployment' && (o.metadata.name === 'oshal-api' || o.metadata.labels?.['oshal.io/bot'] === 'true'))
    .flatMap((o) => (o.spec?.template?.spec?.containers ?? []).map((c: Record<string, any>) => ({ owner: o.metadata.name, container: c })));
}

describe('swarm.extraEnv reaches every oshal runtime through the shared ConfigMap', () => {
  it.each(['main', 'bot-pod'])('role=%s: a --set key renders into oshal-shared-env as a string and every runtime reads it', (role) => {
    const objects = helmTemplate({ sets: [`role=${role}`, 'swarm.extraEnv.OSHAL_GUARD_TEXT=on', 'swarm.extraEnv.OSHAL_GUARD_NUMBER=1'] });
    const data = sharedEnv(objects);
    // ConfigMap data must be strings: an unquoted 1 is rejected by the API server at apply time.
    expect(data.OSHAL_GUARD_TEXT, `role=${role}: swarm.extraEnv did not render into ${SHARED_ENV}`).toBe('on');
    expect(data.OSHAL_GUARD_NUMBER, `role=${role}: a numeric extraEnv value must render quoted`).toBe('1');
    const runtimes = oshalRuntimes(objects);
    expect(runtimes.length, `role=${role}: the render has no oshal runtime - nothing was checked`).toBeGreaterThan(0);
    if (role === 'main') expect(runtimes.map((r) => r.owner)).toContain('oshal-api');
    for (const { owner, container } of runtimes) {
      const refs = (container.envFrom ?? []).map((e: { configMapRef?: { name: string } }) => e.configMapRef?.name);
      expect(refs, `${owner} does not envFrom ${SHARED_ENV}, so extraEnv never reaches it`).toContain(SHARED_ENV);
      const shadow = (container.env ?? []).map((e: { name: string }) => e.name).filter((n: string) => n.startsWith('OSHAL_GUARD_'));
      expect(shadow, `${owner} sets the key explicitly, which would shadow the ConfigMap`).toEqual([]);
    }
  }, RENDER_TIMEOUT_MS);
});

describe('the Docker Desktop overlay turns on the switch protected apps need', () => {
  const flag = dynamicRoutesFlag();

  it('the platform names its dynamic-routes switch in the refusal and reads that same env', () => {
    expect(flag.name, 'the platform renamed its dynamic-routes switch - the overlay and the docs must follow').toBe('APP_PACKAGE_DYNAMIC_ROUTES');
    expect(flag.accepted, `${path.relative(REPO_ROOT, flag.file)} accepts no value as "on"`).toContain('1');
  });

  it('values-docker-desktop.yaml sets that switch to "1", and the api receives it', () => {
    const overlay = yaml.load(fs.readFileSync(DOCKER_DESKTOP_VALUES, 'utf8')) as Record<string, any>;
    expect(overlay.swarm?.extraEnv?.[flag.name], `values-docker-desktop.yaml does not set swarm.extraEnv.${flag.name}`).toBe('1');
    const objects = helmTemplate({ valuesFiles: [DOCKER_DESKTOP_VALUES] });
    const value = sharedEnv(objects)[flag.name];
    expect(flag.accepted, `${flag.name}=${String(value)} in ${SHARED_ENV} is not a value the platform accepts`).toContain(value);
    const api = containerOf(objects, 'Deployment', 'oshal-api', 'api');
    const explicit = (api.env ?? []).find((e: { name: string }) => e.name === flag.name);
    // An explicit container env entry beats envFrom: one set to anything else would switch it back off.
    if (explicit) expect(flag.accepted).toContain(explicit.value);
    expect((api.envFrom ?? []).map((e: { configMapRef?: { name: string } }) => e.configMapRef?.name)).toContain(SHARED_ENV);
  }, RENDER_TIMEOUT_MS);
});
