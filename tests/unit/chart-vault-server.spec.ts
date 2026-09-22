/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Helm half of "Production Vault hardening" (chart 0.5.0). The chart ran `vault server -dev`, shipped infra.vault.devRootToken (oshal-dev-root) and put that root token on the api as a literal VAULT_TOKEN. Renders the REAL chart (defaults and the Docker Desktop overlay) and requires: no -dev argument or VAULT_DEV_* env on the Vault container; the dev root token (read from docker-compose.oshal-local.yml, which still carries it for the development box) in no values file and nowhere in the render; no devRootToken key in values; and no Vault token reaching the api by any route the render controls - the token env name is READ from the platform source, not assumed. It also holds the server-mode shape to itself: the file storage path is the mount of the pod's own claim, the listener port is the Service's target and the api's VAULT_ADDR port, and mlock is disabled exactly because no IPC_LOCK is granted. And it proves the sealed/degraded path is wired at render level: the platform's console answers 503 when no token is configured (read from src), no probe fails on a sealed or uninitialized Vault (the query overrides both of Vault's non-2xx health codes), and a src AppRole login - which would let the chart supply a scoped credential - does not exist yet (the case fails the day one lands, so the chart gets wired to it). The TLS switch renders a TLS listener from the operator's Secret, an https VAULT_ADDR, HTTPS probes and the CA (only) trusted by the api; with the default Secret name it reads that Secret, and an empty name fails the render. The README runbook must name the StatefulSet pod the render creates.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The TLS-without-a-Secret refusal is checked against helm's own stderr (helmRefusal). The thrown error's message also carried the --set list, which contains infra.vault.tls.secretName itself, so the check passed whatever helm said; with the refusal reworded to omit the value it stayed green.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  CHART_DIR, DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmRefusal, helmTemplate, renderedData, resolvedEnv,
  type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const VAULT_SERVICE_SRC = read('src/features/devops-vault/services/vault-console-service.ts');
const DEVOPS_ROUTES_SRC = read('src/app/routes/devops-routes.ts');
const README = fs.readFileSync(path.join(CHART_DIR, 'README.md'), 'utf8');
const VALUES_FILES = [path.join(CHART_DIR, 'values.yaml'), DOCKER_DESKTOP_VALUES, path.join(CHART_DIR, 'values-bot-pod.example.yaml')];

const POSTURES: Array<[string, RenderOptions]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
];
const TLS: RenderOptions = { sets: ['infra.vault.tls.enabled=true', 'infra.vault.tls.secretName=guard-vault-tls'] };

/**
 * @description The first capture group of a pattern, or a thrown error naming what was missing.
 * @param text source text
 * @param pattern regex with one capture group
 * @param what description for the failure
 * @returns {string} the captured text
 */
function capture(text: string, pattern: RegExp, what: string): string {
  const m = pattern.exec(text);
  if (!m?.[1]) throw new Error(`could not read ${what}`);
  return m[1];
}

