/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the second live break (container-kill drill, 2026-08-01): the container-health rules matched cAdvisor series this deployment never emits, so SwarmContainerDown was a standing false alarm with no target and a genuinely stopped container was never identified. Pins the whole signal chain as a CLOSED LOOP — every metric a rule names must actually be produced by renderRuntimeMetrics() or be Prometheus's own `up`; every scrape target must be a real compose container and every runtime container must be a target; every alert must carry {{ $labels.container }}; and the Alertmanager grouping/inhibition must key on that same label. A rule written against a metric nobody exports can no longer ship.
 */

/**
 * The swarm's container-health signal chain, guarded end to end.
 *
 * The defect this exists for was not a bug in any one file — every file was internally
 * consistent. The rules named `container_last_seen{name=~"oshal-local-.+"}`, that series
 * existed in cAdvisor's documentation, and nothing anywhere checked that the deployment
 * actually PRODUCED it. So the guard is deliberately a cross-file closed loop: the exporter,
 * the scrape config, the rules, the Alertmanager label contract, and the compose topology all
 * have to agree, and the exporter's REAL OUTPUT is the authority for what a rule may name.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  PROMETHEUS_CONTENT_TYPE,
  _resetMemoryLimitCache,
  containerMemoryLimitBytes,
  renderRuntimeMetrics,
} from '../../src/shared/observability';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const PROMETHEUS_YML = 'ops/monitoring/prometheus.yml';
const ALERT_RULES_YML = 'ops/monitoring/alert-rules.yml';
const ALERTMANAGER_YML = 'ops/monitoring/alertmanager.yml';
const STACK_COMPOSE = 'docker-compose.oshal-local.yml';

interface ScrapeConfig {
  job_name: string;
  metrics_path?: string;
  static_configs?: Array<{ targets: string[]; labels?: Record<string, string> }>;
  relabel_configs?: Array<Record<string, unknown>>;
}
interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const prometheusCfg = yaml.load(read(PROMETHEUS_YML)) as { scrape_configs: ScrapeConfig[] };
const ruleGroups = (yaml.load(read(ALERT_RULES_YML)) as { groups: Array<{ name: string; rules: AlertRule[] }> }).groups;
const alertmanagerCfg = yaml.load(read(ALERTMANAGER_YML)) as {
  route: { group_by: string[] };
  inhibit_rules: Array<{ equal: string[] }>;
};
const allRules = ruleGroups.flatMap((g) => g.rules);

/** The jobs whose targets are oshal runtimes (the ones the alert rules are allowed to use). */
const RUNTIME_JOBS = ['oshal-core', 'oshal-swarm-bots'];

/** Every metric name the exporter actually serves, taken from its real output. */
function exportedMetricNames(): Set<string> {
  const body = renderRuntimeMetrics({ runtime: 'swarm', instance: 'guard' });
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Metric selectors a PromQL expression references. Label matchers (`{...}`), vector-matching
 * label lists (`on (container)`, `by (...)`, …) and range selectors (`[1h]`) are stripped
 * FIRST — a label name is not a metric name, and counting one as a metric would make this
 * guard cry wolf on correct PromQL, which is how a guard gets disabled.
 */
function metricsReferencedBy(expr: string): string[] {
  const reserved = new Set([
    'and', 'or', 'unless', 'on', 'ignoring', 'by', 'without', 'group_left', 'group_right', 'offset', 'bool',
    'rate', 'increase', 'changes', 'absent', 'absent_over_time', 'max_over_time', 'min_over_time',
    'avg_over_time', 'sum', 'max', 'min', 'avg', 'count', 'time', 'delta', 'idelta', 'irate', 'clamp_max',
  ]);
  const stripped = expr
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(on|ignoring|by|without|group_left|group_right)\s*\([^)]*\)/g, ' $1 ');
  const found = new Set<string>();
  for (const m of stripped.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)) {
    if (!reserved.has(m[0]) && !/^\d/.test(m[0])) found.add(m[0]);
  }
  return [...found];
}



