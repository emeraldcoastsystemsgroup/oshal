/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cover rule 3, the live databases named rather than addressed: a DSN whose host is the live database container, the same for the timeseries one, and the container-name DEFAULT shape that was live in the tree and that neither port rule could see. Also holds the line the rule must NOT cross — the alert and topology fixtures name that same container as a monitoring subject dozens of times over, and a rule that fired on those would be worked around within a week. Every offending fixture assembles the container name at run time for the same reason the port literals do: this guard has to pass the gate it proves.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the spec-database-default gate by RUNNING IT — the real script, in Git Bash, against real trees on disk, which is the boundary it acts on. A gate asserted only by reading its source proves nothing about what grep does to a file. Covers both refusals (the live published-port literal in a test file, and a test-tree module reading the published-port knob off the environment even when the literal has been renamed), both allowances that keep the legitimate host-side Playwright helper working, the fail-closed UNCHECKED verdict on a tree with no test files, and the real repository passing. The forbidden port is assembled at run time so this guard is not itself a hit for the gate it proves.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const GATE = join(ROOT, 'scripts', 'ci', 'check-spec-database-default.sh').replaceAll('\\', '/');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-spec-db-gate-'));

/**
 * The live stack's published Postgres ports, assembled rather than written. A literal here would
 * make this guard fail the very gate it proves, and a guard that has to be allowlisted out of its
 * own rule is a rule with a hole in it.
 */
const LIVE_PG = ['554', '33'].join('');
const LIVE_TSDB = ['554', '34'].join('');
const KNOB = ['process', 'env', 'OSHAL_PG_PORT'].join('.');
/** The live stack's database containers, assembled for the same reason the ports are. */
const LIVE_DB_CONTAINER = ['oshal', 'local', 'db'].join('-');
const LIVE_TSDB_CONTAINER = ['oshal', 'local', 'tsdb'].join('-');

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** @description Locate Git Bash without falling into Windows' WSL launcher. */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up++) {
    for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing the WSL bash on PATH');
}

const BASH = resolveBash();

