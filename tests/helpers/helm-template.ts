/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared real-`helm template` renderer for the chart guards written after the first Docker Desktop Kubernetes install (chart-readiness-probes, chart-shared-env-extra, chart-monitoring-parity). One copy, so a flag or parse change reaches every guard that uses it. A missing helm binary is a loud failure, never a skip: these guards render the REAL chart.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | resolvedEnv: the environment a container actually starts with, resolved the way the kubelet does it - envFrom sources in order (later wins), then explicit env entries over all of them - against the ConfigMaps and Secrets the SAME render creates. A reference to an object the chart does not render (the optional api.envSecret an operator creates) resolves to nothing, because a guard asking "does the chart supply this" must not count a Secret nobody has made. Used by the bootstrap-env guard (rbac.botLauncher=false) and every guard that reads a value moved out of a literal env entry.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import yaml from 'js-yaml';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const CHART_DIR = path.join(REPO_ROOT, 'deploy', 'helm', 'oshal');
export const DOCKER_DESKTOP_VALUES = path.join(CHART_DIR, 'values-docker-desktop.yaml');
export const RENDER_TIMEOUT_MS = 120_000;

/** A rendered Kubernetes object, typed only as far as the chart guards read it. */
export interface K8sObject {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: Record<string, any>;
  data?: Record<string, unknown>;
}

/** What to render: --set expressions and -f values files (absolute paths). */
export interface RenderOptions {
  sets?: string[];
  valuesFiles?: string[];
}

const renders = new Map<string, K8sObject[]>();

/**
 * @description Render deploy/helm/oshal with the real helm binary (namespace `oshal`, release
 * `oshal`) and parse every document. Memoised per option set so a posture renders once per run.
 * @param opts --set expressions and values files; empty renders the chart defaults
 * @returns {K8sObject[]} every rendered object that carries a kind
 */
export function helmTemplate(opts: RenderOptions = {}): K8sObject[] {
  const sets = opts.sets ?? [];
  const files = opts.valuesFiles ?? [];
  const key = JSON.stringify([files, sets]);
  const cached = renders.get(key);
  if (cached) return cached;
  const args = [
    'template', 'oshal', CHART_DIR, '--namespace', 'oshal',
    ...files.flatMap((f) => ['-f', f]),
    ...sets.flatMap((s) => ['--set', s]),
  ];
  let out: string;
  try {
    out = execFileSync('helm', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    const why = e.code === 'ENOENT' ? 'the helm binary is not on PATH' : (e.stderr || e.message);
    throw new Error(`helm template failed (${key}): ${why} - this guard renders the REAL chart and does not skip`);
  }
  const docs = (yaml.loadAll(out) as unknown[]).filter(
    (d): d is K8sObject => Boolean(d && typeof d === 'object' && (d as K8sObject).kind),
  );
  renders.set(key, docs);
  return docs;
}

/**
 * @description One named container of one named workload in a render. Throws when either is
 * absent, so no later assertion can pass against nothing.
 * @param objects rendered objects
 * @param kind workload kind (Deployment / StatefulSet)
 * @param name workload metadata.name
 * @param containerName container name inside the pod template
 * @returns the container spec
 */
export function containerOf(objects: K8sObject[], kind: string, name: string, containerName: string): Record<string, any> {
  const workload = objects.find((o) => o.kind === kind && o.metadata.name === name);
  const container = workload?.spec?.template?.spec?.containers?.find((c: { name: string }) => c.name === containerName);
  if (!container) throw new Error(`render has no ${kind}/${name} with a "${containerName}" container`);
  return container;
}

/**
 * @description The literal value of an explicit env entry on a container.
 * @param container container spec
 * @param name env name
 * @returns {string | undefined} the value, or undefined when the entry is absent or not a literal
 */
export function envValue(container: Record<string, any>, name: string): string | undefined {
  const entry = (container.env ?? []).find((e: { name: string }) => e.name === name);
  return typeof entry?.value === 'string' ? entry.value : undefined;
}

/**
 * @description The string data of a ConfigMap or Secret the render creates: a Secret's stringData
 * as written, its data base64-decoded, a ConfigMap's data as written.
 * @param objects rendered objects
 * @param kind ConfigMap or Secret
 * @param name metadata.name
 * @returns {Record<string, string> | undefined} undefined when the render has no such object
 */
export function renderedData(objects: K8sObject[], kind: 'ConfigMap' | 'Secret', name: string): Record<string, string> | undefined {
  const o = objects.find((x) => x.kind === kind && x.metadata.name === name) as (K8sObject & { stringData?: Record<string, string> }) | undefined;
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.data ?? {})) {
    out[k] = kind === 'Secret' ? Buffer.from(String(v), 'base64').toString('utf8') : String(v);
  }
  for (const [k, v] of Object.entries(o.stringData ?? {})) out[k] = String(v);
  return out;
}

/**
 * @description One explicit env entry resolved against the render: a literal value, or a
 * secretKeyRef / configMapKeyRef into an object this render creates.
 * @param objects rendered objects
 * @param entry container env entry
 * @returns {string | undefined} undefined when it points outside the render (or is a field ref)
 */
function resolveEntry(objects: K8sObject[], entry: Record<string, any>): string | undefined {
  if (typeof entry.value === 'string') return entry.value;
  const secret = entry.valueFrom?.secretKeyRef;
  if (secret) return renderedData(objects, 'Secret', secret.name)?.[secret.key];
  const cm = entry.valueFrom?.configMapKeyRef;
  if (cm) return renderedData(objects, 'ConfigMap', cm.name)?.[cm.key];
  return undefined;
}

/**
 * @description The environment a container starts with, as far as THIS render supplies it:
 * envFrom sources in order (a later source wins a duplicate key), then every explicit env entry
 * over them - the kubelet's precedence. Sources the render does not create contribute nothing.
 * @param objects rendered objects
 * @param container container spec
 * @returns {Record<string, string>} resolved environment
 */
export function resolvedEnv(objects: K8sObject[], container: Record<string, any>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const src of container.envFrom ?? []) {
    const data = src.configMapRef
      ? renderedData(objects, 'ConfigMap', src.configMapRef.name)
      : src.secretRef ? renderedData(objects, 'Secret', src.secretRef.name) : undefined;
    Object.assign(env, data ?? {});
  }
  for (const entry of container.env ?? []) {
    const value = resolveEntry(objects, entry);
    if (value !== undefined) env[entry.name] = value;
    else delete env[entry.name];
  }
  return env;
}
