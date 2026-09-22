/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for what the chart gives, and cannot give, a bot the controller launches at runtime (remote-cluster work package item 5, review follow-up). buildBotDeployment in src/features/agent-management/services/kubernetes-bot-launcher.ts sets no resources, no securityContext and no liveness or startup probe, so under a ResourceQuota that requires requests its pods would be refused, while the chart README said "every container" had requests, limits, seccomp and dropped capabilities. The chart now renders the oshal-container-defaults LimitRange (templates/limitrange.yaml). This renders the real chart (defaults and the Docker Desktop overlay that ran live) and holds: one LimitRange on a main cluster with default requests (cpu, memory) AND a default memory limit for containers, and no default CPU limit (no chart container sets one - measured here, and the reason a default one could refuse chart pods); every default no larger than any chart-declared bot's own figure; none on bot-pod or with limitRange.enabled=false; a CPU limit in botDefaults refused with its reason. It admits the REAL launcher's container through that LimitRange, following the API server's defaulting (pod defaults, LimitRangeItem defaults, then LimitRanger - modelled here, not run) and requires cpu and memory requests and a memory limit no larger than a chart bot's, while every chart container admits unchanged. Last, it measures from the real launcher against a real chart bot what the launcher leaves out (resources, seccomp, the container securityContext, liveness and startup probes) and holds the README to it: while anything is missing, "Probes, resources and Pod Security" carries a paragraph naming buildBotDeployment and each missing item, every universal claim in that section is scoped to what the chart renders, and "Dynamic bots" links to it; once nothing is missing the paragraph must go. Admission itself is a cluster check.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildBotDeployment } from '@/features/agent-management/services/kubernetes-bot-launcher';
import {
  CHART_DIR, DOCKER_DESKTOP_VALUES, RENDER_TIMEOUT_MS, helmRefusal, helmTemplate, quantity, type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

const README = fs.readFileSync(path.join(CHART_DIR, 'README.md'), 'utf8');
const BOT_POD_VALUES = path.join(CHART_DIR, 'values-bot-pod.example.yaml');
const LAUNCHER_FILE = 'src/features/agent-management/services/kubernetes-bot-launcher.ts';
const POD_SECTION = 'Probes, resources and Pod Security';

/** Main-cluster postures: the api can launch bots at runtime, and the LimitRange renders. */
const MAIN: Array<[string, RenderOptions]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
];
/** Postures that must render no LimitRange. */
const NONE: Array<[string, RenderOptions]> = [
  ['--set role=bot-pod', { sets: ['role=bot-pod'] }],
  ['values-bot-pod.example.yaml', { valuesFiles: [BOT_POD_VALUES] }],
  ['limitRange.enabled=false', { sets: ['limitRange.enabled=false'] }],
];

type Obj = Record<string, any>;
interface Ctr { id: string; c: Obj }

/**
 * What a chart-declared bot carries, checked on the pod and its container, with the README words
 * that name each one. `resources` is the one a LimitRange can supply, so its words include it.
 */
const CHART_BOT_HAS: Array<{ item: string; has: (pod: Obj, c: Obj) => boolean; named: RegExp[] }> = [
  { item: 'resources', has: (_p, c) => Boolean(c.resources?.requests?.memory), named: [/`resources`/, /oshal-container-defaults/] },
  { item: 'a seccomp profile', has: (p, c) => Boolean(c.securityContext?.seccompProfile?.type ?? p.securityContext?.seccompProfile?.type), named: [/seccomp/] },
  {
    item: 'a container securityContext (no privilege escalation, capabilities dropped)',
    has: (_p, c) => c.securityContext?.allowPrivilegeEscalation === false && (c.securityContext?.capabilities?.drop ?? []).includes('ALL'),
    named: [/`securityContext`/, /privilege escalation/, /capabilit/],
  },
  { item: 'a liveness probe', has: (_p, c) => Boolean(c.livenessProbe), named: [/liveness/] },
  { item: 'a startup probe', has: (_p, c) => Boolean(c.startupProbe), named: [/startup/] },
];

/**
 * @description The pod and container the REAL launcher builds for a runtime bot.
 * @returns {{ pod: Obj, container: Obj }}
 */
function launched(): { pod: Obj; container: Obj } {
  const deployment = buildBotDeployment(
    { agentName: 'probe-bot', agentId: 'e0000000-0000-0000-0000-00000000f00d' }, 'oshal', 'probe-image',
  ) as Obj;
  const pod = deployment.spec.template.spec;
  return { pod, container: pod.containers[0] };
}

/**
 * @description Every chart-declared bot (label oshal.io/bot=true) with its pod and bot container.
 * @param objects rendered objects
 * @returns {Array<{ name: string, pod: Obj, c: Obj }>}
 */
function chartBots(objects: K8sObject[]): Array<{ name: string; pod: Obj; c: Obj }> {
  return objects.filter((o) => o.kind === 'Deployment' && o.metadata.labels?.['oshal.io/bot'] === 'true').map((o) => {
    const pod = o.spec?.template?.spec ?? {};
    return { name: o.metadata.name, pod, c: pod.containers?.[0] ?? {} };
  });
}