/** What the platform reads, from its source: the token env, the address env. */
const PLATFORM = {
  tokenEnv: capture(VAULT_SERVICE_SRC, /this\.token\s*=\s*\(config\.token\s*\?\?\s*process\.env\.([A-Z_]+)/, 'the Vault token env name'),
  addrEnv: capture(VAULT_SERVICE_SRC, /this\.addr\s*=\s*\(config\.addr\s*\?\?\s*process\.env\.([A-Z_]+)/, 'the Vault address env name'),
};

/** The dev root token the compose half still ships, read from compose rather than copied. */
const DEV_ROOT_TOKEN = capture(read('docker-compose.oshal-local.yml'), /VAULT_DEV_ROOT_TOKEN_ID:\s*\$\{VAULT_DEV_ROOT_TOKEN:-([^}]+)\}/, 'the compose dev root token');

/**
 * @description The Vault StatefulSet, its container and its rendered vault.hcl.
 * @param objects rendered objects
 * @returns {{ sts: K8sObject, c: Record<string, any>, hcl: string, configPath: string }}
 */
function vault(objects: K8sObject[]) {
  const sts = objects.find((o) => o.kind === 'StatefulSet' && o.metadata.name === 'oshal-vault');
  if (!sts) throw new Error('the render has no StatefulSet oshal-vault (Vault must persist to a claim)');
  const c = containerOf(objects, 'StatefulSet', 'oshal-vault', 'vault');
  const configPath = capture((c.args ?? []).join(' '), /-config=(\S+)/, 'the -config argument of the vault container');
  const mount = (c.volumeMounts ?? []).find((m: { mountPath: string }) => configPath.startsWith(`${m.mountPath}/`));
  const vol = (sts.spec?.template?.spec?.volumes ?? []).find((v: { name: string }) => v.name === mount?.name);
  const data = vol?.configMap ? renderedData(objects, 'ConfigMap', vol.configMap.name) : undefined;
  const hcl = data?.[path.posix.basename(configPath)];
  if (!hcl) throw new Error(`-config=${configPath} is not a file of a ConfigMap this render mounts`);
  return { sts, c, hcl, configPath };
}

/**
 * @description The query parameters of every httpGet probe on a container.
 * @param c container spec
 * @returns {Array<{ kind: string, path: string, scheme?: string, params: URLSearchParams }>}
 */
function httpProbes(c: Record<string, any>) {
  return ['startupProbe', 'readinessProbe', 'livenessProbe'].filter((k) => c[k]).map((kind) => {
    const get = c[kind].httpGet;
    if (!get) throw new Error(`vault ${kind} is not an httpGet probe`);
    return { kind, path: String(get.path), scheme: get.scheme, params: new URL(`http://x${get.path}`).searchParams };
  });
}

describe('the chart ships no Vault root token and no dev-mode Vault', () => {
  it('no values file carries a devRootToken key or the dev root token', () => {
    expect(DEV_ROOT_TOKEN.length).toBeGreaterThan(3);
    for (const f of VALUES_FILES) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text.includes(DEV_ROOT_TOKEN), `${path.basename(f)} carries the dev root token`).toBe(false);
      expect(/^\s*devRootToken\s*:/m.test(text), `${path.basename(f)} still has a devRootToken key`).toBe(false);
    }
  });

  it.each(POSTURES)('%s: no -dev argument, no dev env, the dev root token nowhere, no Vault token on the api', (_label, opts) => {
    const objects = helmTemplate(opts);
    const { c } = vault(objects);
    const args = [...(c.command ?? []), ...(c.args ?? [])].map(String);
    expect(args.filter((a) => /^-{1,2}dev\b/.test(a)), 'the vault container runs a -dev flag').toEqual([]);
    expect((c.env ?? []).map((e: { name: string }) => e.name).filter((n: string) => n.startsWith('VAULT_DEV')), 'dev-mode env on vault').toEqual([]);
    expect(yaml.dump(objects).includes(DEV_ROOT_TOKEN), 'the dev root token is rendered somewhere').toBe(false);
    const api = containerOf(objects, 'Deployment', 'oshal-api', 'api');
    expect((api.env ?? []).map((e: { name: string }) => e.name), `the api carries an explicit ${PLATFORM.tokenEnv} entry`).not.toContain(PLATFORM.tokenEnv);
    expect(resolvedEnv(objects, api)[PLATFORM.tokenEnv], `a chart ConfigMap/Secret hands the api a ${PLATFORM.tokenEnv}`).toBeUndefined();
    expect(resolvedEnv(objects, api)[PLATFORM.addrEnv]).toBe('http://oshal-vault:8200');
  }, RENDER_TIMEOUT_MS);
});

describe('Vault runs in server mode on storage that survives a restart', () => {
  it.each(POSTURES)('%s: file storage on the pod\'s own claim, a listener the Service and the api agree on, mlock consistent with capabilities', (_label, opts) => {
    const objects = helmTemplate(opts);
    const { sts, c, hcl } = vault(objects);
    const storagePath = capture(hcl, /storage\s+"file"\s*\{[^}]*path\s*=\s*"([^"]+)"/, 'file storage path from vault.hcl');
    const claims = (sts.spec?.volumeClaimTemplates ?? []).map((t: { metadata: { name: string } }) => t.metadata.name);
    const dataMount = (c.volumeMounts ?? []).find((m: { mountPath: string }) => m.mountPath === storagePath);
    expect(dataMount, `storage path ${storagePath} is not a mount`).toBeTruthy();
    expect(claims, `${storagePath} is not backed by a volumeClaimTemplate - Vault would lose its data on restart`).toContain(dataMount.name);
    const port = Number(capture(hcl, /listener\s+"tcp"\s*\{[^}]*address\s*=\s*"[^"]*:(\d+)"/, 'listener port'));
    const svc = objects.find((o) => o.kind === 'Service' && o.metadata.name === 'oshal-vault');
    expect(svc?.spec?.ports?.map((p: { targetPort: number }) => p.targetPort)).toContain(port);
    const api = containerOf(objects, 'Deployment', 'oshal-api', 'api');
    expect(new URL(resolvedEnv(objects, api)[PLATFORM.addrEnv]).port).toBe(String(port));
    const ipcLock = (c.securityContext?.capabilities?.add ?? []).includes('IPC_LOCK');
    expect(/disable_mlock\s*=\s*true/.test(hcl), 'mlock must be disabled exactly when IPC_LOCK is not granted').toBe(!ipcLock);
    expect(/tls_disable\s*=\s*1/.test(hcl), 'the default listener is the plain in-cluster one').toBe(true);
  }, RENDER_TIMEOUT_MS);
});

