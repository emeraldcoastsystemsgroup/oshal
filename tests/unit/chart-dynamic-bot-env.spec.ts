/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for what chart 0.5.0 took from a bot the controller launches at runtime. Moving JWT_SECRET and ARANGO_ROOT_* out of the oshal-shared-env ConfigMap into the oshal-shared-secret Secret reached every chart-declared bot (bots.yaml envFrom it) but not a runtime-launched one: buildBotDeployment in src/features/agent-management/services/kubernetes-bot-launcher.ts hardcodes envFrom to oshal-shared-env plus the optional oshal-bot-env, the ConfigMap sets NODE_ENV=production, and any-bot's config throws "JWT_SECRET must be set in production" at boot. Closing that is a core change awaiting operator approval (docs/BACKLOG.md), so the chart's fix is an install-time warning with a copy command. This guard measures the gap from the REAL launcher (buildBotDeployment, called, not parsed) against the REAL render (helm template, resolved the kubelet's way), proves it is boot-fatal by loading the REAL any-bot config module with exactly the env such a bot would get, and then holds the chart to it: while the gap exists, the NOTES.txt helm install prints (rendered offline, helmNotes) and the README carry a command that copies the chart Secret into the launcher's Secret, that copy closes the gap and lets the config load, the notes stay silent where no launcher runs, and a BACKLOG entry tracks the core fix. Once the launcher reads the chart Secret itself, the warning and the copy step must go - this guard turns red until they do.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildBotDeployment } from '@/features/agent-management/services/kubernetes-bot-launcher';
import {
  CHART_DIR, DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmNotes, helmTemplate, renderedData,
  resolvedEnv, type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

const ANY_BOT_CONFIG = path.join(REPO_ROOT, 'any-bot', 'server', 'utils', 'config.js');
const README = fs.readFileSync(path.join(CHART_DIR, 'README.md'), 'utf8');
const BACKLOG = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'BACKLOG.md'), 'utf8');
const BOT_POD_VALUES = path.join(CHART_DIR, 'values-bot-pod.example.yaml');
const BOOT_TIMEOUT_MS = 60_000;

/** Postures in which the api can launch bots at runtime (role main, rbac.botLauncher on). */
const LAUNCHER_ON: Array<[string, RenderOptions]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
];
/** Postures in which nothing launches a bot at runtime. */
const LAUNCHER_OFF: Array<[string, RenderOptions]> = [
  ['rbac.botLauncher=false', { sets: ['rbac.botLauncher=false'] }],
  ['values-bot-pod.example.yaml', { valuesFiles: [BOT_POD_VALUES] }],
];

type Container = Record<string, any>;

/**
 * @description The bot container exactly as the launcher builds it, with process.env carrying the
 * api's resolved BOT_DATABASE_URL, as it does inside the api pod the launcher runs in.
 * @param objects rendered objects
 * @returns {Container} the launcher's container spec
 */
function launchedBot(objects: K8sObject[]): Container {
  const api = resolvedEnv(objects, containerOf(objects, 'Deployment', 'oshal-api', 'api'));
  const saved = process.env.BOT_DATABASE_URL;
  try {
    if (api.BOT_DATABASE_URL) process.env.BOT_DATABASE_URL = api.BOT_DATABASE_URL;
    else delete process.env.BOT_DATABASE_URL;
    const deployment = buildBotDeployment(
      { agentName: 'probe-bot', agentId: 'e0000000-0000-0000-0000-00000000f00d' }, 'oshal', 'probe-image',
    ) as { spec: { template: { spec: { containers: Container[] } } } };
    return deployment.spec.template.spec.containers[0];
  } finally {
    if (saved === undefined) delete process.env.BOT_DATABASE_URL;
    else process.env.BOT_DATABASE_URL = saved;
  }
}

/**
 * @description The first chart-declared bot container in a render (label oshal.io/bot=true).
 * @param objects rendered objects
 * @returns {Container} its container spec
 */
function chartBot(objects: K8sObject[]): Container {
  const bot = objects.find((o) => o.kind === 'Deployment' && o.metadata.labels?.['oshal.io/bot'] === 'true');
  const container = bot?.spec?.template?.spec?.containers?.[0];
  if (!container) throw new Error('the render has no chart-declared bot - nothing to compare against');
  return container;
}

/**
 * @description The Secret names in a container's envFrom that the render does NOT create: the
 * ones an operator must make. For the launcher that is its optional oshal-bot-env.
 * @param objects rendered objects
 * @param container container spec
 * @returns {string[]} operator-owned Secret names
 */