/**
 * @description Every container, init containers included, of every pod template the chart renders.
 * @param objects rendered objects
 * @returns {Ctr[]}
 */
function chartContainers(objects: K8sObject[]): Ctr[] {
  return objects.filter((o) => o.spec?.template?.spec).flatMap((o) => {
    const spec = o.spec!.template.spec;
    return [...(spec.initContainers ?? []), ...(spec.containers ?? [])].map((c: Obj) => ({ id: `${o.metadata.name}/${c.name}`, c }));
  });
}

/**
 * @description The Container item of the render's one LimitRange. Throws unless there is exactly one
 * LimitRange holding exactly one Container item, so no assertion can pass against an absence.
 * @param objects rendered objects
 * @returns {Obj} the LimitRangeItem
 */
function containerDefaults(objects: K8sObject[]): Obj {
  const ranges = objects.filter((o) => o.kind === 'LimitRange');
  if (ranges.length !== 1) throw new Error(`expected one LimitRange in the render, found ${ranges.length}`);
  const items = (ranges[0].spec?.limits ?? []).filter((l: Obj) => l.type === 'Container');
  if (items.length !== 1) throw new Error(`expected one Container item in LimitRange ${ranges[0].metadata.name}, found ${items.length}`);
  return items[0];
}

/**
 * @description A container's resources once the API server has admitted its pod: pod defaulting
 * (a resource with a limit and no request is requested at the limit), the LimitRangeItem's own
 * defaulting (a default limit with no default request is also the default request), then
 * LimitRanger (each default fills only a resource the container leaves unset). Modelled from those
 * upstream rules; no API server runs here.
 * @param container container spec
 * @param item LimitRangeItem of type Container ({} = no LimitRange)
 * @returns {{ requests: Obj, limits: Obj }}
 */
function admitted(container: Obj, item: Obj): { requests: Obj; limits: Obj } {
  const limits: Obj = { ...(container.resources?.limits ?? {}) };
  const requests: Obj = { ...limits, ...(container.resources?.requests ?? {}) };
  const defaultRequest: Obj = { ...(item.default ?? {}), ...(item.defaultRequest ?? {}) };
  for (const [k, v] of Object.entries(item.default ?? {})) if (!(k in limits)) limits[k] = v;
  for (const [k, v] of Object.entries(defaultRequest)) if (!(k in requests)) requests[k] = v;
  return { requests, limits };
}

/**
 * @description Where `mine` exceeds `theirs` on the three figures a LimitRange defaults here.
 * @param who label for the message
 * @param mine resources being held down
 * @param theirs resources they must not exceed
 * @returns {string[]} one line per excess (a figure `theirs` lacks counts as an excess)
 */
function larger(who: string, mine: { requests?: Obj; limits?: Obj }, theirs: { requests?: Obj; limits?: Obj }): string[] {
  const fields: Array<['requests' | 'limits', string]> = [['requests', 'cpu'], ['requests', 'memory'], ['limits', 'memory']];
  return fields.flatMap(([kind, res]) => {
    const a = mine[kind]?.[res];
    const b = theirs[kind]?.[res];
    return a !== undefined && (b === undefined || quantity(a) > quantity(b)) ? [`${who}: ${kind}.${res} ${a} > ${b ?? 'none'}`] : [];
  });
}

/**
 * @description One `## ` section of the chart README, heading line included.
 * @param title heading text it starts with
 * @returns {string} the section, or '' when absent
 */
