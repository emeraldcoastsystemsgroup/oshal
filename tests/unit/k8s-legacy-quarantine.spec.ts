/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for remote-cluster work package item 9: the legacy Kubernetes generation is quarantined, and the docs stop routing readers to it. The refusal is a SAFETY property, so it is tested by RUNNING every legacy entry point (the known set plus whatever package.json's k8:* scripts and k8s bin resolve to). Each run gets a minimal environment in which recording stand-ins for kubectl, helm, docker, kind, kustomize, python3, node and npm are the only such tools on PATH. Each entry point must refuse in its own name, name the Helm chart path, and reach none of the stand-ins. A control run with OSHAL_ALLOW_LEGACY_K8S=1 proves the stand-ins record what a run reaches, and that the override still gets to the legacy path. The docs half fails when any doc under docs/ mentions oshal-api-server outside a legacy marker, when a doc hands a reader a legacy entry-point command outside a legacy marker, or when the five routing docs stop pointing at docs/k8/README.md and ADR-129. The last block pins the other item 9 reconciliations: the Argo bot-image default, the competitive scorer's k8s check, ADR-035's status, ADR-129's toggle caveat, the BACKLOG chart version, and the whitepaper's elastic-scale claim.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCompetitiveEvidence } from '../../scripts/evidence/competitive-score-evidence';

const REPO = path.join(__dirname, '..', '..');
const OVERRIDE = 'OSHAL_ALLOW_LEGACY_K8S';
const BANNER = 'LEGACY — DO NOT DEPLOY';
/** Tools a legacy entry point could reach. Every one is a recording stand-in on PATH. */
const STANDINS = ['kubectl', 'helm', 'docker', 'kind', 'kustomize', 'python3', 'node', 'npm'];
/** The legacy entry points, named explicitly so a package.json edit cannot shrink the set. */
const KNOWN_ENTRY_POINTS = [
  'scripts/setup-oshal-k8s.sh',
  'scripts/install-k8s.sh',
  'scripts/setup-any-bot-k8s.sh',
  'scripts/setup-any-bot-k8s-cli.js',
  'scripts/build-any-bot-k8s-local-package.sh',
  'scripts/build-any-bot-k8s-installer-image.sh',
];
/** A marker that makes a mention of the legacy generation a quarantine note, not a route. */
const LEGACY_MARKER = /legacy|quarantin|do not deploy|nothing in this repo builds/i;
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @description Absolute bash plus a MINIMAL PATH holding only the POSIX tools a script needs.
 * On Windows the shell is git-bash, so the tool dirs are resolved from the bash.exe it finds.
 * @returns {{bash: string, minimalPath: string} | null} null when no bash exists
 */
function resolveBash(): { bash: string; minimalPath: string } | null {
  if (process.platform !== 'win32') {
    return fs.existsSync('/bin/bash') ? { bash: '/bin/bash', minimalPath: '/usr/bin:/bin' } : null;
  }
  const probe = spawnSync('where', ['bash'], { encoding: 'utf8' });
  const bash = (probe.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('bash.exe'));
  if (!bash || !fs.existsSync(bash)) return null;
  const binDir = path.dirname(bash);
  const gitRoot = path.basename(path.dirname(binDir)).toLowerCase() === 'usr' ? path.dirname(path.dirname(binDir)) : path.dirname(binDir);
  return { bash, minimalPath: [binDir, path.join(gitRoot, 'usr', 'bin')].join(path.delimiter) };
}

const BASH = resolveBash();

/**
 * @description The k8:* npm scripts and the k8s bin, and the script each one runs.
 * @returns The k8:* script table and the de-duplicated targets (an unparseable command is kept
 *   verbatim, so it fails the subset check instead of vanishing).
 */
function packageEntryPoints(): { k8Scripts: Record<string, string>; targets: string[] } {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; bin?: Record<string, string> };
  const k8Scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([name]) => name.startsWith('k8:')));
  const targets = new Set<string>();
  for (const command of Object.values(k8Scripts)) {
    const target = /\b(scripts\/[\w.-]+\.(?:sh|js))\b/.exec(command);
    targets.add(target ? target[1] : command);
  }
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    if (/k8s/.test(name)) targets.add(target.replace(/^\.\//, ''));
  }
  return { k8Scripts, targets: [...targets] };
}

