/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the chart's production-readiness baseline (chart 0.5.0; remote-cluster work package item 5). The chart shipped no liveness or startup probe anywhere, no container resources on the nine infra workloads, a securityContext on three templates only, no storageClassName on any claim, :latest (or another floating tag) on six infra images, and a workspace claim `helm uninstall` deleted. This renders the REAL chart in four postures (defaults, the Docker Desktop overlay that ran live, the bot-pod example, and every optional switch on with a store package so the init container renders too) and holds every workload to: liveness wherever readiness exists, with the SAME handler (so ArangoDB's unauthenticated path and diarization's key/Host headers carry over), and the same for any startup probe; requests (cpu, memory) and a memory limit on every container, init containers included, with each infra workload's figures coming from its own infra.<name>.resources; RuntimeDefault seccomp, no privilege escalation and every capability dropped; no floating infra image tag; every claim honouring the chart-wide storageClassName and its own override (the override paths are read from values.yaml, not listed here) while an empty value leaves the field out; and the overlay's total memory request fitting the node it declares, after deploy/monitoring's own requests (read from its values) and a kube-system reserve. Finally it evaluates each pod against the Pod Security Standards' Restricted and Baseline rules and holds the README's "Pod Security" table to the result, so the list of workloads that cannot meet Restricted is measured, not asserted. A render is not admission: the real restricted/baseline dry-run is a cluster check.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  CHART_DIR, DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, helmTemplate, type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

const values = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>;
const README = fs.readFileSync(path.join(CHART_DIR, 'README.md'), 'utf8');
const OVERLAY_TEXT = fs.readFileSync(DOCKER_DESKTOP_VALUES, 'utf8');
const MONITORING_VALUES = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'monitoring', 'kube-prometheus-stack.values.yaml'), 'utf8'));

/** kube-system requests on a kind/Docker Desktop node (etcd, two coredns, kindnet: ~290Mi) rounded up. */
const KUBE_SYSTEM_RESERVE_BYTES = 512 * 1024 ** 2;

/** Pod Security Standards (v1.33): the capabilities Baseline lets a container add; Restricted allows only NET_BIND_SERVICE. */
const BASELINE_ADDABLE = new Set(['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT']);
const RESTRICTED_VOLUMES = new Set(['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'persistentVolumeClaim', 'projected', 'secret']);

/** Containers with no health endpoint to probe (tailscaled, socat): each must still exist, so the list cannot go stale. */
const NO_PROBES = ['oshal-relay/tailscale', 'oshal-relay/forwarder'];
/** Keeps the runtime's default capability set plus NET_ADMIN (kernel-mode tailscaled; the pod is hostPath-bound anyway). */
const KEEPS_DEFAULT_CAPS = ['oshal-relay/tailscale'];

/** Every optional switch on, plus a store package so the api's init container renders (derived from values.yaml). */
function everythingOn(node: Record<string, any> = values, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if ((k === 'inCluster' || k === 'enabled') && typeof v === 'boolean') return [`${p}=true`];
    return v && typeof v === 'object' && !Array.isArray(v) ? everythingOn(v, p) : [];
  });
}
const ALL_ON: RenderOptions = { sets: [...everythingOn(), 'packages={guard-package}'] };
const POSTURES: Array<[string, RenderOptions]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
  ['values-bot-pod.example.yaml', { valuesFiles: [path.join(CHART_DIR, 'values-bot-pod.example.yaml')] }],
  ['every optional switch on', ALL_ON],
];

interface Ctr { id: string; owner: string; init: boolean; c: Record<string, any> }
interface Pod { owner: string; bot: boolean; spec: Record<string, any>; containers: Ctr[] }

/**
 * @description Every Deployment/StatefulSet pod template in a render, with its containers.
 * @param objects rendered objects
 * @returns {Pod[]}
 */
function pods(objects: K8sObject[]): Pod[] {
  return objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet').map((o) => {
    const spec = o.spec?.template?.spec ?? {};
    const list = (arr: any[] | undefined, init: boolean): Ctr[] => (arr ?? []).map((c) => ({ id: `${o.metadata.name}/${c.name}`, owner: o.metadata.name, init, c }));
    return {
      owner: o.metadata.name, bot: o.metadata.labels?.['oshal.io/bot'] === 'true', spec,
      containers: [...list(spec.initContainers, true), ...list(spec.containers, false)],
    };
  });
}

/**
 * @description A probe's handler with the timing stripped - what it asks, not how often.
 * @param probe probe spec
 * @returns {string} canonical JSON of the handler
 */
function handler(probe: Record<string, any>): string {
  const { httpGet, tcpSocket, exec, grpc } = probe;
  return JSON.stringify({ httpGet, tcpSocket, exec, grpc });
}

