/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for deploy/monitoring, the cluster form of the compose monitoring stack (kube-prometheus-stack), first run live on Docker Desktop Kubernetes on 2026-09-21. Its promise is parity with ops/monitoring: the ADR-119 alert rules, unchanged, over the same job names, reaching the same fail-closed intake. Each way that promise breaks silently is held here against its source: (1) every job="..." an alert rule reads is a scrape job, and together those jobs select the api and every bot the REAL chart renders (a rule over a job nobody scrapes never fires); (2) Alertmanager's routing tree, evaluated the way Alertmanager evaluates it, sends every alert in ops/monitoring/alert-rules.yml to a receiver that posts to the route the api actually mounts (read from src/app, not copied) - a narrowed matcher drops an alert into "null" without a sound; (3) the webhook host is a Service the chart renders in the namespace the install script targets, with the bearer token file the script creates; (4) install-monitoring.sh GENERATES the PrometheusRule from ops/monitoring/alert-rules.yml. (4) runs the real script with recording kubectl/helm stand-ins first on a minimal PATH, against a scratch copy of the tree whose rule file carries an extra sentinel group - a copy of the rules pasted into the script would still match today's file but not the sentinel. The stand-ins are outside the boundary (they record; the cluster is not the claim); the live cluster run is the companion recorded in docs/governance/real-boundary-regression-audit.md.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, helmTemplate, type K8sObject } from '../helpers/helm-template';

const KPS_VALUES = 'deploy/monitoring/kube-prometheus-stack.values.yaml';
const INSTALL_SCRIPT = 'deploy/monitoring/install-monitoring.sh';
const ALERT_RULES = 'ops/monitoring/alert-rules.yml';
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

interface Rule { alert?: string; record?: string; expr: string; labels?: Record<string, string> }
interface Route { receiver?: string; matchers?: string[]; match?: Record<string, string>; match_re?: Record<string, string>; routes?: Route[]; continue?: boolean }

const kps = yaml.load(read(KPS_VALUES)) as Record<string, any>;
const ruleGroups = (yaml.load(read(ALERT_RULES)) as { groups: Array<{ rules: Rule[] }> }).groups;
const alertRules = ruleGroups.flatMap((g) => g.rules).filter((r) => r.alert);
const scrapeJobs: Array<Record<string, any>> = kps.prometheus?.prometheusSpec?.additionalScrapeConfigs ?? [];
const externalLabels: Record<string, string> = kps.prometheus?.prometheusSpec?.externalLabels ?? {};
const amConfig = kps.alertmanager?.config ?? {};

/**
 * @description The first capture group of a pattern, or a thrown error naming what was missing.
 * @param text source text
 * @param pattern regex with one capture group
 * @param what description for the failure
 * @returns {string} captured text
 */
function capture(text: string, pattern: RegExp, what: string): string {
  const m = pattern.exec(text);
  if (!m?.[1]) throw new Error(`could not read ${what}`);
  return m[1];
}

/** The namespaces install-monitoring.sh targets by default: the oshal release's and its own. */
const OSHAL_NS = capture(read(INSTALL_SCRIPT), /OSHAL_NS=\$\{OSHAL_NS:-([a-z0-9-]+)\}/, 'the OSHAL_NS default of install-monitoring.sh');
const MON_NS = capture(read(INSTALL_SCRIPT), /MON_NS=\$\{MON_NS:-([a-z0-9-]+)\}/, 'the MON_NS default of install-monitoring.sh');

/** The webhook token the kubectl stand-in reports the api already holds (base64 in the secret). */
const API_TOKEN = 'recorded-token';

/**
 * @description The path the api mounts the Alertmanager webhook on, composed from the mount in
 * src/app/server.ts and the router's single POST in src/app/routes/alertmanager-routes.ts.
 * @returns {string} e.g. /api/alerts/alertmanager
 */
