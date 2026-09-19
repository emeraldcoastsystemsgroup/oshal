/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the chart README's "Durability boundary" (BACKLOG: k8s durability posture for the shared-service tier). The chart is the single-box product - one replica per workload, dev-parity credentials, no backup - and the README declares durable Postgres/Timescale, a real Vault and volume backup OUT OF SCOPE, each with the boundary where a shared tenant takes over. A declaration like that rots the moment the chart changes, so this RENDERS THE REAL CHART with the helm binary and holds the section to the output: the volume table must equal the claims the chart creates with every optional flag on, in both directions; no workload above one replica; no backup, snapshot or restore object rendered or templated; every boundary switch the README names must remove its workload and withhold exactly the env it lists (an explicit container env entry beats envFrom, so a URL left in place would shadow the tenant's Secret); chart bots must take the managed DSN from swarm.botDatabaseUrl; and the Terraform sentence must name exactly the switches deploy/terraform/main.tf forwards. No helm on PATH is a loud failure, never a skip.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Hold deploy/terraform/README.md to the templates that exist. Its checklist item 5 listed TimescaleDB, ArangoDB, Vault, code-server, speaker-diarization and ollama as "Not yet in the chart (compose-only infra)" and said in bold that "trading cannot run on k8s until tsdb is templated" - all six had been templated since #198 (chart 0.3.0), so a tenant following that checklist kept trading off Kubernetes for no reason. The case DERIVES the service list from deploy/helm/oshal/templates/*.yaml rather than hardcoding it, because a literal list rots the same way the prose did.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHART_DIR = path.join(REPO_ROOT, 'deploy', 'helm', 'oshal');
const README = fs.readFileSync(path.join(CHART_DIR, 'README.md'), 'utf8');
const TERRAFORM_MAIN = fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'terraform', 'main.tf'), 'utf8');
const values = yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>;
const RENDER_TIMEOUT_MS = 120_000;

/** The three hand-offs the BACKLOG done-when names: deleting any row must go red. */
const REQUIRED_SWITCHES = ['infra.postgres.inCluster', 'infra.tsdb.inCluster', 'infra.vault.inCluster'];

/** The two volumes the done-when names: the backup row must name each. */
const REQUIRED_BACKUP_CLAIMS = ['oshal-workspace', 'data-oshal-chromadb-0'];

/** Object kinds that would make "the chart ships no backup" false. */
const BACKUP_KIND = /^(CronJob|Job|VolumeSnapshot\w*|\w*Backup\w*|\w*Restore\w*)$/;

interface K8sObject {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: Record<string, any>;
}

const renders = new Map<string, K8sObject[]>();

/**
 * @description Render the chart with the real helm binary and parse every
 * document. Memoised per --set list so each posture renders once per run.
 * @param sets helm --set expressions (empty = chart defaults)
 * @returns {K8sObject[]} every rendered object that carries a kind
 */
function render(sets: string[]): K8sObject[] {
  const key = sets.join('\n');
  const cached = renders.get(key);
  if (cached) return cached;
  const args = ['template', 'oshal', CHART_DIR, '--namespace', 'oshal', ...sets.flatMap((s) => ['--set', s])];
  let out: string;
  try {
    out = execFileSync('helm', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    const why = e.code === 'ENOENT' ? 'the helm binary is not on PATH' : (e.stderr || e.message);
    throw new Error(`helm template failed (${sets.join(' ') || 'defaults'}): ${why} - this guard renders the REAL chart and does not skip`);
  }
  const docs = (yaml.loadAll(out) as unknown[]).filter(
    (d): d is K8sObject => Boolean(d && typeof d === 'object' && (d as K8sObject).kind),
  );
  renders.set(key, docs);
  return docs;
}

/**
 * @description Every boolean switch in values.yaml named `inCluster` or `enabled`,
 * turned on, so the render is the most the chart can ever create. Derived from the
 * values tree, not a hand list: a new optional service behind either convention is
 * covered the day it lands.
 * @param node values subtree
 * @param prefix dotted path of that subtree
 * @returns {string[]} helm --set expressions
 */
function everythingOn(node: Record<string, any> = values, prefix = ''): string[] {
  const sets: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if ((k === 'inCluster' || k === 'enabled') && typeof v === 'boolean') sets.push(`${p}=true`);
    else if (v && typeof v === 'object' && !Array.isArray(v)) sets.push(...everythingOn(v, p));
  }
  return sets;
}

