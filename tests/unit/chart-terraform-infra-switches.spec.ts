/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Terraform tenant path's shared-service switches. deploy/terraform/main.tf forwarded only infra.postgres.inCluster, and Helm deep-merges release values over the chart defaults, so a tenant that Terraform refused to deploy on mock OIDC still shipped the dev-mode Vault, the ArangoDB root password in a ConfigMap and code-server --auth none into its namespace, with no way to switch any of them off from this path. The module now forwards tsdb_/arangodb_/vault_/code_server_/diarization_in_cluster (and code_server_external_url). This reads the module the way Terraform does (tests/helpers/hcl-subset.ts: every *.tf parsed, variables resolved from their declared defaults and optional() type defaults), EVALUATES local.chart_values for a given set of inputs, checks that the value helm_release receives is that local, and renders the REAL chart from the evaluated values with the helm binary: with every switch off, no workload of the five is rendered and nothing in the render still addresses one of their in-cluster Services, so the URLs a tenant puts in api_extra_secret_env are the ones the api reads. Removing or swapping any forwarding line goes red. No terraform binary, provider download or cluster is involved; no helm on PATH is a loud failure.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CHART_DIR, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, helmTemplate, type K8sObject } from '../helpers/helm-template';
import { blocksOf, evaluate, parseHcl, resolveVariables, type HclBody, type HclExpr } from '../helpers/hcl-subset';

const TF_DIR = path.join(REPO_ROOT, 'deploy', 'terraform');
const MODULE: HclBody[] = fs.readdirSync(TF_DIR)
  .filter((f) => f.endsWith('.tf'))
  .sort()
  .map((f) => parseHcl(fs.readFileSync(path.join(TF_DIR, f), 'utf8')));
const chartDefaults = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>;

/** One module switch: the variable, the chart key it must land on, and the in-cluster Service it removes. */
interface Switch {
  variable: string;
  chartKey: string;
  /** Deployment/StatefulSet name, which is also the Service DNS name the platform dials. */
  host: string;
  /** Whether the default render points some env at `host` (code-server's link is browser-facing). */
  dialled: boolean;
}

const SWITCHES: Switch[] = [
  { variable: 'tsdb_in_cluster', chartKey: 'tsdb', host: 'oshal-tsdb', dialled: true },
  { variable: 'arangodb_in_cluster', chartKey: 'arangodb', host: 'oshal-arangodb', dialled: true },
  { variable: 'vault_in_cluster', chartKey: 'vault', host: 'oshal-vault', dialled: true },
  { variable: 'code_server_in_cluster', chartKey: 'codeServer', host: 'code-server', dialled: false },
  { variable: 'diarization_in_cluster', chartKey: 'diarization', host: 'speaker-diarization', dialled: true },
];
const ALL_OFF = Object.fromEntries(SWITCHES.map((s) => [s.variable, false]));
const EXTERNAL_IDE = 'https://ide.example.test';

/**
 * @description The chart_values local, wherever in the module it is declared.
 * @returns {HclExpr} its expression
 */
function chartValuesExpr(): HclExpr {
  const found = blocksOf(MODULE, 'locals').map((b) => b.body.attributes.get('chart_values')).filter(Boolean) as HclExpr[];
  if (found.length !== 1) throw new Error(`expected exactly one local chart_values in deploy/terraform, found ${found.length}`);
  return found[0];
}

/**
 * @description local.chart_values as Terraform would compute it for a plan with these inputs.
 * @param inputs -var equivalents; every other variable takes its declared default
 * @returns the values document the chart receives
 */
function moduleValues(inputs: Record<string, unknown> = {}): Record<string, any> {
  return evaluate(chartValuesExpr(), resolveVariables(MODULE, { kube_context: 'unused-by-values', ...inputs })) as Record<string, any>;
}

/**
 * @description Render the real chart from the module's evaluated values (a -f file, as the
 * helm_release values list is).
 * @param inputs -var equivalents
 * @returns {K8sObject[]} rendered objects
 */