function mountedWebhookPath(): string {
  const mount = capture(read('src/app/server.ts'), /app\.use\(\s*'([^']+)'\s*,\s*createAlertmanagerRoutes\(/, 'the alert router mount');
  const posts = [...read('src/app/routes/alertmanager-routes.ts').matchAll(/router\.post\(\s*'([^']+)'/g)].map((m) => m[1]);
  if (posts.length !== 1) throw new Error(`the alert router declares ${posts.length} POST routes, expected exactly one`);
  return path.posix.join(mount, posts[0]);
}

/** Anchored the way Prometheus and Alertmanager anchor every regex. */
const anchored = (re: string): RegExp => new RegExp(`^(?:${re})$`);

/**
 * @description Scrape targets a pod-role kubernetes_sd_config would discover for every
 * Deployment/StatefulSet pod template in a render: one per container port, carrying the meta
 * labels the chart's relabel rules read.
 * @param objects rendered objects
 * @returns {Array<{ owner: string, labels: Record<string, string> }>}
 */
function podTargets(objects: K8sObject[]): Array<{ owner: string; labels: Record<string, string> }> {
  return objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet').flatMap((o) => {
    const meta: Record<string, string> = { __meta_kubernetes_namespace: OSHAL_NS, __meta_kubernetes_pod_name: `${o.metadata.name}-0` };
    for (const [k, v] of Object.entries(o.spec?.template?.metadata?.labels ?? {})) {
      meta[`__meta_kubernetes_pod_label_${k.replace(/[^A-Za-z0-9_]/g, '_')}`] = String(v);
    }
    return (o.spec?.template?.spec?.containers ?? []).flatMap((c: Record<string, any>) => (c.ports ?? []).map(
      (p: { containerPort: number }) => ({ owner: o.metadata.name, labels: { ...meta, __meta_kubernetes_pod_container_port_number: String(p.containerPort) } }),
    ));
  });
}

/**
 * @description The workloads a scrape job keeps: its namespaces must include the oshal release's,
 * and every `keep` relabel rule must match (source labels joined by the separator, anchored).
 * @param job one additionalScrapeConfigs entry
 * @param targets discovered pod targets
 * @returns {string[]} owning workload names
 */
function keptBy(job: Record<string, any>, targets: ReturnType<typeof podTargets>): string[] {
  const sds: Array<Record<string, any>> = job.kubernetes_sd_configs ?? [];
  if (!sds.some((sd) => sd.role === 'pod' && (sd.namespaces?.names ?? []).includes(OSHAL_NS))) return [];
  const keeps = (job.relabel_configs ?? []).filter((r: { action?: string }) => r.action === 'keep');
  return targets.filter((t) => keeps.every((r: Record<string, any>) => anchored(r.regex ?? '(.*)').test(
    (r.source_labels ?? []).map((l: string) => t.labels[l] ?? '').join(r.separator ?? ';'),
  ))).map((t) => t.owner);
}

/**
 * @description Whether one Alertmanager matcher string (`label op "value"`) holds for a label set.
 * @param expr matcher, e.g. alertname =~ "Swarm.*"
 * @param labels alert labels
 * @returns {boolean}
 */
function matcherHolds(expr: string, labels: Record<string, string>): boolean {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*(?:"((?:[^"\\]|\\.)*)"|(\S*))\s*$/.exec(expr);
  if (!m) throw new Error(`unparseable Alertmanager matcher: ${expr}`);
  const value = m[3] ?? m[4] ?? '';
  const actual = labels[m[1]] ?? '';
  if (m[2] === '=') return actual === value;
  if (m[2] === '!=') return actual !== value;
  return m[2] === '=~' ? anchored(value).test(actual) : !anchored(value).test(actual);
}

/**
 * @description Whether a child route matches a label set (matchers, plus the legacy match/match_re).
 * @param route Alertmanager route
 * @param labels alert labels
 * @returns {boolean}
 */
function routeMatches(route: Route, labels: Record<string, string>): boolean {
  return (route.matchers ?? []).every((x) => matcherHolds(x, labels))
    && Object.entries(route.match ?? {}).every(([k, v]) => (labels[k] ?? '') === v)
    && Object.entries(route.match_re ?? {}).every(([k, v]) => anchored(v).test(labels[k] ?? ''));
}