/**
 * @description The PersistentVolumeClaims a render produces: standalone claims by
 * name, and each StatefulSet volumeClaimTemplate as the claim Kubernetes creates
 * for it (<template>-<statefulset>-<ordinal>) - the names `kubectl get pvc` shows.
 * @param objects rendered objects
 * @returns {string[]} sorted claim names
 */
function durableClaims(objects: K8sObject[]): string[] {
  const claims: string[] = [];
  for (const o of objects) {
    if (o.kind === 'PersistentVolumeClaim') claims.push(o.metadata.name);
    if (o.kind !== 'StatefulSet') continue;
    for (const t of o.spec?.volumeClaimTemplates ?? []) {
      for (let i = 0; i < (o.spec?.replicas ?? 1); i += 1) claims.push(`${t.metadata.name}-${o.metadata.name}-${i}`);
    }
  }
  return claims.sort();
}

/**
 * @description Names of every Deployment/StatefulSet in a render.
 * @param objects rendered objects
 * @returns {string[]} workload names
 */
function workloads(objects: K8sObject[]): string[] {
  return objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet').map((o) => o.metadata.name);
}

/**
 * @description The api container of a render; throws when absent so a later
 * assertion can never pass against nothing.
 * @param objects rendered objects
 * @returns the container spec
 */
function apiContainer(objects: K8sObject[]): Record<string, any> {
  const api = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'oshal-api');
  const container = api?.spec?.template?.spec?.containers?.find((c: { name: string }) => c.name === 'api');
  if (!container) throw new Error('render has no oshal-api Deployment with an "api" container');
  return container;
}

/**
 * @description Explicit env keys on a container (the ones that beat envFrom).
 * @param c container spec
 * @returns {string[]} env names
 */
function explicitEnv(c: Record<string, any>): string[] {
  return (c.env ?? []).map((e: { name: string }) => e.name);
}

/**
 * @description The "## Durability boundary" section of the chart README, up to
 * the next level-2 heading.
 * @returns {string} section body, or '' when the heading is absent
 */
function boundarySection(): string {
  const lines = README.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Durability boundary\s*$/.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * @description Split one markdown table row into trimmed cells.
 * @param line table row
 * @returns {string[]} cells
 */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * @description Body rows of the first table in the section whose first header
 * cell matches.
 * @param text README section text
 * @param header pattern for the first header cell
 * @returns {string[][]} rows as cells, header and separator excluded
 */
function table(text: string, header: RegExp): string[][] {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.trim().startsWith('|') && header.test(cells(l)[0] ?? ''));
  if (head < 0) return [];
  const rows: string[][] = [];
  for (const l of lines.slice(head + 2)) {
    if (!l.trim().startsWith('|')) break;
    rows.push(cells(l));
  }
  return rows;
}

/**
 * @description Backticked tokens in a markdown cell.
 * @param cell cell text
 * @returns {string[]} token contents
 */
