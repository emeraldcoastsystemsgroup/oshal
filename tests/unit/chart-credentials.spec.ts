/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the chart's credentials (chart 0.5.0). Before it, templates/shared-env-configmap.yaml rendered JWT_SECRET and ARANGO_ROOT_USER/ARANGO_ROOT_PASSWORD into the oshal-shared-env ConfigMap, and templates/api.yaml hardcoded the oshal_app DSN (oshal_app:oshal-app-dev) with no values path. This renders the REAL chart in four postures (defaults, the Docker Desktop overlay, the bot-pod example, every optional switch on) and holds every kind: ConfigMap to carrying no credential, found two independent ways: a credential-shaped KEY name, and a credential VALUE - every values leaf the chart treats as a credential (a password/secret/token/key-named leaf that is not the name of a Secret the render references), the dev passwords provision-app-role.mjs whitelists, and any URL with a password in it. It also requires that nothing was dropped on the way: every consumer still resolves the same credentials through the chart's Secrets, and a bot's environment resolves to the oshal_bot DSN and never to the superuser or oshal_app one. Finally the values path: an oshal_app / oshal_bot password supplied through values reaches the api and the bots, no dev password survives anywhere in that render, and the render refuses a role password the api's bootstrap would refuse at boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  CHART_DIR, DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmTemplate, renderedData, resolvedEnv,
  type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

const VALUES_FILE = path.join(CHART_DIR, 'values.yaml');
const BOT_POD_VALUES = path.join(CHART_DIR, 'values-bot-pod.example.yaml');
const values = yaml.load(fs.readFileSync(VALUES_FILE, 'utf8')) as Record<string, any>;
const PROVISION_SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'governance', 'provision-app-role.mjs'), 'utf8');

/** This guard's own definition of a credential-shaped env name (independent of the chart's rule). */
const CREDENTIAL_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|APIKEY|AUTHKEY|_KEY$|DATABASE_URL|_DSN$)/i;
/** A values leaf whose NAME says it holds a credential. */
const CREDENTIAL_LEAF = /(password|secret|token|key)$/i;
/** A URL carrying a password in its userinfo. */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
/** Shorter values ("oshal", "root") collide with ordinary words; the name and URL checks cover them. */
const MIN_VALUE_MATCH = 8;

/** Every optional switch on: the most the chart can render (derived from values.yaml). */
function everythingOn(node: Record<string, any> = values, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if ((k === 'inCluster' || k === 'enabled') && typeof v === 'boolean') return [`${p}=true`];
    return v && typeof v === 'object' && !Array.isArray(v) ? everythingOn(v, p) : [];
  });
}

const POSTURES: Array<[string, RenderOptions]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
  ['values-bot-pod.example.yaml', { valuesFiles: [BOT_POD_VALUES] }],
  ['every optional switch on', { sets: everythingOn() }],
];

/** The dev passwords provision-app-role.mjs accepts on the in-cluster host, read from its source. */
const WHITELISTED_DEV = {
  app: /resolvedAppPassword === '([^']+)'/.exec(PROVISION_SRC)?.[1],
  bot: /resolvedBotPassword === '([^']+)'/.exec(PROVISION_SRC)?.[1],
};

/**
 * @description Every Secret name a render references (envFrom, secretKeyRef, secret volumes,
 * imagePullSecrets) - a values leaf holding one of these is a NAME, not a credential.
 * @param objects rendered objects
 * @returns {Set<string>} referenced Secret names
 */
function referencedSecretNames(objects: K8sObject[]): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown, parent = ''): void => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, parent)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'name' && /secretRef|secretKeyRef|imagePullSecrets/.test(parent)) || k === 'secretName') names.add(String(v));
      walk(v, k);
    }
  };
  walk(objects);
  return names;
}

/**
 * @description The credential VALUES this chart knows: every values leaf (defaults and the given
 * values files) whose key names a credential and whose value is not a Secret name, plus the dev
 * passwords provision-app-role.mjs whitelists.
 * @param files extra values files to read
 * @param secretNames Secret names the render references
 * @returns {string[]} credential values
 */