/**
 * @description The receivers Alertmanager notifies for a label set: depth-first, first matching
 * child wins unless it sets `continue`, and the node's own receiver only when no child matched.
 * @param route routing (sub)tree
 * @param labels alert labels
 * @param inherited receiver inherited from the parent
 * @returns {string[]} receiver names
 */
function receiversFor(route: Route, labels: Record<string, string>, inherited?: string): string[] {
  const own = route.receiver ?? inherited ?? '';
  const hits: string[] = [];
  for (const child of route.routes ?? []) {
    if (!routeMatches(child, labels)) continue;
    hits.push(...receiversFor(child, labels, own));
    if (!child.continue) break;
  }
  return hits.length ? hits : [own];
}

describe('deploy/monitoring scrapes what the ADR-119 rules read', () => {
  const jobsRead = [...new Set(alertRules.flatMap((r) => [...String(r.expr).matchAll(/\bjob\s*=\s*"([^"]+)"/g)].map((m) => m[1])))].sort();

  it('every job="..." in ops/monitoring/alert-rules.yml is a scrape job', () => {
    expect(jobsRead.length, 'the rules read no job - the parse is broken').toBeGreaterThan(0);
    const scraped = scrapeJobs.map((j) => j.job_name);
    expect(jobsRead.filter((j) => !scraped.includes(j)), 'alert rules read a job deploy/monitoring does not scrape').toEqual([]);
  });

  it('those jobs select the api and every bot the chart renders for the Docker Desktop overlay', () => {
    const objects = helmTemplate({ valuesFiles: [DOCKER_DESKTOP_VALUES] });
    const targets = podTargets(objects);
    const runtimes = objects.filter((o) => o.kind === 'Deployment'
      && (o.metadata.name === 'oshal-api' || o.metadata.labels?.['oshal.io/bot'] === 'true')).map((o) => o.metadata.name);
    expect(runtimes.length, 'the overlay rendered no bots - nothing was checked').toBeGreaterThan(1);
    const selected = new Set<string>();
    for (const name of jobsRead) {
      const kept = keptBy(scrapeJobs.find((j) => j.job_name === name) ?? {}, targets);
      expect(kept.length, `scrape job ${name} selects no pod the chart renders`).toBeGreaterThan(0);
      kept.forEach((k) => selected.add(k));
    }
    expect(runtimes.filter((r) => !selected.has(r)), 'oshal runtimes no rule-read job scrapes').toEqual([]);
  }, RENDER_TIMEOUT_MS);
});

describe('every swarm alert reaches the api intake', () => {
  const webhookPath = mountedWebhookPath();
  const intake = (amConfig.receivers ?? []).filter((r: Record<string, any>) => (r.webhook_configs ?? [])
    .some((w: { url: string }) => new URL(w.url).pathname === webhookPath)).map((r: { name: string }) => r.name);

  it('a receiver posts to the route the api mounts', () => {
    expect(webhookPath).toBe('/api/alerts/alertmanager');
    expect(intake.length, `no Alertmanager receiver posts to ${webhookPath}`).toBeGreaterThan(0);
  });

  it.each(alertRules.map((r) => [r.alert as string, r] as const))('%s routes to the intake, not to "null"', (_name, rule) => {
    const labels = { ...externalLabels, ...(rule.labels ?? {}), alertname: rule.alert as string };
    const got = receiversFor(amConfig.route ?? {}, labels);
    expect(got.filter((r) => !intake.includes(r)), `${rule.alert} is routed to ${got.join(', ')}`).toEqual([]);
  });

  it('the webhook host is the rendered api Service in the install namespace, with bearer auth', () => {
    const services = helmTemplate().filter((o) => o.kind === 'Service');
    for (const receiver of amConfig.receivers.filter((r: { name: string }) => intake.includes(r.name))) {
      for (const hook of receiver.webhook_configs) {
        const url = new URL(hook.url);
        const [svc, ns, suffix] = url.hostname.split('.');
        expect([ns, suffix], `${url.hostname} is not <service>.${OSHAL_NS}.svc`).toEqual([OSHAL_NS, 'svc']);
        const ports = services.find((s) => s.metadata.name === svc)?.spec?.ports?.map((p: { port: number }) => String(p.port));
        expect(ports, `the chart renders no Service ${svc} on port ${url.port}`).toContain(url.port);
        // The api guard reads `Authorization: Bearer <ALERT_WEBHOOK_TOKEN>` and is fail-closed.
        expect(read('src/app/routes/alertmanager-routes.ts')).toContain("auth.startsWith('Bearer ')");
        expect(hook.http_config?.authorization?.type).toBe('Bearer');
        expect(hook.http_config?.authorization?.credentials_file, 'the token must come from a file, never inline').toBeTruthy();
      }
    }
  }, RENDER_TIMEOUT_MS);
});

// ── install-monitoring.sh, run for real with recording kubectl/helm ─────────────────────────────

const sandboxes: string[] = [];
afterAll(() => { for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * @description Absolute bash plus a minimal PATH holding only the POSIX tools (git-bash on
 * Windows), so no real kubectl or helm is reachable from the script.
 * @returns {{ bash: string, minimalPath: string }}
 */
function resolveBash(): { bash: string; minimalPath: string } {
  if (process.platform !== 'win32') return { bash: '/bin/bash', minimalPath: '/usr/bin:/bin' };
  const found = (spawnSync('where', ['bash'], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.toLowerCase().endsWith('bash.exe') && !/\\(system32|windowsapps)\\/i.test(l));
  if (!found[0]) throw new Error('git-bash not found - this guard runs the real install script and does not skip');
  const binDir = path.dirname(found[0]);
  const gitRoot = path.basename(path.dirname(binDir)).toLowerCase() === 'usr' ? path.dirname(path.dirname(binDir)) : path.dirname(binDir);
  return { bash: found[0], minimalPath: [binDir, path.join(gitRoot, 'usr', 'bin')].join(path.delimiter) };
}

const KUBECTL_STANDIN = `#!/usr/bin/env bash
# Recording stand-in: never reaches a cluster.
printf '%s\\n' "$*" >> "$SHIM_DIR/kubectl.log"
case " $* " in
  *" apply -f - "*) n=$(ls "$SHIM_DIR" | grep -c '^apply-'); cat > "$SHIM_DIR/apply-$n.yaml" ;;
  *" get secret oshal-api-env "*jsonpath*) printf '%s' '${Buffer.from(API_TOKEN).toString('base64')}' ;;
  *" create namespace "*) printf 'apiVersion: v1\\nkind: Namespace\\nmetadata:\\n  name: stand-in\\n' ;;
  *" create secret generic "*) printf 'apiVersion: v1\\nkind: Secret\\nmetadata:\\n  name: stand-in\\n' ;;
esac
exit 0
`;
const HELM_STANDIN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SHIM_DIR/helm.log"
exit 0
`;

/** A sentinel rule group appended to the scratch copy of alert-rules.yml. */
const SENTINEL = '  - name: oshal-guard-sentinel\n    rules:\n      - alert: SwarmGuardSentinel\n        expr: vector(1)\n';

let installRun: { status: number | null; out: string; applied: K8sObject[]; helmLog: string; kubectlLog: string; root: string; rulesGroups: unknown } | null = null;

/**
 * @description Run the real install-monitoring.sh from a scratch copy of the tree (the script, the
 * values file and alert-rules.yml plus a sentinel group) with recording kubectl/helm first on a
 * minimal PATH, a context that exists nowhere, and no kubeconfig. Memoised.
 * @returns what the script applied and asked helm to do
 */
function runInstall(): NonNullable<typeof installRun> {
  if (installRun) return installRun;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-monitoring-install-'));
  sandboxes.push(root);
  for (const rel of [INSTALL_SCRIPT, KPS_VALUES, ALERT_RULES]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  const rulesFile = path.join(root, ALERT_RULES);
  fs.writeFileSync(rulesFile, `${fs.readFileSync(rulesFile, 'utf8').replace(/\s*$/, '\n')}${SENTINEL}`);
  const shims = path.join(root, 'stand-ins');
  fs.mkdirSync(shims);
  fs.writeFileSync(path.join(shims, 'kubectl'), KUBECTL_STANDIN, { mode: 0o755 });
  fs.writeFileSync(path.join(shims, 'helm'), HELM_STANDIN, { mode: 0o755 });
  const { bash, minimalPath } = resolveBash();
  const posix = (p: string): string => p.replace(/\\/g, '/');
  const res = spawnSync(bash, [posix(path.join(root, INSTALL_SCRIPT))], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RENDER_TIMEOUT_MS,
    env: {
      PATH: [shims, minimalPath].join(path.delimiter), HOME: root, TMPDIR: root, SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      SHIM_DIR: posix(shims), KUBE_CONTEXT: 'oshal-guard-no-such-context', KUBECONFIG: posix(path.join(root, 'no-kubeconfig')),
    },
  });
  const applied = fs.readdirSync(shims).filter((f) => f.startsWith('apply-'))
    .flatMap((f) => yaml.loadAll(fs.readFileSync(path.join(shims, f), 'utf8')) as K8sObject[]).filter(Boolean);
  const logOf = (name: string): string => (fs.existsSync(path.join(shims, name)) ? fs.readFileSync(path.join(shims, name), 'utf8') : '');
  installRun = {
    status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, applied, root,
    helmLog: logOf('helm.log'), kubectlLog: logOf('kubectl.log'),
    rulesGroups: (yaml.load(fs.readFileSync(rulesFile, 'utf8')) as { groups: unknown }).groups,
  };
  return installRun;
}

describe('install-monitoring.sh generates the swarm rules from ops/monitoring/alert-rules.yml', () => {
  it('the PrometheusRule it applies is the rule file, sentinel included', () => {
    const run = runInstall();
    expect(run.status, `install-monitoring.sh failed under the stand-ins:\n${run.out}`).toBe(0);
    const rule = run.applied.find((o) => o.kind === 'PrometheusRule');
    expect(rule, 'the script applied no PrometheusRule').toBeTruthy();
    expect(rule?.spec?.groups, 'the PrometheusRule is not ops/monitoring/alert-rules.yml').toEqual(run.rulesGroups);
    expect(JSON.stringify(rule?.spec?.groups), 'a copy of the rules, not the file, was applied').toContain('SwarmGuardSentinel');
  }, RENDER_TIMEOUT_MS);

  it('it installs kube-prometheus-stack with this values file and mounts the token file the webhook reads', () => {
    const run = runInstall();
    const upgrade = run.helmLog.split('\n').find((l) => / upgrade --install /.test(` ${l} `)) ?? '';
    const valuesArg = /(?:^|\s)-f\s+(\S+)/.exec(upgrade)?.[1] ?? '';
    expect(valuesArg.replace(/\\/g, '/'), 'helm is not given deploy/monitoring/kube-prometheus-stack.values.yaml').toMatch(new RegExp(`${path.basename(run.root)}/${KPS_VALUES.replace(/\./g, '\\.')}$`));
    // The Alertmanager-side secret must hold the SAME token the api reads (the stand-in answers the
    // api's ALERT_WEBHOOK_TOKEN with API_TOKEN), in the namespace Alertmanager runs in.
    const created = new RegExp(`-n ${MON_NS} create secret generic (\\S+) --from-literal=([A-Za-z0-9_.-]+)=${API_TOKEN}(?:\\s|$)`)
      .exec(run.kubectlLog);
    expect(created, `the script puts the api's webhook token in no ${MON_NS} secret:\n${run.kubectlLog}`).toBeTruthy();
    const [, secret, key] = created as RegExpExecArray;
    expect(kps.alertmanager?.alertmanagerSpec?.secrets ?? [], `Alertmanager does not mount secret ${secret}`).toContain(secret);
    const files = (amConfig.receivers ?? []).flatMap((r: Record<string, any>) => (r.webhook_configs ?? [])
      .map((w: Record<string, any>) => w.http_config?.authorization?.credentials_file)).filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toBe(`/etc/alertmanager/secrets/${secret}/${key}`);
  }, RENDER_TIMEOUT_MS);
});