function ticks(cell: string | undefined): string[] {
  return [...(cell ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

const section = boundarySection();
const volumeRows = table(section, /^Volume/);
const scopeRows = table(section, /^Out of scope/);

/**
 * @description The infra.<key>.inCluster switch an out-of-scope row names, if any.
 * @param row table cells
 * @returns {string | undefined} the switch path
 */
function switchOf(row: string[]): string | undefined {
  return ticks(row[1]).map((t) => /^(infra\.[A-Za-z]+\.inCluster): false$/.exec(t)?.[1]).find(Boolean);
}

/**
 * @description Template files that declare an object of a backup kind, read with
 * comment lines removed so change-log prose never counts. Catches a backup object
 * gated behind a flag the all-on render does not know to flip.
 * @returns {string[]} offending template file names
 */
function templatedBackupFiles(): string[] {
  const dir = path.join(CHART_DIR, 'templates');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).filter((file) => {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#'));
    return lines.some((l) => BACKUP_KIND.test(/^\s*kind:\s*(\S+)\s*$/.exec(l)?.[1] ?? ''));
  });
}

describe('chart README durability boundary is the rendered chart, not a promise', () => {
  it('the README carries the section with its volume and out-of-scope tables', () => {
    expect(section, 'deploy/helm/oshal/README.md has no "## Durability boundary" section').not.toBe('');
    expect(volumeRows.length, 'no "Volume (PVC)" table in the durability boundary').toBeGreaterThan(0);
    expect(scopeRows.length, 'no "Out of scope here" table in the durability boundary').toBeGreaterThan(0);
  });

  it('the volume table is exactly the claims the chart creates with every optional flag on', () => {
    const rendered = durableClaims(render(everythingOn()));
    const listed = volumeRows.map((r) => ticks(r[0])[0]).filter(Boolean).sort();
    expect(rendered.length, 'the all-on render produced no claims - the derivation is broken').toBeGreaterThan(0);
    const missing = rendered.filter((c) => !listed.includes(c));
    const stale = listed.filter((c) => !rendered.includes(c));
    expect({ missing, stale }, 'README volume table and chart disagree: add what is missing, drop what is stale').toEqual({
      missing: [], stale: [],
    });
  }, RENDER_TIMEOUT_MS);

  it('nothing in the chart backs a volume up or restores one, and the README says so for workspace and Chroma', () => {
    const all = render(everythingOn());
    const rendered = all.filter((o) => BACKUP_KIND.test(o.kind)).map((o) => `${o.kind}/${o.metadata.name}`);
    expect({ rendered, templated: templatedBackupFiles() }, 'the README declares the chart ships no backup - update the durability boundary with it').toEqual({
      rendered: [], templated: [],
    });
    // The row that STARTS with "Backup": the Postgres row mentions backups too.
    const backupRow = scopeRows.find((r) => /^Backup\b/i.test(r[0] ?? ''));
    expect(backupRow, 'the out-of-scope table has no row starting "Backup"').toBeTruthy();
    const claims = durableClaims(all);
    for (const c of REQUIRED_BACKUP_CLAIMS) {
      expect(ticks(backupRow?.[0]), `the backup row does not name ${c}`).toContain(c);
      expect(claims, `${c} is named for backup but the chart creates no such claim`).toContain(c);
    }
  }, RENDER_TIMEOUT_MS);

  it('every workload runs exactly one replica - the single-box shape the README declares', () => {
    const all = render(everythingOn()).filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet');
    expect(all.length).toBeGreaterThanOrEqual(5);
    const multi = all.filter((o) => o.spec?.replicas !== 1).map((o) => `${o.metadata.name}=${o.spec?.replicas}`);
    expect(multi, 'a workload above one replica - the README durability boundary no longer describes this chart').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('durable Postgres, durable Timescale and a real Vault each carry a named switch that exists in values', () => {
    const named = scopeRows.map(switchOf).filter((s): s is string => Boolean(s));
    expect(named).toEqual(expect.arrayContaining(REQUIRED_SWITCHES));
    for (const s of named) {
      const key = s.split('.')[1];
      expect(values.infra?.[key]?.inCluster, `${s} is not a default-on values switch`).toBe(true);
    }
  });
});

describe('each durability switch hands off exactly what the README says', () => {
  it('each switch removes its workload and withholds exactly the env the README lists', () => {
    const base = render([]);
    const baseEnv = explicitEnv(apiContainer(base));
    const exercised: string[] = [];
    for (const row of scopeRows) {
      const s = switchOf(row);
      if (!s) continue;
      exercised.push(s);
      const listed = ticks(row[2]).filter((t) => /^[A-Z][A-Z0-9_]*$/.test(t)).sort();
      const off = render([`${s}=false`]);
      const offApi = apiContainer(off);
      const withheld = baseEnv.filter((k) => !explicitEnv(offApi).includes(k)).sort();
      expect(listed.length, `${s}: the README names no env for the tenant to supply`).toBeGreaterThan(0);
      expect(withheld, `${s}=false: README lists [${listed}] but the chart withholds [${withheld}]`).toEqual(listed);
      const removed = workloads(base).filter((w) => !workloads(off).includes(w));
      expect(removed.length, `${s}=false left every in-cluster workload running`).toBeGreaterThan(0);
      const refs = (offApi.envFrom ?? []).map((e: { secretRef?: { name: string } }) => e.secretRef?.name).filter(Boolean);
      expect(refs, `${s}=false: the api no longer reads ${values.api.envSecret}, so nothing would supply the URL`).toContain(values.api.envSecret);
    }
    // A loop over zero rows proves nothing: the required switches must each have run.
    expect(exercised, 'the switch check ran against no README rows').toEqual(expect.arrayContaining(REQUIRED_SWITCHES));
  }, RENDER_TIMEOUT_MS);

  it('with managed Postgres, chart-declared bots take their DSN from swarm.botDatabaseUrl', () => {
    const pgRow = scopeRows.find((r) => switchOf(r) === 'infra.postgres.inCluster');
    expect(ticks(pgRow?.[2]), 'the Postgres row does not tell the tenant where the bots get their DSN').toContain('swarm.botDatabaseUrl');
    const dsn = 'postgresql://oshal_bot:managed@db.example.test:5432/oshal';
    const bots = render(['infra.postgres.inCluster=false', `swarm.botDatabaseUrl=${dsn}`])
      .filter((o) => o.kind === 'Deployment' && o.metadata.labels?.['oshal.io/bot'] === 'true');
    expect(bots.length, 'the default fleet rendered no bots - nothing was checked').toBeGreaterThan(0);
    for (const b of bots) {
      const env = b.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const url = env.find((e: { name: string }) => e.name === 'DATABASE_URL')?.value;
      expect(url, `${b.metadata.name} does not carry swarm.botDatabaseUrl as DATABASE_URL`).toBe(dsn);
    }
  }, RENDER_TIMEOUT_MS);

  it('the Terraform README never calls a templated service "not yet in the chart"', () => {
    // DERIVED from the templates on disk, not from a literal list — a literal one rots exactly
    // the way the prose it guards did. deploy/terraform/README.md claimed TimescaleDB, ArangoDB,
    // Vault, code-server, speaker-diarization and ollama were "Not yet in the chart (compose-only
    // infra)", and stated in bold that "trading cannot run on k8s until tsdb is templated". All
    // six had been templated since #198, chart 0.3.0 — the README simply predated it and nothing
    // re-read it. A tenant following that checklist would keep trading off k8s for no reason.
    const files = fs.readdirSync(path.join(CHART_DIR, 'templates'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, '').toLowerCase());
    expect(files.length, 'no chart templates found - the parse is broken').toBeGreaterThan(5);

    // Prose does not use file names. The first version of this case derived only from
    // `templates/*.yaml` and therefore MISSED the very claim it was written for: the README said
    // "TimescaleDB", the template is `tsdb.yaml`, and the guard passed while the false sentence
    // sat there. It caught `ollama` only because that one happens to match its filename.
    //
    // So the search set is the union of three DERIVED sources plus one declared alias list:
    //   - the template basenames,
    //   - the `infra.*` keys in values.yaml (the switch vocabulary a tenant actually types),
    //   - and the alias map below, which is the only hand-maintained part and is deliberately
    //     tiny. A new alias is needed only when prose calls a service something neither its
    //     template file nor its values key is called.
    const ALIASES: Record<string, string[]> = {
      tsdb: ['timescale', 'timescaledb'],
      arangodb: ['arango'],
      diarization: ['speaker-diarization', 'speaker diarization'],
    };
    const infraKeys = Object.keys((values.infra ?? {}) as Record<string, unknown>).map((k) => k.toLowerCase());
    const templated = [...new Set([
      ...files,
      ...infraKeys,
      ...files.flatMap((f) => ALIASES[f] ?? []),
      ...infraKeys.flatMap((k) => ALIASES[k] ?? []),
    ])];
    for (const key of Object.keys(ALIASES)) {
      expect(
        [...files, ...infraKeys],
        `the alias map names '${key}', which is neither a template nor an infra key - it has gone stale`,
      ).toContain(key);
    }

    const tfReadme = fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'terraform', 'README.md'), 'utf8');
    // The claim shape, wherever it appears: a "not yet in the chart" / "compose-only" passage.
    const claims = tfReadme
      .split(/\n(?=\d+\. |## )/)
      .filter((block) => /not yet in the chart|compose-only infra/i.test(block));

    const offenders: string[] = [];
    for (const block of claims) {
      for (const name of templated) {
        // Match the service name as a word, so 'vault.yaml' is not found inside 'vaulted'.
        if (new RegExp(`\\b${name}\\b`, 'i').test(block)) offenders.push(name);
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      'deploy/terraform/README.md lists services as absent from the chart that the chart templates',
    ).toEqual([]);
  });

  it('the Terraform sentence names exactly the switches deploy/terraform/main.tf forwards', () => {
    const forwarded = [...TERRAFORM_MAIN.matchAll(/^\s*inCluster\s*=\s*var\.([a-z_]+)\s*$/gm)].map((m) => m[1]).sort();
    const named = [...new Set(ticks(section).filter((t) => /^[a-z_]+_in_cluster$/.test(t)))].sort();
    expect(forwarded.length, 'main.tf forwards no inCluster switch - the parse is broken or the module changed').toBeGreaterThan(0);
    expect(named, 'README Terraform sentence and deploy/terraform/main.tf disagree on which switches the module forwards').toEqual(forwarded);
  });
});