describe('the sealed/degraded path is wired', () => {
  it('the platform degrades on a missing token, and src has no AppRole login for the chart to wire', () => {
    // isConfigured() is "a token is set", and every console route answers 503 when it is not.
    expect(VAULT_SERVICE_SRC).toMatch(/isConfigured\(\): boolean \{\s*return this\.token\.length > 0;/);
    const guarded = DEVOPS_ROUTES_SRC.match(/if \(!svc\.isConfigured\(\)\) \{ res\.status\(503\)\.json\(\{ error: 'vault_not_configured'/g) ?? [];
    expect(guarded.length, 'the console routes no longer 503 without a token').toBeGreaterThanOrEqual(2);
    // status() reads health with sealed/uninit mapped to 200 and reports "sealed" instead of failing.
    expect(VAULT_SERVICE_SRC).toMatch(/sys\/health\?[^`'"]*sealedcode=200/);
    const approle = /approle|role_id|secret_id|VAULT_ROLE_ID|VAULT_SECRET_ID/i;
    const hits = [VAULT_SERVICE_SRC, DEVOPS_ROUTES_SRC].filter((s) => approle.test(s));
    expect(hits.length, 'src grew a Vault AppRole login: wire VAULT_ROLE_ID/VAULT_SECRET_ID (from an optional Secret) into templates/api.yaml, then update this case').toBe(0);
  });

  it.each(POSTURES)('%s: no probe fails on a sealed or uninitialized Vault', (_label, opts) => {
    const { c } = vault(helmTemplate(opts));
    const probes = httpProbes(c);
    expect(probes.map((p) => p.kind)).toEqual(expect.arrayContaining(['readinessProbe', 'livenessProbe']));
    for (const p of probes) {
      expect(p.path.startsWith('/v1/sys/health'), `${p.kind} asks ${p.path}`).toBe(true);
      // Vault answers 503 sealed and 501 uninitialized by default; the kubelet passes 200-399 only.
      for (const code of ['sealedcode', 'uninitcode']) {
        const v = Number(p.params.get(code));
        expect(v >= 200 && v < 400, `${p.kind} fails on ${code.replace('code', '')} (${code}=${p.params.get(code)})`).toBe(true);
      }
      expect(p.params.get('standbyok') === 'true' || Number(p.params.get('standbycode')) < 400, `${p.kind} fails on a standby`).toBe(true);
    }
  }, RENDER_TIMEOUT_MS);

  it('the README runbook names the pod the render creates and the init/unseal commands', () => {
    const { sts } = vault(helmTemplate({}));
    const runbook = /^## Vault runbook\s*$([\s\S]*?)(?=^## )/m.exec(README)?.[1] ?? '';
    expect(runbook, 'deploy/helm/oshal/README.md has no "## Vault runbook" section').not.toBe('');
    expect(runbook).toContain(`${sts.metadata.name}-0`);
    for (const cmd of ['vault operator init', 'vault operator unseal', 'vault_not_configured']) expect(runbook).toContain(cmd);
  }, RENDER_TIMEOUT_MS);
});

describe('infra.vault.tls switches the listener, the api and the probes together', () => {
  it('tls on: the listener serves the operator Secret, the api dials https and trusts only its CA', () => {
    const objects = helmTemplate(TLS);
    const { sts, c, hcl } = vault(objects);
    expect(/tls_disable/.test(hcl), 'TLS on, yet the listener is still plain').toBe(false);
    const certFile = capture(hcl, /tls_cert_file\s*=\s*"([^"]+)"/, 'tls_cert_file');
    const tlsMount = (c.volumeMounts ?? []).find((m: { mountPath: string }) => certFile.startsWith(`${m.mountPath}/`));
    const tlsVol = (sts.spec?.template?.spec?.volumes ?? []).find((v: { name: string }) => v.name === tlsMount?.name);
    expect(tlsVol?.secret?.secretName, 'the certificate is not read from infra.vault.tls.secretName').toBe('guard-vault-tls');
    for (const p of httpProbes(c)) expect(p.scheme, `${p.kind} still probes plain HTTP`).toBe('HTTPS');
    const api = containerOf(objects, 'Deployment', 'oshal-api', 'api');
    const env = resolvedEnv(objects, api);
    expect(env[PLATFORM.addrEnv]).toBe('https://oshal-vault:8200');
    const apiDeploy = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'oshal-api');
    const caVol = (apiDeploy?.spec?.template?.spec?.volumes ?? []).find((v: { secret?: { secretName: string } }) => v.secret?.secretName === 'guard-vault-tls');
    expect(caVol?.secret?.items?.map((i: { key: string }) => i.key), 'the api must mount the CA and nothing else (never tls.key)').toEqual(['ca.crt']);
    const caMount = (api.volumeMounts ?? []).find((m: { name: string }) => m.name === caVol?.name);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(`${caMount?.mountPath}/ca.crt`);
  }, RENDER_TIMEOUT_MS);

  it('tls on with the default Secret name reads that Secret; an empty name fails the render', () => {
    const { sts } = vault(helmTemplate({ sets: ['infra.vault.tls.enabled=true'] }));
    const names = (sts.spec?.template?.spec?.volumes ?? []).map((v: { secret?: { secretName: string } }) => v.secret?.secretName).filter(Boolean);
    const values = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>;
    expect(names).toEqual([values.infra?.vault?.tls?.secretName]);
    const err = helmRefusal({ sets: ['infra.vault.tls.enabled=true', 'infra.vault.tls.secretName='] });
    expect(err).toMatch(/infra\.vault\.tls\.secretName/);
  }, RENDER_TIMEOUT_MS);
});
