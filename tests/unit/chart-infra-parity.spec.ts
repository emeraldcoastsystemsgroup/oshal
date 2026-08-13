/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-129 shared-service tier (chart 0.3.0). The defect it prevents is the one the operator caught by reading, not by testing: the chart shipped WITHOUT tsdb/arango/vault/code-server/diarization even though none of them carries a compose profile — they start on every default `up`, so k8s silently ran a degraded platform (no trading series, graph 503, no vault, no IDE, no local transcription). This derives the shared-service set FROM compose, so adding a profile-less infra service there without templating it here goes red. Also pins: every templated service's URL env is actually wired (a StatefulSet nothing points at is a no-op), profile-gated services stay OFF by default (ollama), code-server is never exposed by default (it runs --auth none over a read-write workspace — compose contains it by binding 127.0.0.1), and store-package staging lands before the api boots.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHART_DIR = path.join(REPO_ROOT, 'deploy', 'helm', 'oshal');
const TEMPLATES = path.join(CHART_DIR, 'templates');

const values = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>;
const compose = yaml.load(
  fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.oshal-local.yml'), 'utf8'),
) as Record<string, any>;

/** Compose service name -> the chart's infra.<key> that must template it. */
const INFRA_MAP: Record<string, string> = {
  'oshal-db': 'postgres',
  'oshal-redis': 'redis',
  'oshal-chromadb': 'chromadb',
  'oshal-tsdb': 'tsdb',
  'oshal-arangodb': 'arangodb',
  'oshal-vault': 'vault',
  'code-server': 'codeServer',
  'speaker-diarization': 'diarization',
  'oshal-ollama': 'ollama',
};

/**
 * @description Compose services that are real shared infrastructure: they carry an
 * image/build of their own and are NOT oshal bot-nodes (a bot has AGENT_ID).
 * @returns {Array<{name: string, profiled: boolean}>}
 */
function composeInfraServices(): Array<{ name: string; profiled: boolean }> {
  return Object.entries(compose.services ?? {})
    .filter(([name, svc]: [string, any]) => {
      const env = svc?.environment ?? {};
      if (env.AGENT_ID) return false; // a bot-node, covered by chart-fleet-parity
      if (name === 'oshal-api') return false; // the controller itself
      if (name.endsWith('-pull')) return false; // one-shot init helpers
      return Boolean(svc?.image || svc?.build);
    })
    .map(([name, svc]: [string, any]) => ({
      name,
      profiled: Array.isArray(svc?.profiles) && svc.profiles.length > 0,
    }));
}

const templateSources = fs
  .readdirSync(TEMPLATES)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(TEMPLATES, f), 'utf8') }));

/** @description Strip comment lines so change-log prose never counts as rendered template code. */
const code = (t: string) => t.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

/**
 * @description True when a template emits this EXACT env key — as a container env
 * entry (`- name: KEY`) or a ConfigMap data key (`  KEY:`). Substring matching is
 * not enough: it accepts a renamed/disabled key like TSDB_URL_DISABLED, which is
 * precisely how a wiring regression would slip through.
 * @param block template source with comments stripped
 * @param envKey exact environment variable name
 * @returns {boolean}
 */
function emitsEnvKey(block: string, envKey: string): boolean {
  // Two shapes: a container env entry (value on the next line) and a ConfigMap
  // data key (value inline). The key itself must match exactly in both.
  return block
    .split('\n')
    .some((l) => new RegExp(`^\\s*(- name: ${envKey}|${envKey}:(\\s.*)?)$`).test(l.trimEnd()));
}

/**
 * @description The template file that actually DECLARES a workload for this
 * service — a Deployment/StatefulSet named for it. Checking only for a values
 * reference is too weak: sibling templates reference the same flag to wire env,
 * so deleting the workload file would otherwise pass.
 * @param workloadName k8s (and compose) service name
 * @returns the template source, or undefined
 */
function workloadTemplateFor(workloadName: string) {
  return templateSources.find((t) => {
    const block = code(t.text);
    if (!/kind:\s*(Deployment|StatefulSet)/.test(block)) return false;
    return block.split('\n').some((l) => l.trimEnd() === `  name: ${workloadName}`);
  });
}