/**
 * @description A Kubernetes quantity in base units (bytes for memory, cores for cpu).
 * @param q quantity string
 * @returns {number}
 */
function quantity(q: string | number): number {
  const m = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|k|K|M|G|T)?$/.exec(String(q));
  if (!m) throw new Error(`unparseable quantity ${q}`);
  const unit: Record<string, number> = { m: 1e-3, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(m[1]) * (m[2] ? unit[m[2]] : 1);
}

/**
 * @description The pod's effective memory request, the way the scheduler counts it: the larger of
 * the biggest init container and the sum of the app containers.
 * @param pod pod
 * @returns {number} bytes
 */
function podMemoryRequest(pod: Pod): number {
  const mem = (c: Ctr) => quantity(c.c.resources?.requests?.memory ?? 0);
  const init = Math.max(0, ...pod.containers.filter((c) => c.init).map(mem));
  return Math.max(init, pod.containers.filter((c) => !c.init).reduce((a, c) => a + mem(c), 0));
}

/**
 * @description Why a pod fails a Pod Security level (empty = it passes), per the published
 * Baseline and Restricted checks the chart can trip.
 * @param pod pod
 * @param level baseline or restricted
 * @returns {string[]} violations
 */
function podSecurityViolations(pod: Pod, level: 'baseline' | 'restricted'): string[] {
  const out: string[] = [];
  const psc = pod.spec.securityContext ?? {};
  if (pod.spec.hostNetwork || pod.spec.hostPID || pod.spec.hostIPC) out.push('host namespaces');
  for (const v of pod.spec.volumes ?? []) {
    const type = Object.keys(v).find((k) => k !== 'name') ?? '';
    if (type === 'hostPath') out.push(`hostPath volume ${v.name}`);
    else if (level === 'restricted' && !RESTRICTED_VOLUMES.has(type)) out.push(`volume type ${type}`);
  }
  for (const { id, c } of pod.containers) {
    const sc = c.securityContext ?? {};
    const add: string[] = sc.capabilities?.add ?? [];
    const seccomp = sc.seccompProfile?.type ?? psc.seccompProfile?.type;
    if (sc.privileged) out.push(`${id}: privileged`);
    if ((c.ports ?? []).some((p: { hostPort?: number }) => p.hostPort)) out.push(`${id}: hostPort`);
    if (seccomp === 'Unconfined') out.push(`${id}: seccomp Unconfined`);
    if (level === 'baseline') {
      for (const cap of add) if (!BASELINE_ADDABLE.has(cap)) out.push(`${id}: adds ${cap}`);
      continue;
    }
    if (sc.allowPrivilegeEscalation !== false) out.push(`${id}: privilege escalation allowed`);
    if ((sc.runAsNonRoot ?? psc.runAsNonRoot) !== true) out.push(`${id}: runAsNonRoot not true`);
    if ((sc.runAsUser ?? psc.runAsUser) === 0) out.push(`${id}: runAsUser 0`);
    if (!['RuntimeDefault', 'Localhost'].includes(seccomp)) out.push(`${id}: no RuntimeDefault/Localhost seccomp`);
    if (!(sc.capabilities?.drop ?? []).includes('ALL')) out.push(`${id}: does not drop ALL`);
    for (const cap of add) if (cap !== 'NET_BIND_SERVICE') out.push(`${id}: adds ${cap}`);
  }
  return out;
}

/**
 * @description Every claim a render creates, as [name, spec] - standalone PVCs and each
 * StatefulSet's volumeClaimTemplates (named <template>-<statefulset>-0, as kubectl shows them).
 * @param objects rendered objects
 * @returns {Array<[string, Record<string, any>]>}
 */
function claims(objects: K8sObject[]): Array<[string, Record<string, any>]> {
  return objects.flatMap((o): Array<[string, Record<string, any>]> => {
    if (o.kind === 'PersistentVolumeClaim') return [[o.metadata.name, o.spec ?? {}]];
    if (o.kind !== 'StatefulSet') return [];
    return (o.spec?.volumeClaimTemplates ?? []).map((t: any) => [`${t.metadata.name}-${o.metadata.name}-0`, t.spec ?? {}]);
  });
}

/**
 * @description The dotted values paths of every storage-class override (keys named
 * storageClassName or ending in StorageClassName), excluding the chart-wide top-level one.
 * @param node values subtree
 * @param prefix dotted path
 * @returns {string[]}
 */
function storageClassPaths(node: Record<string, any> = values, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if (/(^s|S)torageClassName$/.test(k) && typeof v === 'string') return prefix ? [p] : [];
    return v && typeof v === 'object' && !Array.isArray(v) ? storageClassPaths(v, p) : [];
  });
}