function operatorSecrets(objects: K8sObject[], container: Container): string[] {
  return (container.envFrom ?? [])
    .map((s: { secretRef?: { name: string } }) => s.secretRef?.name)
    .filter((n: string | undefined): n is string => Boolean(n) && !renderedData(objects, 'Secret', n!));
}

/**
 * @description The keys a chart-declared bot gets from an object the chart renders (its envFrom
 * ConfigMaps and Secrets) that a runtime-launched bot does not resolve at all.
 * @param objects rendered objects
 * @returns {string[]} the gap, sorted
 */
function gap(objects: K8sObject[]): string[] {
  const launched = resolvedEnv(objects, launchedBot(objects));
  const fromChart = (chartBot(objects).envFrom ?? []).flatMap((s: Record<string, { name: string }>) => Object.keys(
    (s.configMapRef ? renderedData(objects, 'ConfigMap', s.configMapRef.name) : renderedData(objects, 'Secret', s.secretRef.name)) ?? {},
  ));
  return [...new Set<string>(fromChart)].filter((k) => !(k in launched)).sort();
}

/**
 * @description Load the REAL any-bot config module (what bot-node boot requires first) in a child
 * node process whose environment is exactly `env`. Only the three directories the module creates
 * are pointed into a temp dir, so loading it writes nothing outside the test.
 * @param env the bot's resolved environment
 * @returns {{ ok: boolean, output: string }} whether it loaded, and what it printed
 */
function bootConfig(env: Record<string, string>): { ok: boolean; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-bot-boot-'));
  try {
    const res = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(ANY_BOT_CONFIG)})`], {
      cwd: dir, encoding: 'utf8', timeout: BOOT_TIMEOUT_MS,
      env: {
        ...env, PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        LOG_DIR: path.join(dir, 'logs'), WORKSPACE_DIR: path.join(dir, 'ws'), DATABASE_PATH: path.join(dir, 'data', 'cline.db'),
      },
    });
    return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error?.message ?? ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The copy command: patch the launcher's Secret with the whole .data of a chart Secret. */
const COPY_COMMAND = /kubectl -n (\S+) patch secret (\S+) --type merge\s*(?:\\\s*)?-p "\{\\"data\\":\$\(kubectl -n (\S+) get secret (\S+) -o jsonpath='\{\.data\}'\)\}"/;

/**
 * @description Apply the copy command's effect to a render: a JSON merge patch of the source
 * Secret's data onto the target Secret, which already holds an operator key (SWARM_SERVICE_SECRET,
 * the key values-docker-desktop.yaml says bots need anyway). Merge-patch semantics were checked
 * against kubectl itself (patch --local); this models only that documented effect.
 * @param objects rendered objects
 * @param target Secret the command patches
 * @param source Secret whose .data the command copies
 * @returns {K8sObject[]} the render plus the patched operator Secret
 */
function afterCopy(objects: K8sObject[], target: string, source: string): K8sObject[] {
  const sourceObj = objects.find((o) => o.kind === 'Secret' && o.metadata.name === source);
  if (!sourceObj) throw new Error(`the copy command reads Secret ${source}, which the render does not create`);
  const operatorData = { SWARM_SERVICE_SECRET: Buffer.from('operator-owned').toString('base64') };
  const sourceData = { ...(sourceObj.data ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries((sourceObj as { stringData?: Record<string, string> }).stringData ?? {})) {
    sourceData[k] = Buffer.from(v).toString('base64');
  }
  return [...objects, { kind: 'Secret', metadata: { name: target }, data: { ...operatorData, ...sourceData } }];
}

describe('what a runtime-launched bot resolves, measured from the real launcher', () => {
  it('the launcher reads the chart ConfigMap plus exactly one Secret the chart does not create', () => {
    const objects = helmTemplate({});
    const launched = launchedBot(objects);
    const maps = (launched.envFrom ?? []).filter((s: Record<string, unknown>) => s.configMapRef);
    expect(maps.map((s: { configMapRef: { name: string } }) => s.configMapRef.name).every((n: string) => renderedData(objects, 'ConfigMap', n)),
      'the launcher names a ConfigMap the chart does not render').toBe(true);
    expect(operatorSecrets(objects, launched), 'the launcher\'s operator Secret changed - re-read NOTES.txt and this guard').toEqual(['oshal-bot-env']);
    expect(resolvedEnv(objects, launched).DATABASE_URL, 'the launched bot lost the api\'s oshal_bot DSN')
      .toBe(resolvedEnv(objects, chartBot(objects)).DATABASE_URL);
  }, RENDER_TIMEOUT_MS);
});

describe.each(LAUNCHER_ON)('%s: the chart warns about every key a runtime-launched bot does not get', (_label, opts) => {
  it('a gap that exists is boot-fatal: the real any-bot config refuses the launched bot\'s environment', () => {
    const objects = helmTemplate(opts);
    const missing = gap(objects);
    if (missing.length === 0) return;
    const boot = bootConfig(resolvedEnv(objects, launchedBot(objects)));
    expect(boot.ok, 'the launched bot\'s config loaded - the gap is not boot-fatal, re-read this guard').toBe(false);
    const fatal = /([A-Z][A-Z0-9_]+) must be set in production/.exec(boot.output)?.[1];
    expect(fatal, `the config failed for another reason:\n${boot.output}`).toBeTruthy();
    expect(missing, 'the key that kills the boot is not one the chart withholds').toContain(fatal);
  }, RENDER_TIMEOUT_MS + BOOT_TIMEOUT_MS);

  it('while the gap exists, helm install prints a copy command that closes it; once it is closed, no command', () => {
    const objects = helmTemplate(opts);
    const missing = gap(objects);
    const notes = helmNotes(opts);
    const command = COPY_COMMAND.exec(notes);
    if (missing.length === 0) {
      expect(command?.[0], 'the launcher now reads the chart Secret - remove the NOTES.txt copy step').toBeUndefined();
      return;
    }
    expect(command, `NOTES.txt does not tell the operator how to give runtime-launched bots ${missing.join(', ')}`).toBeTruthy();
    const [, targetNs, target, sourceNs, source] = command!;
    expect([targetNs, sourceNs], 'the command must address the release namespace').toEqual(['oshal', 'oshal']);
    expect(target, 'the command patches a Secret the launcher does not read').toBe(operatorSecrets(objects, launchedBot(objects))[0]);
    const fatal = /([A-Z][A-Z0-9_]+) must be set in production/.exec(bootConfig(resolvedEnv(objects, launchedBot(objects))).output)?.[1];
    expect(notes, 'NOTES.txt does not name the key whose absence kills the boot').toContain(String(fatal));
    const patched = afterCopy(objects, target, source);
    const launched = resolvedEnv(patched, launchedBot(patched));
    const declared = resolvedEnv(objects, chartBot(objects));
    for (const k of missing) expect(launched[k], `${k} after the copy`).toBe(declared[k]);
    const boot = bootConfig(launched);
    expect(boot.ok, `after the copy the launched bot's config still refuses:\n${boot.output}`).toBe(true);
  }, RENDER_TIMEOUT_MS + 2 * BOOT_TIMEOUT_MS);
});