/** @description Build a throwaway tree of the given files and run the REAL gate against it. */
function judge(name: string, files: Record<string, string>): { status: number; output: string } {
  const root = join(SCRATCH, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  const run = spawnSync(BASH, [GATE, root.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 120_000 });
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

const CLEAN_SPEC = [
  "import { specDatabaseUrl } from '../helpers/spec-database-url';",
  "const DSN = specDatabaseUrl(['MY_TEST_DSN']);",
  'export default DSN;',
].join('\n');

describe('the spec-database-default gate REFUSES a test file that can reach the live database', () => {
  it('fails on the live trading database published-port literal in a spec, and names the file', () => {
    const offending = `const DSN = 'postgresql://oshal:oshal@127.0.0.1:${LIVE_PG}/oshal';\n`;
    const verdict = judge('literal', { 'tests/unit/offender.spec.ts': offending });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('tests/unit/offender.spec.ts');
    expect(verdict.output).toMatch(/FAIL/);
  });

  it('fails on the timeseries database published-port literal too — the same stack, the same class', () => {
    const offending = `const DSN = 'postgresql://oshal:oshal@127.0.0.1:${LIVE_TSDB}/oshal';\n`;
    expect(judge('tsdb', { 'tests/unit/offender.spec.ts': offending }).status).toBe(1);
  });

  it('fails on the SILENT-DEFAULT shape even when the port literal has been renamed', () => {
    // This is the shape that has to stay caught: the literal moved, the reach for the published-port
    // knob did not. `5432` is not a live published port, so only the knob rule can fire here.
    const offending = `const DSN = \`postgresql://oshal:oshal@127.0.0.1:\${${KNOB} ?? '5432'}/oshal\`;\n`;
    const verdict = judge('knob', { 'tests/unit/offender.spec.ts': offending });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('tests/unit/offender.spec.ts');
  });

  it('judges the colocated src test tree, not only tests/', () => {
    const offending = `const DSN = 'postgresql://oshal:oshal@127.0.0.1:${LIVE_PG}/oshal';\n`;
    const verdict = judge('src-tree', { 'src/features/thing/thing.test.ts': offending });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('thing.test.ts');
  });

  it('fails when a test HELPER reaches for the published-port knob and hands it to a spec', () => {
    // The hole a file-extension rule alone would leave. It is closed structurally, not by a list.
    const verdict = judge('helper-knob', {
      'tests/helpers/sneaky.ts': `export const PORT = ${KNOB} ?? '5432';\n`,
      'tests/unit/user.spec.ts': CLEAN_SPEC,
    });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('tests/helpers/sneaky.ts');
  });

  it('fails on a DSN whose HOST is the live database container, not only on its published port', () => {
    // The half the port rules could not see: the same server, named instead of addressed.
    const offending = `const DSN = 'postgresql://oshal:oshal@${LIVE_DB_CONTAINER}:5432/oshal';\n`;
    const verdict = judge('live-host', { 'tests/unit/offender.spec.ts': offending });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('tests/unit/offender.spec.ts');
  });

  it('fails on the timeseries container in the host position too', () => {
    const offending = `const DSN = 'postgresql://oshal:oshal@${LIVE_TSDB_CONTAINER}:5432/oshal';\n`;
    expect(judge('live-tsdb-host', { 'tests/unit/offender.spec.ts': offending }).status).toBe(1);
  });

  it('fails on a pg config whose host FIELD is the live database container', () => {
    const offending = `const pool = new Pool({ host: '${LIVE_DB_CONTAINER}', port: 5432 });\n`;
    expect(judge('live-host-field', { 'tests/unit/offender.spec.ts': offending }).status).toBe(1);
  });

  it('fails on the container-name DEFAULT — the shape that was live in the tree', () => {
    // `process.env.OSHAL_TEST_DB_CONTAINER || '<the live container>'` pointed a spec's own
    // `docker exec psql` at the deployment while the DSN beside it was correctly disposable.
    const offending = `const C = process.env.OSHAL_TEST_DB_CONTAINER || '${LIVE_DB_CONTAINER}';\n`;
    const verdict = judge('container-default', { 'tests/unit/offender.spec.ts': offending });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('tests/unit/offender.spec.ts');
  });

  it('fails when a test HELPER carries the live host, not only a spec', () => {
    const verdict = judge('helper-live-host', {
      'tests/helpers/sneaky-host.ts': `export const DSN = 'postgres://oshal@${LIVE_DB_CONTAINER}:5432/oshal';\n`,
      'tests/unit/user.spec.ts': CLEAN_SPEC,
    });
    expect(verdict.status).toBe(1);
    expect(verdict.output).toContain('tests/helpers/sneaky-host.ts');
  });

  it('points the reader at the resolver instead of at a way to silence the gate', () => {
    const offending = `const DSN = 'postgresql://oshal:oshal@127.0.0.1:${LIVE_PG}/oshal';\n`;
    const verdict = judge('message', { 'tests/unit/offender.spec.ts': offending });
    expect(verdict.output).toContain('tests/helpers/spec-database-url.ts');
    expect(verdict.output).toMatch(/DISPOSABLE/);
  });
});

describe('the gate ALLOWS the legitimate uses, so it does not have to be worked around', () => {
  it('passes a tree whose specs resolve through the helper', () => {
    const verdict = judge('clean', { 'tests/unit/user.spec.ts': CLEAN_SPEC });
    expect(verdict.status).toBe(0);
    expect(verdict.output).toMatch(/OK/);
  });

  it('passes the host-side Playwright helper shape: the published port, read from an INJECTED env', () => {
    // tests/helpers/host-database-url.ts rewrites a compose DSN onto the published port so a
    // host-side Playwright run can reach compose Postgres. That is deliberate and read-mostly, and
    // it survives on the rules as written — it is not a test file, and it never touches process.env.
    const helper = [
      `export const DEFAULT_PUBLISHED_PG_PORT = '${LIVE_PG}';`,
      'export function rewrite(raw: string, env: NodeJS.ProcessEnv): string {',
      '  const url = new URL(raw);',
      '  url.port = String(env.OSHAL_PG_PORT ?? DEFAULT_PUBLISHED_PG_PORT);',
      '  return url.toString();',
      '}',
    ].join('\n');
    const verdict = judge('host-helper', {
      'tests/helpers/host-database-url.ts': helper,
      'tests/unit/user.spec.ts': CLEAN_SPEC,
    });
    expect(verdict.status).toBe(0);
  });

  it('does not fire on a fixture that names the live container as a MONITORING SUBJECT', () => {
    // tests/unit/alert-*.spec.ts name this container dozens of times as an alert target and a
    // dependency-map node. Those are not connections, and a rule that reddened them would be
    // worked around rather than obeyed. The distinction is the shape, not an allowlist.
    const fixture = [
      `const event = { target: '${LIVE_DB_CONTAINER}', alertname: 'ContainerDown' };`,
      `const chain = ['oshal-local-api', '${LIVE_DB_CONTAINER}'];`,
      'export default { event, chain };',
    ].join('\n');
    const verdict = judge('monitoring-subject', { 'tests/unit/alert-shape.spec.ts': fixture });
    expect(verdict.status).toBe(0);
    expect(verdict.output).toMatch(/OK/);
  });

  it('does not fire on a host FIELD pointing somewhere that is not the live stack', () => {
    const verdict = judge('other-host', {
      'tests/unit/user.spec.ts': "const pool = new Pool({ host: '127.0.0.1', port: 5432 });\n",
    });
    expect(verdict.status).toBe(0);
  });

  it('does not fire on a number that merely contains the port digits', () => {
    const verdict = judge('word-boundary', {
      'tests/unit/user.spec.ts': `const NOT_A_PORT = 1${LIVE_PG}0;\nexport default NOT_A_PORT;\n`,
    });
    expect(verdict.status).toBe(0);
  });

  it('passes THIS repository — the gate is green on the tree it ships in', () => {
    const run = spawnSync(BASH, [GATE, ROOT.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 120_000 });
    expect(`${run.stdout ?? ''}${run.stderr ?? ''}`).toMatch(/OK/);
    expect(run.status).toBe(0);
  });
});

describe('the gate is fail-closed — it never reports clean on a tree it did not read', () => {
  it('reports UNCHECKED, not OK, when there are no test files to judge', () => {
    const verdict = judge('empty', { 'tests/helpers/index.ts': 'export {};\n' });
    expect(verdict.status).toBe(2);
    expect(verdict.output).toContain('UNCHECKED');
    expect(verdict.output).not.toMatch(/: OK/);
  });

  it('reports UNCHECKED for a root that does not exist at all', () => {
    const run = spawnSync(BASH, [GATE, join(SCRATCH, 'no-such-tree').replaceAll('\\', '/')], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status).toBe(2);
    expect(`${run.stdout ?? ''}${run.stderr ?? ''}`).toContain('UNCHECKED');
  });
});

describe('ci-local.sh actually runs the gate', () => {
  it('defines the gate and invokes it in the node-gates block', () => {
    expect(CI_SOURCE).toContain('check-spec-database-default.sh');
    expect(CI_SOURCE).toContain('gate_spec_database_default()');
    expect(CI_SOURCE).toContain('run_gate spec-database-default gate_spec_database_default');
  });

  it('judges the committed export, like the other source-hygiene gates', () => {
    const body = /gate_spec_database_default\(\) \{\n([^}]*)\n\}/.exec(CI_SOURCE);
    expect(body?.[1]).toContain('$GATE_SRC');
  });
});