function knownCredentialValues(files: string[], secretNames: Set<string>): string[] {
  const out = new Set<string>([WHITELISTED_DEV.app, WHITELISTED_DEV.bot].filter((v): v is string => Boolean(v)));
  const walk = (node: unknown, key = ''): void => {
    if (node && typeof node === 'object') { Object.entries(node).forEach(([k, v]) => walk(v, k)); return; }
    if (typeof node === 'string' && node && CREDENTIAL_LEAF.test(key) && !secretNames.has(node)) out.add(node);
  };
  for (const f of [VALUES_FILE, ...files]) walk(yaml.load(fs.readFileSync(f, 'utf8')));
  return [...out];
}

/**
 * @description Every credential found in the render's ConfigMaps, by key name and by value.
 * @param objects rendered objects
 * @param credentials known credential values
 * @returns {string[]} findings, empty when clean
 */
function configMapCredentials(objects: K8sObject[], credentials: string[]): string[] {
  const findings: string[] = [];
  for (const cm of objects.filter((o) => o.kind === 'ConfigMap')) {
    for (const [k, raw] of Object.entries(cm.data ?? {})) {
      const v = String(raw);
      const where = `ConfigMap/${cm.metadata.name} ${k}`;
      if (CREDENTIAL_NAME.test(k)) findings.push(`${where}: credential-shaped key`);
      if (URL_WITH_PASSWORD.test(v)) findings.push(`${where}: a URL carrying a password`);
      for (const c of credentials) if (c.length >= MIN_VALUE_MATCH && v.includes(c)) findings.push(`${where}: carries the credential value of a values leaf`);
    }
  }
  return findings;
}

/**
 * @description The api container and each bot container of a render, with what each resolves to.
 * @param objects rendered objects
 * @returns {{ api?: Record<string, string>, bots: Array<{ name: string, env: Record<string, string>, container: Record<string, any> }> }}
 */
function runtimes(objects: K8sObject[]) {
  const apiObj = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'oshal-api');
  const api = apiObj ? resolvedEnv(objects, containerOf(objects, 'Deployment', 'oshal-api', 'api')) : undefined;
  const bots = objects.filter((o) => o.kind === 'Deployment' && o.metadata.labels?.['oshal.io/bot'] === 'true').map((o) => {
    const container = o.spec?.template?.spec?.containers?.[0];
    return { name: o.metadata.name, env: resolvedEnv(objects, container), container };
  });
  return { api, bots };
}

describe('no credential is rendered into a ConfigMap', () => {
  it('the parse reads the credentials it checks for: dev passwords from provision-app-role.mjs, jwtSecret from values', () => {
    expect(WHITELISTED_DEV, 'provision-app-role.mjs no longer whitelists the in-cluster dev passwords - re-read this guard').toEqual({
      app: values.infra.postgres.appPassword, bot: values.infra.postgres.botPassword,
    });
    const creds = knownCredentialValues([], referencedSecretNames(helmTemplate({})));
    expect(creds).toEqual(expect.arrayContaining([values.swarm.jwtSecret, values.infra.arangodb.rootPassword, values.infra.diarization.serviceKey]));
    expect(creds, 'a Secret NAME was taken for a credential value').not.toContain(values.api.envSecret);
  }, RENDER_TIMEOUT_MS);

  it.each(POSTURES)('%s: no ConfigMap key is credential-shaped and no ConfigMap value carries a credential', (_label, opts) => {
    const objects = helmTemplate(opts);
    expect(objects.filter((o) => o.kind === 'ConfigMap').length, 'the render has no ConfigMap - nothing was checked').toBeGreaterThan(0);
    const creds = knownCredentialValues(opts.valuesFiles ?? [], referencedSecretNames(objects));
    expect(configMapCredentials(objects, creds), 'credentials belong in a Secret, not a ConfigMap').toEqual([]);
  }, RENDER_TIMEOUT_MS);
});