/**
 * @description Run one legacy entry point with recording stand-ins first on PATH and nothing
 * else of the host's environment, stdin closed.
 * @param rel - Repo-relative script path.
 * @param args - Arguments to pass.
 * @param extraEnv - Extra environment (the override, for the control run).
 * @returns Exit status, combined output, the stand-in calls, and the sandbox dir.
 */
function runEntryPoint(rel: string, args: string[], extraEnv: Record<string, string> = {}): { status: number | null; out: string; calls: string[]; sandbox: string } {
  if (!BASH) throw new Error('bash not found — this guard requires a POSIX shell (git-bash on Windows)');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-k8s-legacy-'));
  sandboxes.push(sandbox);
  const standins = path.join(sandbox, 'standins');
  fs.mkdirSync(standins);
  for (const tool of STANDINS) {
    fs.writeFileSync(path.join(standins, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "$STANDIN_LOG"\nexit 0\n`, { mode: 0o755 });
  }
  const log = path.join(sandbox, 'calls.log');
  const env = {
    PATH: [standins, BASH.minimalPath].join(path.delimiter),
    HOME: sandbox,
    TMPDIR: sandbox,
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    STANDIN_LOG: log,
    ...extraEnv,
  };
  const script = path.join(REPO, rel);
  const [cmd, argv] = rel.endsWith('.js') ? [process.execPath, [script, ...args]] : [BASH.bash, [script, ...args]];
  const res = spawnSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd: sandbox });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, calls, sandbox };
}

const ENTRY_POINTS = [...new Set([...KNOWN_ENTRY_POINTS, ...packageEntryPoints().targets])];

/**
 * @description The keys and placeholder values of both legacy example env files, handed to a
 * refusal run as plain environment. A script whose gate was removed then has every value it
 * requires and goes on to its tools, where the stand-ins record it. They are passed as
 * environment rather than `--env-file` because Node reads `--env-file` from anywhere in argv,
 * so the flag would never reach the JS CLI.
 * @returns The merged key/value map.
 */
function exampleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rel of ['ops/deployment/oshal-k8s.env.example', 'ops/any-bot-k8s/setup.env.example']) {
    for (const line of read(rel).split(/\r?\n/)) {
      const kv = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (kv && !(kv[1] in env)) env[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

describe('legacy Kubernetes entry points refuse without the override', () => {
  it('every k8:* npm script and the k8s bin resolve to a quarantined entry point', () => {
    const { k8Scripts, targets } = packageEntryPoints();
    expect(Object.keys(k8Scripts).length, 'no k8:* scripts parsed — the check below would be vacuous').toBeGreaterThan(0);
    expect(targets.filter((t) => !KNOWN_ENTRY_POINTS.includes(t))).toEqual([]);
  });

  it.each(ENTRY_POINTS)('%s refuses in its own name, names the chart path, and reaches no tool', (rel) => {
    const { status, out, calls } = runEntryPoint(rel, ['--apply'], exampleEnv());
    expect(calls, 'a refused legacy entry point must not reach kubectl, helm, docker or any other tool').toEqual([]);
    expect(out).toContain(`REFUSED: ${rel}`);
    expect(out).toContain('deploy/helm/oshal');
    expect(out).toContain('docs/k8/README.md');
    expect(out).toContain(`${OVERRIDE}=1`);
    expect(status).toBe(2);
  }, 60_000);

  it('only the exact value 1 overrides the refusal', () => {
    const { status, calls } = runEntryPoint('scripts/setup-oshal-k8s.sh', ['--help'], { [OVERRIDE]: 'true' });
    expect(status).toBe(2);
    expect(calls).toEqual([]);
  }, 60_000);

  it('control: with the override the legacy path still runs, and the stand-ins record what it reaches', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-k8s-legacy-out-'));
    sandboxes.push(outDir);
    const run = runEntryPoint('scripts/build-any-bot-k8s-installer-image.sh', ['--output-dir', outDir], { [OVERRIDE]: '1' });
    expect(run.status, run.out).toBe(0);
    expect(run.calls.some((c) => c.startsWith('docker build'))).toBe(true);
    expect(run.out).toContain(`-e ${OVERRIDE}=1`);
    const help = runEntryPoint('scripts/setup-oshal-k8s.sh', ['--help'], { [OVERRIDE]: '1' });
    expect(help.status).toBe(0);
    expect(help.out).toContain('Usage: bash scripts/setup-oshal-k8s.sh');
  }, 60_000);
});

/** Files of the legacy generation that must open with the banner. */
const BANNERED = [
  'ops/deployment/kubernetes/oshal-stack.yaml',
  'ops/deployment/kubernetes/oshal-secrets.example.yaml',
  'ops/deployment/presentron-integration.yaml',
  ...fs.readdirSync(path.join(REPO, 'ops', 'any-bot-k8s')).filter((f) => f.endsWith('.yaml')).map((f) => `ops/any-bot-k8s/${f}`),
  ...KNOWN_ENTRY_POINTS,
  'scripts/any-bot-k8s-installer.Dockerfile',
  'ops/any-bot-k8s/README.md',
  'ops/deployment/README.md',
  'docs/k8/any-bot-kubernetes-setup.md',
];

describe('the legacy generation carries its quarantine banner', () => {
  it.each(BANNERED)('%s opens with the LEGACY banner that names the chart path', (rel) => {
    const head = read(rel).split('\n').slice(0, 14).join('\n');
    expect(head).toContain(BANNER);
    expect(head).toContain('deploy/helm/oshal');
    expect(head).toContain('docs/k8/README.md');
  });
});

/**
 * @description Lines matching `pattern` that no legacy marker covers. A mention is covered by a
 * file banner in the first 20 lines, by any enclosing heading that carries a marker, or by the
 * block it sits in (a blank-line-delimited paragraph, or a single table row) carrying one.
 * @param text - Markdown source.
 * @param pattern - What counts as a mention.
 * @param inCodeOnly - Only consider lines inside fenced code blocks.
 * @returns 1-based line numbers with their text.
 */
function uncoveredMentions(text: string, pattern: RegExp, inCodeOnly = false): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.slice(0, 20).some((l) => l.includes(BANNER))) return [];
  const headings: Array<{ level: number; text: string }> = [];
  let inFence = false;
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    const heading = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      while (headings.length && headings[headings.length - 1].level >= heading[1].length) headings.pop();
      headings.push({ level: heading[1].length, text: heading[2] });
      return;
    }
    if (!pattern.test(line) || (inCodeOnly && !inFence)) return;
    if (headings.some((h) => LEGACY_MARKER.test(h.text))) return;
    if (inCodeOnly && line.includes(`${OVERRIDE}=1`)) return;
    if (LEGACY_MARKER.test(blockAround(lines, i))) return;
    out.push(`${i + 1}: ${line.trim()}`);
  });
  return out;
}

/**
 * @description The block a line belongs to: its own row for a table line, else the run of
 * non-blank lines around it.
 * @param lines - All lines.
 * @param i - The line index.
 * @returns The block text.
 */
function blockAround(lines: string[], i: number): string {
  if (/^\s*\|/.test(lines[i])) return lines[i];
  let start = i;
  let end = i;
  while (start > 0 && lines[start - 1].trim() && !/^\s*\|/.test(lines[start - 1])) start -= 1;
  while (end < lines.length - 1 && lines[end + 1].trim() && !/^\s*\|/.test(lines[end + 1])) end += 1;
  return lines.slice(start, end + 1).join('\n');
}

/**
 * @description Every markdown file under a repo-relative directory.
 * @param dir - Repo-relative directory.
 * @returns Repo-relative file paths.
 */
function markdownUnder(dir: string): string[] {
  const root = path.join(REPO, dir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return markdownUnder(rel);
    return e.name.endsWith('.md') ? [rel] : [];
  });
}

const LEGACY_IMAGE = /oshal-api-server/;
const LEGACY_COMMAND = /scripts\/(?:install-k8s|setup-oshal-k8s|setup-any-bot-k8s)|npm run k8:|oshal-any-bot-k8s-setup/;
const LEGACY_ROUTE = /ops\/deployment\/kubernetes|ops\/any-bot-k8s|(?<![\w/-])any-bot-k8s\/|install-k8s\.sh|setup-oshal-k8s|setup-any-bot-k8s|k8:(?:setup|install|bootstrap)|oshal-api-server/;
const ROUTING_DOCS = [
  'docs/deployment-models.md',
  'docs/framework-developer-guide.md',
  'docs/architecture/core-runtime-overview.md',
  'docs/setup/core-setup.md',
  'docs/README.md',
];

describe('docs do not route a reader to the legacy generation as a current path', () => {
  it('self-test: a current-path mention is flagged, a legacy-marked one is not', () => {
    const routed = '# Guide\n\n## Kubernetes\n\nDeploy it:\n\n```bash\nnpm run k8:install:any-bot\n```\n\nIt runs oshal-api-server:latest.\n';
    expect(uncoveredMentions(routed, LEGACY_IMAGE)).toEqual(['11: It runs oshal-api-server:latest.']);
    expect(uncoveredMentions(routed, LEGACY_COMMAND, true)).toEqual(['8: npm run k8:install:any-bot']);
    const marked = '# Guide\n\n## Legacy Kubernetes\n\nIt runs oshal-api-server:latest.\n';
    expect(uncoveredMentions(marked, LEGACY_IMAGE)).toEqual([]);
    const row = '| a | b |\n|---|---|\n| legacy | ops/any-bot-k8s |\n| current | ops/any-bot-k8s |\n';
    expect(uncoveredMentions(row, LEGACY_ROUTE)).toEqual(['4: | current | ops/any-bot-k8s |']);
  });

  it('no doc under docs/ mentions oshal-api-server outside a legacy marker', () => {
    const docs = markdownUnder('docs');
    expect(docs.length).toBeGreaterThan(50);
    const hits = docs.flatMap((rel) => uncoveredMentions(read(rel), LEGACY_IMAGE).map((h) => `${rel}:${h}`));
    expect(hits).toEqual([]);
  });

  it('no doc hands a reader a legacy entry-point command outside a legacy marker', () => {
    const docs = [...markdownUnder('docs'), ...markdownUnder('ops'), 'scripts/README.md'];
    const hits = docs.flatMap((rel) => uncoveredMentions(read(rel), LEGACY_COMMAND, true).map((h) => `${rel}:${h}`));
    expect(hits).toEqual([]);
  });

  it.each(ROUTING_DOCS)('%s points at docs/k8/README.md and ADR-129 and routes nowhere legacy', (rel) => {
    const text = read(rel);
    expect(text).toMatch(/\bk8\/README\.md\b/);
    expect(text).toContain('129-codeless-k8s-install-path.md');
    expect(uncoveredMentions(text, LEGACY_ROUTE)).toEqual([]);
  });

  it('docs/README.md indexes the k8 folder against the chart, not the legacy workspace', () => {
    const row = read('docs/README.md').split('\n').find((l) => l.startsWith('| [k8/](./k8/README.md)'));
    expect(row, 'the docs index lost its k8/ row').toBeDefined();
    expect(row).toContain('deploy/helm/oshal');
    expect(row).not.toMatch(/manifests themselves live in `ops\/any-bot-k8s\/`/);
  });

  it('the legacy any-bot guide uses repo-relative ops/any-bot-k8s/ paths', () => {
    const rootRelative = read('docs/k8/any-bot-kubernetes-setup.md').split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /(?<!ops\/)(?<![\w-])any-bot-k8s\//.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(rootRelative).toEqual([]);
  });
});

describe('the other item 9 reconciliations stay reconciled', () => {
  it('the Argo WorkflowTemplate defaults bot-image to oshal-bot, the image this repo builds', () => {
    const lines = read('ops/deployment/argo/incident-rca-workflowtemplate.yaml').split('\n');
    const at = lines.findIndex((l) => /-\s*name:\s*bot-image\s*$/.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(/value:\s*"([^"]+)"/.exec(lines[at + 1])?.[1]).toBe('oshal-bot:latest');
  });

  it('the competitive scorer reads the Helm chart, and a legacy script on disk no longer satisfies it', () => {
    const k8s = (root: string) => buildCompetitiveEvidence(root, { dateStamp: '2026-09-21' })
      .categories.find((c) => c.id === 'local-self-host')?.checks.find((c) => c.id === 'k8s-setup');
    const live = k8s(REPO);
    expect(live?.evidence).toBe('deploy/helm/oshal/Chart.yaml');
    expect(live?.status).toBe('pass');
    const legacyOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-k8s-score-'));
    sandboxes.push(legacyOnly);
    fs.mkdirSync(path.join(legacyOnly, 'scripts'));
    fs.writeFileSync(path.join(legacyOnly, 'scripts', 'setup-oshal-k8s.sh'), '#!/bin/bash\n');
    expect(k8s(legacyOnly)?.status).toBe('missing');
  });

  it('ADR-035 reads accepted-as-amended and cites the 2026-09-21 decision, in the file and the index', () => {
    const status = read('docs/adr/035-multi-tenant-saas-foundation.md').split('\n').find((l) => l.startsWith('Status:')) ?? '';
    expect(status).not.toMatch(/^Status:\s*\**Proposed/);
    expect(status).toMatch(/Accepted/);
    expect(status).toContain('2026-09-21');
    expect(status).toContain('Two-tier tenant provisioning');
    const row = read('docs/adr/README.md').split('\n').find((l) => l.startsWith('| [035]')) ?? '';
    expect(row).toMatch(/Accepted as amended 2026-09-21/);
  });

  it('ADR-129 no longer calls the fixed k8s bot toggle inert', () => {
    const adr = read('docs/adr/129-codeless-k8s-install-path.md');
    expect(adr).not.toContain('still constructs the compose');
    expect(adr).toContain('tests/unit/bot-status-toggle-substrate.spec.ts');
  });

  it('the BACKLOG shared-service tier entry names no chart version as current', () => {
    const backlog = read('docs/BACKLOG.md');
    const start = backlog.indexOf('### k8s shared-service tier');
    expect(start).toBeGreaterThan(-1);
    const entry = backlog.slice(start, backlog.indexOf('\n### ', start + 1));
    const chartVersion = /^version:\s*(\S+)/m.exec(read('deploy/helm/oshal/Chart.yaml'))?.[1];
    const stated = [...entry.matchAll(/\bchart (\d+\.\d+\.\d+) templates\b|`version: (\d+\.\d+\.\d+)`/g)].map((m) => m[1] ?? m[2]);
    expect(stated.filter((v) => v !== chartVersion)).toEqual([]);
  });

  it('the whitepaper makes no elastic-scale claim for Kubernetes', () => {
    expect(read('docs/OSHAL-WHITEPAPER.md')).not.toMatch(/elastic scale/i);
  });
});