function renderModule(inputs: Record<string, unknown> = {}): K8sObject[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-tf-values-'));
  const file = path.join(dir, 'values.yaml');
  try {
    fs.writeFileSync(file, yaml.dump(moduleValues(inputs)));
    return helmTemplate({ valuesFiles: [file] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @description Every place a render still addresses a host by name: container env values and
 * ConfigMap/Secret data (Secret `data` base64-decoded). A match needs a URL-ish boundary, so
 * `oshal-db` does not match inside another word.
 * @param objects rendered objects
 * @param host Service DNS name
 * @returns {string[]} "Kind/name key" for each reference
 */
function hostRefs(objects: K8sObject[], host: string): string[] {
  const re = new RegExp(`(^|[/@])${host.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(:|/|$)`);
  const refs: string[] = [];
  for (const o of objects) {
    if (o.kind === 'ConfigMap' || o.kind === 'Secret') {
      const data = (o.data ?? {}) as Record<string, string>;
      const stringData = ((o as { stringData?: Record<string, string> }).stringData ?? {});
      for (const [k, v] of Object.entries(data)) {
        const text = o.kind === 'Secret' ? Buffer.from(String(v), 'base64').toString('utf8') : String(v);
        if (re.test(text)) refs.push(`${o.kind}/${o.metadata.name} ${k}`);
      }
      for (const [k, v] of Object.entries(stringData)) if (re.test(String(v))) refs.push(`${o.kind}/${o.metadata.name} ${k}`);
    }
    const pod = o.spec?.template?.spec ?? {};
    for (const c of [...(pod.initContainers ?? []), ...(pod.containers ?? [])]) {
      for (const e of c.env ?? []) {
        if (typeof e.value === 'string' && re.test(e.value)) refs.push(`${o.kind}/${o.metadata.name} ${c.name} ${e.name}`);
      }
    }
  }
  return refs;
}

/**
 * @description Names of every Deployment/StatefulSet in a render.
 * @param objects rendered objects
 * @returns {string[]} workload names
 */
function workloads(objects: K8sObject[]): string[] {
  return objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet').map((o) => o.metadata.name);
}

describe('deploy/terraform hands the chart the rest of the shared-service switches', () => {
  it('the helm release receives exactly local.chart_values', () => {
    const releases = blocksOf(MODULE, 'resource', 'helm_release');
    expect(releases.map((r) => r.labels[1]), 'the module should release the chart exactly once').toEqual(['oshal']);
    const values = releases[0].body.attributes.get('values');
    expect(values?.kind, 'helm_release.oshal has no values list').toBe('tuple');
    const items = values?.kind === 'tuple' ? values.items : [];
    expect(items.map((i) => i.src), 'helm_release.oshal values must be the single yamlencode(local.chart_values)').toEqual([
      'yamlencode(local.chart_values)',
    ]);
    const [call] = items;
    expect(call?.kind === 'call' && call.args[0]?.kind === 'traversal' ? [call.name, call.args[0].root, ...call.args[0].path] : [])
      .toEqual(['yamlencode', 'local', 'chart_values']);
  });

  it('each switch is a non-nullable bool that defaults to the chart\'s own default', () => {
    for (const s of SWITCHES) {
      const [block] = blocksOf(MODULE, 'variable', s.variable);
      expect(block, `variables.tf declares no variable "${s.variable}"`).toBeTruthy();
      const attr = (name: string) => block.body.attributes.get(name);
      expect(attr('type')?.src, `${s.variable} must be typed bool`).toBe('bool');
      expect(attr('nullable')?.src, `${s.variable}: a null reaches the chart as a deleted key, which reads as false`).toBe('false');
      const chartDefault = chartDefaults.infra?.[s.chartKey]?.inCluster;
      expect(typeof chartDefault, `values.yaml has no boolean infra.${s.chartKey}.inCluster`).toBe('boolean');
      expect(evaluate(attr('default') as HclExpr, {}), `${s.variable} default differs from infra.${s.chartKey}.inCluster`).toBe(chartDefault);
    }
  });

  it('each switch lands on its own chart key and changes nothing else', () => {
    const base = moduleValues();
    for (const s of SWITCHES) expect(base.infra?.[s.chartKey]?.inCluster, `module default for infra.${s.chartKey}.inCluster`).toBe(true);
    for (const s of SWITCHES) {
      const off = moduleValues({ [s.variable]: false });
      expect(off.infra?.[s.chartKey]?.inCluster, `${s.variable}=false does not reach infra.${s.chartKey}.inCluster`).toBe(false);
      const rest = (v: Record<string, any>) => JSON.stringify({ ...v, infra: { ...v.infra, [s.chartKey]: undefined } });
      expect(rest(off), `${s.variable}=false changed a chart value other than infra.${s.chartKey}.inCluster`).toBe(rest(base));
    }
  });

  it('code_server_external_url reaches infra.codeServer.externalUrl, and is absent when unset', () => {
    // Absent, not null: a null in release values deletes the chart's key, which would withhold
    // CODE_SERVER_URL instead of keeping the chart's default link.
    expect(Object.keys(moduleValues().infra.codeServer)).not.toContain('externalUrl');
    expect(moduleValues({ code_server_external_url: EXTERNAL_IDE }).infra.codeServer.externalUrl).toBe(EXTERNAL_IDE);
  });

  it('the Secret the module mints is the one the api reads', () => {
    const [secret] = blocksOf(MODULE, 'resource', 'kubernetes_secret_v1', 'api_env');
    const metadata = secret?.body.blocks.find((b) => b.type === 'metadata');
    const name = evaluate(metadata?.body.attributes.get('name') as HclExpr, {});
    expect(moduleValues().api.envSecret, 'api.envSecret is not the Secret api_extra_secret_env is minted into').toBe(name);
  });
});

describe('the chart rendered from the module\'s values', () => {
  it('module defaults keep all five services in-cluster, as the chart alone does', () => {
    const names = workloads(renderModule());
    for (const s of SWITCHES) expect(names, `${s.host} missing from the module-default render`).toContain(s.host);
  }, RENDER_TIMEOUT_MS);

  it('with every switch off, each service is external: no workload, and nothing still dials it', () => {
    const on = renderModule();
    const off = renderModule({ ...ALL_OFF, code_server_external_url: EXTERNAL_IDE });
    for (const s of SWITCHES) {
      expect(workloads(off), `${s.variable}=false still renders ${s.host}`).not.toContain(s.host);
      expect(hostRefs(off, s.host), `${s.variable}=false: the render still addresses the removed ${s.host}`).toEqual([]);
      // Non-vacuous: where the default render dials the service, the check above had something to remove.
      if (s.dialled) expect(hostRefs(on, s.host).length, `the default render never addresses ${s.host}`).toBeGreaterThan(0);
    }
    const sharedEnv = off.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'oshal-shared-env');
    expect(sharedEnv?.data?.CODE_SERVER_URL, 'the cockpit /code link does not point at the external IDE').toBe(EXTERNAL_IDE);
    const api = containerOf(off, 'Deployment', 'oshal-api', 'api');
    const secretRefs = (api.envFrom ?? []).map((e: { secretRef?: { name: string } }) => e.secretRef?.name);
    expect(secretRefs, 'the api no longer reads the Secret the external URLs go in').toContain(moduleValues().api.envSecret);
  }, RENDER_TIMEOUT_MS);
});

describe('the HCL reader the guard stands on', () => {
  it('treats braces and quotes inside strings, comments and heredocs as text', () => {
    const body = parseHcl([
      '# a comment with { and "',
      'locals {',
      '  /* } */ x = { a = "}{\\"", b = merge({ c = true }, false ? { d = 1 } : {}) } // }',
      '  h = <<EOT',
      '  } not structure {',
      '  EOT',
      '}',
    ].join('\n'));
    const locals = blocksOf([body], 'locals')[0].body.attributes;
    expect(evaluate(locals.get('x') as HclExpr, {})).toEqual({ a: '}{"', b: { c: true } });
    expect(locals.get('h')?.kind).toBe('template');
  });

  it('refuses to guess: an expression outside the evaluated subset throws', () => {
    const body = parseHcl('locals {\n  y = upper(var.z)\n}\n');
    expect(() => evaluate(blocksOf([body], 'locals')[0].body.attributes.get('y') as HclExpr, { z: 'a' })).toThrow(/unsupported/);
    expect(() => parseHcl('locals {\n  y = { a = 1 b = 2 }\n}\n')).toThrow(/HCL parse/);
  });
});