describe('the exporter both runtimes serve', () => {
  it('renders a well-formed Prometheus text exposition (HELP + TYPE + sample per metric)', () => {
    const body = renderRuntimeMetrics({ runtime: 'bot-node', instance: 'research-bot' }, 1_700_000_000_000);
    const lines = body.trimEnd().split('\n');
    const samples = lines.filter((l) => !l.startsWith('#'));
    expect(samples.length).toBeGreaterThanOrEqual(5);
    for (const sample of samples) {
      // name{labels} value — a malformed line makes Prometheus reject the ENTIRE scrape,
      // which would present exactly as the outage this whole change is fixing.
      const parsed = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\} (-?[\d.eE+]+)$/.exec(sample);
      expect(parsed, `unparseable exposition line: ${sample}`).toBeTruthy();
      expect(Number.isFinite(Number(parsed![3])), `non-numeric value: ${sample}`).toBe(true);
      expect(lines).toContain(`# HELP ${parsed![1]} ${lines.find((l) => l.startsWith(`# HELP ${parsed![1]} `))?.slice(`# HELP ${parsed![1]} `.length)}`);
      expect(lines.some((l) => l.startsWith(`# TYPE ${parsed![1]} `)), `${parsed![1]} has no # TYPE`).toBe(true);
    }
    expect(body.endsWith('\n'), 'the exposition must end with a newline').toBe(true);
    expect(PROMETHEUS_CONTENT_TYPE).toContain('text/plain');
  });

  it('escapes label values so one odd container name cannot void the whole scrape', () => {
    const body = renderRuntimeMetrics({ runtime: 'bot-node', instance: 'we"ird\\bot' });
    const sample = body.split('\n').find((l) => l.startsWith('oshal_up'))!;
    expect(sample).toContain('instance_name="we\\"ird\\\\bot"');
    expect(/^oshal_up\{([^}]*)\} 1$/.test(sample), `label block not closed: ${sample}`).toBe(true);
  });

  it('start time is EXACTLY constant across scrapes and across a clock jump (restart detection)', () => {
    // SwarmContainerRestartLoop is changes(oshal_process_start_time_seconds[10m]) > 2, so this
    // gauge must count RESTARTS, not scrapes. The first cut of this guard allowed "within 1
    // second" and passed while the real exposition jittered 1-3 MILLISECONDS per scrape —
    // enough for changes() to count every scrape, which put all 34 bots into a pending
    // restart-loop alert two minutes after the rules went live (2026-08-01 drill). Exact
    // equality is the only tolerance that catches that.
    const startOf = (body: string): string =>
      /oshal_process_start_time_seconds\{[^}]*\} ([\d.eE+-]+)/.exec(body)![1];
    const a = startOf(renderRuntimeMetrics({ runtime: 'swarm', instance: 'a' }));
    const b = startOf(renderRuntimeMetrics({ runtime: 'swarm', instance: 'a' }));
    expect(b).toBe(a);
    // ...and it must not track the wall clock: an hour-long jump changes nothing, because the
    // process did not restart. This is what pins it as a per-process constant rather than a
    // quantity re-derived from Date.now() on every scrape.
    const later = startOf(renderRuntimeMetrics({ runtime: 'swarm', instance: 'a' }, Date.now() + 3_600_000));
    expect(later).toBe(a);
  });

  describe('cgroup memory ceiling', () => {
    it('reads the cgroup v2 byte value', () => {
      _resetMemoryLimitCache();
      expect(containerMemoryLimitBytes((p) => (p.endsWith('memory.max') ? '2147483648\n' : (() => { throw new Error('nope'); })()), false)).toBe(2147483648);
    });

    it('treats cgroup v2 "max" as no limit (0), not as NaN', () => {
      _resetMemoryLimitCache();
      expect(containerMemoryLimitBytes((p) => {
        if (p.endsWith('memory.max')) return 'max\n';
        throw new Error('no v1');
      }, false)).toBe(0);
    });

    it('rejects the cgroup v1 "unlimited" sentinel instead of reporting it as a real limit', () => {
      _resetMemoryLimitCache();
      // 9223372036854771712 is the classic v1 no-limit value. Treating it as a limit makes
      // the HighMemory ratio ~0 forever — a silent alert, which is worse than a loud one.
      expect(containerMemoryLimitBytes((p) => {
        if (p.endsWith('memory.max')) throw new Error('no v2');
        return '9223372036854771712\n';
      }, false)).toBe(0);
    });

    it('reports 0 when there is no cgroupfs at all (bare metal)', () => {
      _resetMemoryLimitCache();
      expect(containerMemoryLimitBytes(() => { throw new Error('ENOENT'); }, false)).toBe(0);
      _resetMemoryLimitCache();
    });
  });
});