describe('ADR-129 shared-service tier: compose infra is chart infra', () => {
  it('every profile-less compose infra service is templated in the chart', () => {
    const missing: string[] = [];
    for (const svc of composeInfraServices()) {
      if (svc.profiled) continue; // not started by a default `up` either
      const key = INFRA_MAP[svc.name];
      if (!key) {
        missing.push(`${svc.name} (no infra.<key> mapping — a NEW compose infra service: template it, or map+profile it deliberately)`);
        continue;
      }
      if (values.infra?.[key] === undefined) missing.push(`${svc.name} -> infra.${key} missing from values.yaml`);
      const workload = workloadTemplateFor(svc.name);
      if (!workload) {
        missing.push(`${svc.name} -> no template declares a Deployment/StatefulSet named "${svc.name}"`);
      } else if (!code(workload.text).includes(`.Values.infra.${key}.inCluster`)) {
        missing.push(`${svc.name} -> ${workload.file} does not guard on infra.${key}.inCluster`);
      }
    }
    expect(missing, `untemplated shared services would ship a silently degraded k8s platform:\n${missing.join('\n')}`).toEqual([]);
  });

  it('services a default compose `up` starts are ON by default; profile-gated ones are OFF', () => {
    for (const svc of composeInfraServices()) {
      const key = INFRA_MAP[svc.name];
      if (!key || values.infra?.[key] === undefined) continue;
      expect(
        values.infra[key].inCluster,
        `infra.${key}.inCluster should be ${!svc.profiled} — compose ${svc.profiled ? 'gates it behind a profile' : 'starts it on every default up'}`,
      ).toBe(!svc.profiled);
    }
  });

  it('each enabled service has its URL env wired, gated on the same flag', () => {
    // A templated StatefulSet nothing points at is a no-op. Each pair is
    // (values flag, the env key the platform actually reads).
    const wiring: Array<[string, string]> = [
      ['infra.tsdb.inCluster', 'TSDB_URL'],
      ['infra.arangodb.inCluster', 'ARANGO_URL'],
      ['infra.vault.inCluster', 'VAULT_ADDR'],
      ['infra.diarization.inCluster', 'SPEAKER_DIARIZATION_URL'],
      ['infra.chromadb.inCluster', 'CHROMADB_URL'],
      ['infra.ollama.inCluster', 'OLLAMA_HOST'],
    ];
    for (const [flag, envKey] of wiring) {
      const owner = templateSources.find((t) => emitsEnvKey(code(t.text), envKey));
      expect(owner, `${envKey} is never emitted by any template — ${flag} would start a service nothing talks to`).toBeTruthy();
      const block = code(owner!.text);
      const envIdx = block.indexOf(envKey);
      const guardIdx = block.lastIndexOf(flag, envIdx);
      expect(
        guardIdx,
        `${envKey} must sit inside an "if ${flag}" guard — advertising a URL for a disabled service turns a clean degrade into connection-refused`,
      ).toBeGreaterThan(-1);
    }
  });
});

describe('ADR-129 shared-service safety + package staging', () => {
  it('code-server is never network-exposed by default (--auth none over a RW workspace)', () => {
    expect(values.infra.codeServer.serviceType).toBe('ClusterIP');
    const cs = code(templateSources.find((t) => t.file === 'code-server.yaml')!.text);
    expect(cs).toContain('--auth');
    // Compose binds it to 127.0.0.1 with an explicit "do NOT expose" note; the
    // cluster equivalent is ClusterIP + port-forward. If a future edit defaults
    // this to NodePort/LoadBalancer, that is a real exposure regression.
    expect(cs.includes('nodePort:'), 'code-server must not template a nodePort by default').toBe(false);
  });

  it('vault ships dev-mode without a PVC (it must not imply durability it lacks)', () => {
    const v = code(templateSources.find((t) => t.file === 'vault.yaml')!.text);
    expect(v).toContain('"server", "-dev"');
    expect(v.includes('PersistentVolumeClaim'), 'dev-mode vault is in-memory — a PVC would imply persistence it does not have').toBe(false);
  });

  it('store packages stage BEFORE the api container starts, and fail loudly', () => {
    const api = code(templateSources.find((t) => t.file === 'api.yaml')!.text);
    expect(api).toContain('initContainers:');
    expect(api).toContain('oshal-app.js install');
    // Auto-load registers a package's bots/surfaces once at boot: staging after
    // the api starts silently does nothing until a restart.
    expect(api.indexOf('initContainers:')).toBeLessThan(api.indexOf('exec node dist/app/server.js'));
    expect(api).toContain('exit 1');
    expect(values.packages).toEqual([]);
    expect(values.store.auditMode).toBe('compatible');
  });
});