describe('probes: liveness wherever readiness exists, asking the same thing', () => {
  it('the no-probe exemptions still name real containers', () => {
    const ids = pods(helmTemplate(ALL_ON)).flatMap((p) => p.containers.map((c) => c.id));
    expect(ids).toEqual(expect.arrayContaining([...NO_PROBES, ...KEEPS_DEFAULT_CAPS]));
  }, RENDER_TIMEOUT_MS);

  it.each(POSTURES)('%s: every app container has readiness and liveness with one handler, and startup (if any) matches', (_label, opts) => {
    const all = pods(helmTemplate(opts)).flatMap((p) => p.containers).filter((c) => !c.init && !NO_PROBES.includes(c.id));
    expect(all.length, 'no containers rendered - nothing was checked').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const { id, c } of all) {
      if (!c.readinessProbe) { bad.push(`${id}: no readinessProbe`); continue; }
      if (!c.livenessProbe) { bad.push(`${id}: readiness but no livenessProbe`); continue; }
      if (handler(c.livenessProbe) !== handler(c.readinessProbe)) bad.push(`${id}: liveness asks something readiness does not`);
      if (c.startupProbe && handler(c.startupProbe) !== handler(c.readinessProbe)) bad.push(`${id}: startup asks something readiness does not`);
    }
    expect(bad).toEqual([]);
  }, RENDER_TIMEOUT_MS);
});