describe('alert rules may only name metrics the swarm actually exports', () => {
  const exported = exportedMetricNames();

  it.each(allRules.map((r) => [r.alert, r.expr] as const))(
    '%s references only exported series or Prometheus built-ins',
    (alert, expr) => {
      for (const metric of metricsReferencedBy(expr)) {
        expect(
          exported.has(metric) || metric === 'up',
          `${alert} keys on "${metric}", which no oshal runtime exports and which Prometheus does not `
            + 'synthesize. This is exactly how container_last_seen{name=...} shipped: a plausible metric '
            + 'name that this deployment never produces, so the rule silently matched nothing.',
        ).toBe(true);
      }
    },
  );

  it('no rule keys on cAdvisor container_* series or the dead `name` label', () => {
    for (const rule of allRules) {
      expect(rule.expr, `${rule.alert} still references a cAdvisor container_* series`).not.toMatch(/\bcontainer_[a-z_]+\{/);
      expect(rule.expr, `${rule.alert} still matches on the cAdvisor \`name\` label`).not.toMatch(/\bname\s*=~?\s*"/);
    }
  });

  it('every alert carries the container identity ADR-119 P1 requires', () => {
    for (const rule of allRules) {
      const text = `${rule.annotations?.summary ?? ''} ${rule.annotations?.description ?? ''}`;
      // P1's identity gate DROPS an alert with no resolvable target, and P2/P4 need the target
      // to bundle and to bound core-infra. An alert whose annotations cannot even name the
      // container is the target-less alarm this change removes.
      expect(text, `${rule.alert} never names {{ $labels.container }}`).toContain('$labels.container');
    }
  });

  it('SwarmContainerDown cannot fire for a target that was never up', () => {
    const down = allRules.find((r) => r.alert === 'SwarmContainerDown')!;
    // Without this conjunct, every compose `profiles:` bot a deployment does not run becomes a
    // permanent alert — re-creating the standing false alarm from the other direction.
    expect(down.expr).toMatch(/max_over_time\(\s*up\{[^}]*\}\[\d+[smhd]\]\s*\)\s*>\s*0/);
  });

  it('the worker rules never act on the core plane (A0 stays A0)', () => {
    for (const rule of ruleGroups.find((g) => g.name === 'swarm-container-health')!.rules) {
      expect(rule.expr, `${rule.alert} must scope to job="oshal-swarm-bots"`).toContain('job="oshal-swarm-bots"');
      expect(rule.expr, `${rule.alert} must not act on the core job`).not.toContain('job="oshal-core"');
      expect(rule.labels?.intake, `${rule.alert} is an A1 worker rule and must declare intake: auto`).toBe('auto');
    }
    const api = allRules.find((r) => r.alert === 'SwarmApiUnreachable')!;
    expect(api.expr).toContain('job="oshal-core"');
    expect(api.labels?.intake, 'SwarmApiUnreachable is A0 — core-plane recovery is watchdog territory').toBeUndefined();
  });
});

describe('the scrape targets match the deployment', () => {
  it('every runtime job scrapes /metrics and derives the container label from the address', () => {
    for (const jobName of RUNTIME_JOBS) {
      const job = prometheusCfg.scrape_configs.find((c) => c.job_name === jobName)!;
      expect(job.metrics_path, `${jobName} must scrape /metrics, not a JSON health endpoint`).toBe('/metrics');
      const derives = (job.relabel_configs ?? []).some((r) => r.target_label === 'container');
      expect(derives, `${jobName} must relabel a container identity onto every target`).toBe(true);
    }
  });

  it('the api target is /metrics — /api/health returns JSON and Prometheus cannot parse it', () => {
    // The original bug: a JSON body is a scrape FAILURE, so `up` was pinned to 0 and
    // SwarmApiUnreachable fired forever on a healthy box.
    const raw = read(PROMETHEUS_YML);
    expect(raw).not.toMatch(/metrics_path:\s*\/api\/health/);
    // Which container the core job resolves to is now a discovery property, asserted by
    // "both runtime jobs discover by that label" below — the api carries `oshal.tier: core`.
    for (const jobName of RUNTIME_JOBS) {
      const job = prometheusCfg.scrape_configs.find((c) => c.job_name === jobName);
      expect(job?.metrics_path, `${jobName} must scrape /metrics`).toBe('/metrics');
    }
  });

  // ── Discovery replaced the hand-written target list (2026-08-13, BUG-15) ──────────────
  // The two assertions that used to live here compared prometheus.yml's static target list
  // against compose, in both directions. They were correct and they DID catch career-bot going
  // unscraped — but a list that has to be kept in step with compose is a second source of truth,
  // and it drifted the first time somebody added a bot. Both jobs now discover targets from the
  // Docker API by container label, so the list cannot drift because there is no list.
  //
  // What must be guarded is therefore the MECHANISM, not a set difference: every oshal runtime
  // inherits the label, discovery filters on exactly that label, and the two traps found while
  // proving it live (a target per exposed port, a target per attached network) stay closed.

  it('every oshal runtime inherits the scrape label from the x-bot-common anchor', () => {
    // This is what makes monitoring automatic: a new bot is scraped because it inherits the
    // anchor, not because anyone remembered a step. If the label leaves the anchor, every
    // future bot is born unmonitored.
    const compose = read(STACK_COMPOSE);
    const anchor = compose.slice(compose.indexOf('x-bot-common: &bot-common'), compose.indexOf('x-bot-env:'));
    expect(anchor, 'x-bot-common must label its containers `oshal.tier: worker`').toMatch(/labels:\s+oshal\.tier:\s*worker/);
    // The controller overrides the tier — alert-rules.yml scopes the worker rules to
    // job="oshal-swarm-bots" and liveness to job="oshal-core".
    const api = compose.slice(compose.indexOf('  oshal-api:'), compose.indexOf('  oshal-api:') + 900);
    expect(api, 'oshal-api must override the anchor with `oshal.tier: core`').toMatch(/labels:\s+oshal\.tier:\s*core/);
  });

  it('both runtime jobs discover by that label instead of listing targets', () => {
    for (const jobName of RUNTIME_JOBS) {
      const job = prometheusCfg.scrape_configs.find((c) => c.job_name === jobName) as Record<string, unknown>;
      expect(job, `prometheus.yml must declare the ${jobName} scrape job`).toBeTruthy();
      const sd = job.docker_sd_configs as Array<Record<string, unknown>> | undefined;
      expect(sd, `${jobName} must use docker_sd_configs — a static list drifts (BUG-15)`).toBeTruthy();
      expect(job.static_configs, `${jobName} must not reintroduce a hand-written target list`).toBeUndefined();
      const tier = jobName === 'oshal-core' ? 'core' : 'worker';
      const filters = sd![0].filters as Array<{ name: string; values: string[] }>;
      expect(filters.some((f) => f.name === 'label' && f.values.includes(`oshal.tier=${tier}`)),
        `${jobName} must filter on oshal.tier=${tier}`).toBe(true);
    }
  });

  it('discovery yields ONE target per container — not one per exposed port or network', () => {
    // Both traps were observed live on 2026-08-13 before this was closed. The port one is the
    // dangerous half: :1455 is discovered alongside :5000 and is permanently down, which would
    // make SwarmContainerDown fire for every healthy bot in the fleet.
    for (const jobName of RUNTIME_JOBS) {
      const job = prometheusCfg.scrape_configs.find((c) => c.job_name === jobName) as Record<string, unknown>;
      const relabels = (job.relabel_configs ?? []) as Array<Record<string, unknown>>;
      const keeps = relabels.filter((r) => r.action === 'keep');
      const sources = keeps.flatMap((r) => (r.source_labels ?? []) as string[]);
      expect(sources, `${jobName} must keep only the metrics port`).toContain('__meta_docker_port_private');
      expect(sources, `${jobName} must keep only the swarm network`).toContain('__meta_docker_network_name');
      const portKeep = keeps.find((r) => ((r.source_labels ?? []) as string[]).includes('__meta_docker_port_private'));
      expect(String(portKeep!.regex), `${jobName} must scrape port 5000`).toContain('5000');
    }
  });

  it('the container label — the heal target and incident key — is derived from the container name', () => {
    // canonicalizeAlert reads labels.container first and the Stage D dependency map is keyed on
    // oshal-local-* names, so discovery must reproduce exactly what the static list produced.
    for (const jobName of RUNTIME_JOBS) {
      const job = prometheusCfg.scrape_configs.find((c) => c.job_name === jobName) as Record<string, unknown>;
      const relabels = (job.relabel_configs ?? []) as Array<Record<string, unknown>>;
      const containerRule = relabels.find((r) => r.target_label === 'container');
      expect(containerRule, `${jobName} must derive a container label`).toBeTruthy();
      expect((containerRule!.source_labels as string[])).toContain('__meta_docker_container_name');
    }
  });
});

describe('the Alertmanager label contract', () => {
  it('groups and inhibits on `container`, never on the cAdvisor `name` label', () => {
    expect(alertmanagerCfg.route.group_by).toContain('container');
    expect(alertmanagerCfg.route.group_by).not.toContain('name');
    for (const rule of alertmanagerCfg.inhibit_rules) {
      // `equal: ['name']` on a label no series carries means Alertmanager treats every alert
      // as equal — it inhibited alerts for unrelated containers, silently.
      expect(rule.equal).toContain('container');
      expect(rule.equal).not.toContain('name');
    }
  });

  it('the webhook bearer token is mounted from a file, never inlined in the tracked config', () => {
    const raw = read(ALERTMANAGER_YML);
    expect(raw).toContain('credentials_file:');
    expect(raw, 'a literal `credentials:` value would put the webhook secret in git').not.toMatch(/^\s*credentials:\s*\S/m);
  });
});

describe('both runtimes expose the scrape endpoint', () => {
  /** Source with comments stripped — a mention in prose must never satisfy this guard. */
  const code = (rel: string): string =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it.each([
    ['src/app/server.ts', 'swarm'],
    ['src/app/bot-node-server.ts', 'bot-node'],
  ])('%s mounts GET /metrics and renders it with the shared exporter', (file, runtime) => {
    const source = code(file);
    expect(source).toMatch(/app\.get\(\s*'\/metrics'/);
    expect(source).toContain('renderRuntimeMetrics(');
    expect(source).toContain(`runtime: '${runtime}'`);
    expect(source).toContain('PROMETHEUS_CONTENT_TYPE');
  });
});