function section(title: string): string {
  return README.split(/^## /m).find((s) => s.startsWith(title)) ?? '';
}

/**
 * @description The paragraph of the Pod Security section that states the runtime-bot gap, with its
 * line wrapping collapsed so a phrase split across two lines still matches.
 * @returns {string | undefined}
 */
function gapParagraph(): string | undefined {
  return section(POD_SECTION).split(/\n\s*\n/).find((p) => p.includes('buildBotDeployment'))?.replace(/\s+/g, ' ');
}

describe.each(MAIN)('%s: the namespace LimitRange', (_label, opts) => {
  it('renders once, with default requests (cpu, memory) AND a default memory limit for containers, and no default CPU limit', () => {
    const item = containerDefaults(helmTemplate(opts));
    expect(Object.keys(item.defaultRequest ?? {}), 'default requests').toEqual(expect.arrayContaining(['cpu', 'memory']));
    expect(item.default?.memory, 'no default memory limit').toBeTruthy();
    expect(Object.keys(item.default ?? {}), 'a default limit on anything but memory lands on every chart container too').toEqual(['memory']);
  }, RENDER_TIMEOUT_MS);

  it('no default is larger than any chart-declared bot\'s own figure', () => {
    const objects = helmTemplate(opts);
    const item = containerDefaults(objects);
    const bots = chartBots(objects);
    expect(bots.length, 'no chart-declared bot rendered - nothing to compare against').toBeGreaterThan(0);
    const defaults = { requests: item.defaultRequest, limits: item.default };
    expect(bots.flatMap((b) => larger(`LimitRange vs ${b.name}`, defaults, b.c.resources ?? {}))).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('the REAL launcher\'s container, admitted through it, requests cpu and memory and has a memory limit, none above a chart bot\'s', () => {
    const objects = helmTemplate(opts);
    const got = admitted(launched().container, containerDefaults(objects));
    expect(got.requests.cpu, 'admitted with no cpu request').toBeTruthy();
    expect(got.requests.memory, 'admitted with no memory request').toBeTruthy();
    expect(got.limits.memory, 'admitted with no memory limit').toBeTruthy();
    expect(chartBots(objects).flatMap((b) => larger(`runtime bot vs ${b.name}`, got, b.c.resources ?? {}))).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('every chart container admits unchanged, and none sets a CPU limit for a default one to collide with', () => {
    const objects = helmTemplate(opts);
    const item = containerDefaults(objects);
    const all = chartContainers(objects);
    expect(all.length, 'no containers rendered').toBeGreaterThan(0);
    const changed = all.filter(({ c }) => JSON.stringify(admitted(c, item)) !== JSON.stringify(admitted(c, {}))).map(({ id }) => id);
    expect(changed, 'the LimitRange changes these chart containers at admission').toEqual([]);
    expect(all.filter(({ c }) => c.resources?.limits?.cpu !== undefined).map(({ id }) => id), 'the template and README say no chart container sets a CPU limit').toEqual([]);
  }, RENDER_TIMEOUT_MS);
});

describe('where the LimitRange does not render, and what it refuses', () => {
  it.each(NONE)('%s: no LimitRange', (_label, opts) => {
    expect(helmTemplate(opts).filter((o) => o.kind === 'LimitRange').map((o) => o.metadata.name)).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('a CPU limit in botDefaults is refused while it is on, naming the key and the way out; with it off the chart renders', () => {
    const refusal = helmRefusal({ sets: ['botDefaults.resources.limits.cpu=1'] });
    expect(refusal, 'helm rendered a botDefaults CPU limit into a namespace default').toContain('botDefaults.resources.limits.cpu');
    expect(refusal).toContain('limitRange.enabled=false');
    const off = helmTemplate({ sets: ['botDefaults.resources.limits.cpu=1', 'limitRange.enabled=false'] });
    expect(off.some((o) => o.kind === 'LimitRange')).toBe(false);
  }, 2 * RENDER_TIMEOUT_MS);
});

describe('what the launcher leaves out, measured from the real launcher and held in the README', () => {
  it.each(MAIN)('%s: every check holds for a chart-declared bot, so the comparison measures something', (_label, opts) => {
    const bad = chartBots(helmTemplate(opts)).flatMap((b) => CHART_BOT_HAS.filter((k) => !k.has(b.pod, b.c)).map((k) => `${b.name}: no ${k.item}`));
    expect(bad).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('while the launcher lacks any of it, the README says so beside the claims, naming buildBotDeployment; once it lacks none, it says nothing', () => {
    const { pod, container } = launched();
    const missing = CHART_BOT_HAS.filter((k) => !k.has(pod, container));
    const paragraph = gapParagraph();
    if (missing.length === 0) {
      expect(paragraph, 'the launcher now sets all of it - remove the README gap paragraph and close the BACKLOG entry').toBeUndefined();
      return;
    }
    expect(paragraph, `README "${POD_SECTION}" does not say a runtime-launched bot lacks ${missing.map((k) => k.item).join(', ')}`).toBeTruthy();
    expect(paragraph!, 'the gap paragraph does not name the launcher file').toContain(LAUNCHER_FILE);
    for (const k of missing) for (const re of k.named) expect(paragraph!, `the gap paragraph does not name ${k.item} (${re})`).toMatch(re);
    if (container.readinessProbe) expect(paragraph!, 'the launcher does set a readiness probe; the paragraph must not say it has none').toMatch(/readiness probe/);
  });

  it('every universal claim in that section is scoped to what the chart renders', () => {
    const prose = section(POD_SECTION).split('\n').filter((l) => !l.startsWith('|')).join(' ').replace(/\s+/g, ' ');
    expect(prose.length, `the README has no "${POD_SECTION}" section`).toBeGreaterThan(0);
    const sentences = prose.split(/(?<=[.:])\s+(?=[A-Z*`])/);
    const unscoped = sentences.filter((s) => /\b(every|each|all)\s+(container|pod|workload)s?\b/i.test(s) && !/\bchart\b/i.test(s));
    expect(unscoped, 'these sentences claim every container/pod/workload without saying "the chart renders"').toEqual([]);
  });

  it('while the gap exists, "Dynamic bots" links to it instead of calling the runtime bot a chart bot\'s shape', () => {
    const { pod, container } = launched();
    if (CHART_BOT_HAS.every((k) => k.has(pod, container))) return;
    const dynamic = section('Dynamic bots');
    expect(dynamic, 'the README has no Dynamic bots section').not.toBe('');
    expect(dynamic, 'Dynamic bots does not point at the runtime-bot gap').toContain('(#probes-resources-and-pod-security)');
  });
});
