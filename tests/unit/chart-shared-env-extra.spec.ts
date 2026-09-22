/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for swarm.extraEnv and the Docker Desktop overlay's use of it. On the first Docker Desktop Kubernetes install (2026-09-21) every ADR-149 protected store app failed activation closed with "Protected application routes require APP_PACKAGE_DYNAMIC_ROUTES=1": compose sets that switch by default and the chart had no way to set it, so the apps' bots were never registered. The fix renders swarm.extraEnv into the oshal-shared-env ConfigMap, which the api and every bot envFrom. This renders the REAL chart for both roles (main and bot-pod) and requires a --set key to arrive in that ConfigMap as a string and to reach every oshal runtime; and it reads the flag's NAME and its accepted values out of the platform source that raises that refusal, rather than copying either, so renaming the flag in src/ without the overlay following goes red here.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | swarm.extraEnv shares a data map with the keys the chart sets itself, and a clash used to render a duplicate data key (last-wins for one client, an apply error for another). For both roles this now reads every key the default render emits, sets ALL of them through extraEnv in one render, and requires the chart to refuse it and name each clashing key. A key the chart emits only while its service is in-cluster (ARANGO_URL) must stay settable through extraEnv once that service is off.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Chart 0.5.0 moved JWT_SECRET and ARANGO_ROOT_* out of the ConfigMap into the oshal-shared-secret Secret, so extraEnv must not become the way a credential gets back into a ConfigMap. For both roles every key the chart keeps in that Secret, set through extraEnv, must fail the render as chart-owned and be named; and every credential name the chart knows (each key of each Secret it renders, plus the *_API_KEY / *_SECRET / *_TOKEN / *AUTHKEY names values.yaml tells an operator to keep in a Secret) must fail as credential-shaped and be named.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The credential-name rule's known false positive is documented, and held true. values.yaml and the README say the rule also refuses a non-secret switch whose name matches it, naming compose's REMOTE_CLIENT_REQUIRE_NODE_TOKEN, and that such a switch goes on the workload that reads it (api.extraEnv). This reads the example out of values.yaml, confirms from the parsed docker-compose.oshal-local.yml that it is a boolean switch set on the oshal-api service alone, and requires that swarm.extraEnv refuses it while api.extraEnv renders it on the api container.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The naming checks (SEQ 2 and 3: each clashing key, each chart Secret key, each credential name) now read helm's own stderr through helmRefusal. They matched the thrown error's message, which also carried the --set list, so `swarm.extraEnv.X` was always found in the test's own argument `swarm.extraEnv.X=guard-...`. With the refusal cut to its first name, or with TOKEN dropped from the credential rule so three names stopped being refused, the checks stayed green.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, envValue, helmRefusal, helmTemplate, type K8sObject,
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