describe('resources: every container requests cpu and memory and has a memory limit', () => {
  it.each(POSTURES)('%s: requests and limits on every container, init containers included', (_label, opts) => {
    const bad: string[] = [];
    for (const { id, c } of pods(helmTemplate(opts)).flatMap((p) => p.containers)) {
      const r = c.resources ?? {};
      if (!r.requests?.cpu || !r.requests?.memory) bad.push(`${id}: missing cpu/memory request`);
      else if (!r.limits?.memory) bad.push(`${id}: no memory limit`);
      else if (quantity(r.requests.memory) > quantity(r.limits.memory)) bad.push(`${id}: memory request above its limit`);
    }
    expect(bad).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('each infra workload takes its figures from its own infra.<name>.resources', () => {
    const keys = Object.keys(values.infra);
    expect(keys.filter((k) => !values.infra[k].resources), 'an infra service has no resources in values.yaml').toEqual([]);
    const sentinel = (i: number) => `${301 + i}Mi`;
    const objects = helmTemplate({ sets: [...ALL_ON.sets!, ...keys.map((k, i) => `infra.${k}.resources.requests.memory=${sentinel(i)}`)] });
    const seen = new Map<string, string[]>();
    for (const { id, c } of pods(objects).flatMap((p) => p.containers)) {
      const m = String(c.resources?.requests?.memory);
      seen.set(m, [...(seen.get(m) ?? []), id]);
    }
    const wrong = keys.map((k, i) => [k, seen.get(sentinel(i)) ?? []] as const).filter(([, ids]) => ids.length !== 1);
    expect(wrong.map(([k, ids]) => `infra.${k}.resources -> [${ids.join(', ')}]`), 'each infra resources value must reach exactly one container').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('the Docker Desktop overlay fits the node it declares, beside kube-system and deploy/monitoring', () => {
    const node = /Sized for one ~(\d+(?:\.\d+)?) GiB node/.exec(OVERLAY_TEXT)?.[1];
    expect(node, 'values-docker-desktop.yaml no longer says which node it is sized for').toBeTruthy();
    let monitoring = 0;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const req = (n as any).requests;
      if (req && typeof req === 'object' && req.memory) monitoring += quantity(req.memory);
      Object.values(n).forEach(walk);
    };
    walk(MONITORING_VALUES);
    expect(monitoring, 'read no memory request from deploy/monitoring - the walk is broken').toBeGreaterThan(0);
    const budget = Number(node) * 1024 ** 3 - monitoring - KUBE_SYSTEM_RESERVE_BYTES;
    const asked = pods(helmTemplate({ valuesFiles: [DOCKER_DESKTOP_VALUES] })).reduce((a, p) => a + podMemoryRequest(p), 0);
    const mi = (b: number) => `${Math.round(b / 1024 ** 2)}Mi`;
    expect(asked, `the overlay asks ${mi(asked)}; the node leaves ${mi(budget)} after monitoring and kube-system`).toBeLessThanOrEqual(budget);
  }, RENDER_TIMEOUT_MS);
});

describe('securityContext: seccomp, no escalation, capabilities dropped', () => {
  it.each(POSTURES)('%s: every pod RuntimeDefault, every container no escalation and drop ALL', (_label, opts) => {
    const bad: string[] = [];
    for (const pod of pods(helmTemplate(opts))) {
      const podSeccomp = pod.spec.securityContext?.seccompProfile?.type;
      for (const { id, c } of pod.containers) {
        const sc = c.securityContext ?? {};
        if ((sc.seccompProfile?.type ?? podSeccomp) !== 'RuntimeDefault') bad.push(`${id}: seccomp not RuntimeDefault`);
        if (sc.allowPrivilegeEscalation !== false) bad.push(`${id}: allowPrivilegeEscalation not false`);
        if (!KEEPS_DEFAULT_CAPS.includes(id) && !(sc.capabilities?.drop ?? []).includes('ALL')) bad.push(`${id}: does not drop ALL`);
      }
    }
    expect(bad).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it.each(POSTURES.slice(0, 2))('%s: every pod meets the Baseline Pod Security Standard', (_label, opts) => {
    const bad = pods(helmTemplate(opts)).flatMap((p) => podSecurityViolations(p, 'baseline').map((v) => `${p.owner}: ${v}`));
    expect(bad).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('the README "Pod Security" table is exactly what the render meets', () => {
    const section = /^\*\*Pod Security\.\*\*([\s\S]*?)(?=^## )/m.exec(README)?.[1] ?? '';
    const rows = section.split('\n').filter((l) => /^\|\s*`/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
    expect(rows.length, 'no Pod Security table in the README').toBeGreaterThan(3);
    const all = pods(helmTemplate(ALL_ON));
    const bots = all.filter((p) => p.bot).map((p) => p.owner);
    const claimed = new Map<string, string>();
    for (const r of rows) {
      const names = [...r[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const expanded = /every bot/.test(r[1]) ? [...names, ...bots] : names;
      const level = /^yes/.test(r[3]) ? 'restricted' : /Baseline/.test(r[3]) ? 'baseline' : 'privileged';
      for (const n of expanded) claimed.set(n, level);
    }
    const measured = all.map((p) => {
      const level = podSecurityViolations(p, 'restricted').length === 0 ? 'restricted'
        : podSecurityViolations(p, 'baseline').length === 0 ? 'baseline' : 'privileged';
      return `${p.owner}=${level}`;
    }).sort();
    const stated = all.map((p) => `${p.owner}=${claimed.get(p.owner) ?? 'NOT IN THE TABLE'}`).sort();
    expect(stated, 'README Pod Security table and the rendered pods disagree').toEqual(measured);
  }, RENDER_TIMEOUT_MS);
});

describe('images and storage', () => {
  it.each(POSTURES)('%s: no infra image uses a floating tag', (_label, opts) => {
    const objects = helmTemplate(opts);
    const platform = new Set(pods(objects).flatMap((p) => p.containers)
      .filter((c) => ['api', 'bot', 'stage-packages'].includes(c.c.name)).map((c) => c.c.image));
    const floating = pods(objects).flatMap((p) => p.containers).filter((c) => !platform.has(c.c.image)).filter((c) => {
      const ref = String(c.c.image).split('@')[0];
      const tag = /:([^/:]+)$/.exec(ref)?.[1];
      return !tag || /^(latest|stable|edge|main|master)$|^latest-/.test(tag);
    }).map((c) => `${c.id}: ${c.c.image}`);
    expect(floating).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('an empty storageClassName leaves every claim on the cluster default', () => {
    const set = claims(helmTemplate(ALL_ON)).filter(([, spec]) => 'storageClassName' in spec).map(([n]) => n);
    expect(set, 'these claims render a storageClassName with nothing set').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('the chart-wide storageClassName reaches every claim', () => {
    const all = claims(helmTemplate({ sets: [...ALL_ON.sets!, 'storageClassName=guard-global'] }));
    expect(all.length, 'no claims rendered').toBeGreaterThan(5);
    expect(all.filter(([, s]) => s.storageClassName !== 'guard-global').map(([n]) => n)).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('every claim has its own override, and each override reaches exactly one claim', () => {
    const paths = storageClassPaths();
    const all = claims(helmTemplate({ sets: [...ALL_ON.sets!, 'storageClassName=guard-global', ...paths.map((p, i) => `${p}=guard-${i}`)] }));
    expect(paths.length, 'the override paths and the claims differ in number').toBe(all.length);
    const unmatched = all.filter(([, s]) => !/^guard-\d+$/.test(s.storageClassName)).map(([n]) => n);
    expect(unmatched, 'these claims ignore their own override').toEqual([]);
    const used = all.map(([, s]) => s.storageClassName).sort();
    expect(new Set(used).size, 'two claims share one override').toBe(used.length);
  }, RENDER_TIMEOUT_MS);
});