describe('moving the credentials dropped none of them', () => {
  it.each(POSTURES.slice(0, 2))('%s: the api, every bot and ArangoDB resolve the same credentials through the chart Secrets', (_label, opts) => {
    const objects = helmTemplate(opts);
    const { api, bots } = runtimes(objects);
    expect(api, 'no oshal-api in the render').toBeTruthy();
    expect(bots.length, 'the render has no bots - nothing was checked').toBeGreaterThan(0);
    for (const [who, env] of [['oshal-api', api!] as const, ...bots.map((b) => [b.name, b.env] as const)]) {
      expect(env.JWT_SECRET, `${who}: JWT_SECRET`).toBe(values.swarm.jwtSecret);
      expect(env.ARANGO_ROOT_USER, `${who}: ARANGO_ROOT_USER`).toBe(values.infra.arangodb.rootUser);
      expect(env.ARANGO_ROOT_PASSWORD, `${who}: ARANGO_ROOT_PASSWORD`).toBe(values.infra.arangodb.rootPassword);
    }
    const arango = containerOf(objects, 'StatefulSet', 'oshal-arangodb', 'arangodb');
    expect(resolvedEnv(objects, arango).ARANGO_ROOT_PASSWORD, 'arangodb and its clients must read one password').toBe(api!.ARANGO_ROOT_PASSWORD);
    expect(new URL(api!.DATABASE_URL).username).toBe('oshal_app');
    expect(new URL(api!.BOT_DATABASE_URL).username).toBe('oshal_bot');
  }, RENDER_TIMEOUT_MS);

  it.each(POSTURES.slice(0, 2))('%s: a bot resolves only the oshal_bot DSN - never the superuser or oshal_app one', (_label, opts) => {
    const objects = helmTemplate(opts);
    const { api, bots } = runtimes(objects);
    const privileged = [api!.BOOTSTRAP_DATABASE_URL, api!.DATABASE_URL];
    expect(privileged.every(Boolean), 'the api resolves no superuser/oshal_app DSN - nothing to compare').toBe(true);
    for (const b of bots) {
      expect(b.env.DATABASE_URL, `${b.name} does not get the api's BOT_DATABASE_URL`).toBe(api!.BOT_DATABASE_URL);
      const leaked = Object.entries(b.env).filter(([, v]) => privileged.includes(v)).map(([k]) => k);
      expect(leaked, `${b.name} resolves a privileged DSN`).toEqual([]);
    }
  }, RENDER_TIMEOUT_MS);
});

describe('the oshal_app and oshal_bot passwords have a values path', () => {
  const app = 'a1'.repeat(24);
  const bot = 'b2'.repeat(24);

  it('a password supplied through values reaches the api and every bot, and no dev password survives', () => {
    const objects = helmTemplate({ sets: [`infra.postgres.appPassword=${app}`, `infra.postgres.botPassword=${bot}`] });
    const { api, bots } = runtimes(objects);
    expect(new URL(api!.DATABASE_URL).password, 'the api\'s oshal_app DSN ignores infra.postgres.appPassword').toBe(app);
    expect(new URL(api!.BOT_DATABASE_URL).password, 'the api\'s oshal_bot DSN ignores infra.postgres.botPassword').toBe(bot);
    for (const b of bots) expect(new URL(b.env.DATABASE_URL).password, `${b.name} ignores infra.postgres.botPassword`).toBe(bot);
    const text = yaml.dump(objects);
    for (const dev of [WHITELISTED_DEV.app, WHITELISTED_DEV.bot]) expect(text.includes(String(dev)), `${dev} is still rendered somewhere`).toBe(false);
    expect(renderedData(objects, 'Secret', 'oshal-db-credentials')?.DATABASE_URL).toContain(app);
  }, RENDER_TIMEOUT_MS);

  it.each([
    ['a non-hex app password', [`infra.postgres.appPassword=not-hex-at-all`], /infra\.postgres\.appPassword must be 48-128 hexadecimal/],
    ['a short hex bot password', [`infra.postgres.botPassword=${'c3'.repeat(10)}`], /infra\.postgres\.botPassword must be 48-128 hexadecimal/],
    ['equal passwords', [`infra.postgres.appPassword=${app}`, `infra.postgres.botPassword=${app}`], /must differ/],
  ])('the render refuses %s, which the api bootstrap would refuse at boot', (_label, sets, message) => {
    let err = '';
    try { helmTemplate({ sets }); } catch (e) { err = (e as Error).message; }
    expect(err, 'the chart rendered a role password the bootstrap refuses').toMatch(message);
  }, RENDER_TIMEOUT_MS);
});