describe('swarm.extraEnv cannot redefine a key the chart owns', () => {
  // extraEnv is appended to the same data map as the chart's own keys. Before the check, a clash
  // rendered a duplicate data key: last-wins for one client, an apply error for another.
  it.each(['main', 'bot-pod'])('role=%s: every chart-owned key set through extraEnv fails the render, each one named', (role) => {
    const owned = Object.keys(sharedEnv(helmTemplate({ sets: [`role=${role}`] })));
    expect(owned.length, `role=${role}: the default render owns too few keys - the read is broken`).toBeGreaterThan(10);
    const message = helmRefusal({ sets: [`role=${role}`, ...owned.map((k) => `swarm.extraEnv.${k}=guard-clash`)] });
    expect(message, `role=${role}: extraEnv redefining chart-owned keys rendered without the chart refusing it`).toMatch(/chart-owned/);
    const unnamed = owned.filter((k) => !new RegExp(`swarm\\.extraEnv\\.${k}(?![A-Za-z0-9_])`).test(message));
    expect(unnamed, 'the refusal does not name every clashing key').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('a key the chart owns only while its service is in-cluster stays settable once that service is off', () => {
    const objects = helmTemplate({ sets: ['infra.arangodb.inCluster=false', 'swarm.extraEnv.ARANGO_URL=http://graph.example:8529'] });
    expect(sharedEnv(objects).ARANGO_URL).toBe('http://graph.example:8529');
  }, RENDER_TIMEOUT_MS);
});

describe('swarm.extraEnv cannot put a credential back into the ConfigMap', () => {
  /**
   * @description Credential env names this chart itself knows about: every key of every Secret
   * the chart renders (all optional switches on), plus every env name values.yaml tells an
   * operator to put in a Secret (the UPPER_CASE names in its comments that end in a credential
   * word). Derived from the chart, so a new chart Secret key is covered the day it lands.
   * @returns {string[]} credential env names
   */
  function credentialNames(): string[] {
    const objects = helmTemplate({ sets: ['infra.ollama.inCluster=true', 'relay.enabled=true', 'swarm.botDatabaseUrl=postgresql://oshal_bot:x@db.example:5432/oshal'] });
    const fromSecrets = objects
      .filter((o) => o.kind === 'Secret')
      .flatMap((o) => Object.keys({ ...(o as { stringData?: object }).stringData, ...o.data }));
    const valuesText = fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'helm', 'oshal', 'values.yaml'), 'utf8');
    const fromDocs = [...valuesText.matchAll(/\b([A-Z][A-Z0-9_]*(?:_API_KEY|_SECRET|_TOKEN|AUTHKEY))\b/g)].map((m) => m[1]);
    return [...new Set([...fromSecrets, ...fromDocs])].sort();
  }

  it.each(['main', 'bot-pod'])('role=%s: every key the chart keeps in oshal-shared-secret is chart-owned for extraEnv too', (role) => {
    const secret = helmTemplate({ sets: [`role=${role}`] }).find((o) => o.kind === 'Secret' && o.metadata.name === 'oshal-shared-secret');
    const keys = Object.keys((secret as { stringData?: object } | undefined)?.stringData ?? {});
    expect(keys, `role=${role}: the render has no oshal-shared-secret keys - nothing was checked`).toContain('JWT_SECRET');
    const message = helmRefusal({ sets: [`role=${role}`, ...keys.map((k) => `swarm.extraEnv.${k}=guard-clash`)] });
    expect(message, `role=${role}: extraEnv re-set a chart Secret key and the chart rendered it into the ConfigMap`).toMatch(/chart-owned/);
    expect(keys.filter((k) => !new RegExp(`swarm\.extraEnv\.${k}(?![A-Za-z0-9_])`).test(message)), 'the refusal does not name every key').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('every credential name the chart knows is refused through extraEnv, each one named', () => {
    const names = credentialNames();
    // The derivation must see the Secrets and the documented operator secrets, or this is vacuous.
    expect(names).toEqual(expect.arrayContaining(['JWT_SECRET', 'BOT_DATABASE_URL', 'OPENAI_API_KEY', 'TS_AUTHKEY']));
    const outsideChartOwnership = names.filter((n) => !['JWT_SECRET', 'ARANGO_ROOT_USER', 'ARANGO_ROOT_PASSWORD'].includes(n));
    const message = helmRefusal({ sets: outsideChartOwnership.map((k) => `swarm.extraEnv.${k}=guard-credential`) });
    expect(message, 'a credential-shaped extraEnv key rendered into the ConfigMap').toMatch(/credential-shaped/);
    const unnamed = outsideChartOwnership.filter((k) => !new RegExp(`swarm\.extraEnv\.${k}(?![A-Za-z0-9_])`).test(message));
    expect(unnamed, 'the refusal does not name every credential key').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('the documented false positive is a real non-secret switch: refused here, and settable on the api', () => {
    const valuesText = fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'helm', 'oshal', 'values.yaml'), 'utf8');
    const example = /such as compose's ([A-Z][A-Z0-9_]*)/.exec(valuesText)?.[1];
    expect(example, 'values.yaml no longer names the example the README and this guard rely on').toBeTruthy();
    const compose = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.oshal-local.yml'), 'utf8')) as {
      services: Record<string, { environment?: Record<string, unknown> | string[] }>;
    };
    const setters = Object.entries(compose.services).flatMap(([name, svc]) => {
      const env = svc.environment;
      const value = Array.isArray(env) ? env.find((e) => e.startsWith(`${example}=`))?.slice(example!.length + 1) : env?.[example!];
      return value === undefined ? [] : [[name, String(value)] as const];
    });
    expect(setters.map(([name]) => name), `compose does not set ${example} on oshal-api alone - the example is wrong`).toEqual(['oshal-api']);
    expect(setters[0][1], `${example} is not a boolean switch in compose - the example is wrong`)
      .toMatch(new RegExp(`^\\$\\{${example}:-(true|false)\\}$`));
    const message = helmRefusal({ sets: [`swarm.extraEnv.${example}=true`] });
    expect(message, 'the name rule no longer refuses the documented example - update values.yaml and the README').toMatch(/credential-shaped/);
    const api = containerOf(helmTemplate({ sets: [`api.extraEnv.${example}=true`] }), 'Deployment', 'oshal-api', 'api');
    expect(envValue(api, example!), 'api.extraEnv does not carry the switch the docs point at').toBe('true');
  }, RENDER_TIMEOUT_MS);
});