describe('the warning appears only where a runtime launcher runs', () => {
  it.each(LAUNCHER_OFF)('%s: NOTES.txt carries no copy command', (_label, opts) => {
    expect(COPY_COMMAND.exec(helmNotes(opts))?.[0]).toBeUndefined();
  }, RENDER_TIMEOUT_MS);
});

describe('the rest of the record follows the gap', () => {
  it('the README Credentials section carries the same copy command exactly while the gap exists', () => {
    const missing = gap(helmTemplate({}));
    const section = README.split(/^## /m).find((s) => s.startsWith('Credentials')) ?? '';
    expect(section, 'the README has no Credentials section').not.toBe('');
    const command = COPY_COMMAND.exec(section);
    if (missing.length === 0) {
      expect(command?.[0], 'the launcher now reads the chart Secret - remove the README copy step').toBeUndefined();
      return;
    }
    expect(command, 'the README does not document the copy step').toBeTruthy();
    expect(command![2]).toBe('oshal-bot-env');
    expect(command![4]).toBe('oshal-shared-secret');
    for (const k of missing) expect(section, `README Credentials does not name ${k}`).toContain(k);
  }, RENDER_TIMEOUT_MS);

  it('while the gap exists, docs/BACKLOG.md tracks the core fix with a done-when', () => {
    if (gap(helmTemplate({})).length === 0) return;
    const entries = BACKLOG.split(/^### /m);
    const entry = entries.find((e) => e.includes('kubernetes-bot-launcher.ts') && e.includes('oshal-shared-secret'));
    expect(entry, 'no BACKLOG entry names the launcher and the chart Secret it does not read').toBeTruthy();
    expect(entry!, 'the BACKLOG entry has no done-when').toMatch(/\*\*Done when:\*\*/);
  }, RENDER_TIMEOUT_MS);
});
