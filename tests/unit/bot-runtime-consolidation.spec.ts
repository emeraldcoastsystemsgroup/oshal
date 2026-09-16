/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Bot runtime consolidation": one canonical worker runtime. Evaluates the SHIPPED runtime-selection block of scripts/bot-entrypoint.sh under a real POSIX shell (node/npm/npx stubbed on PATH so `exec` is observable instead of launching a server) and proves the two ways a deployment used to end up on the wrong process: BOT_RUNTIME=any-bot booted the legacy any-bot/server/app.js (no Redis envelope consumption, no heartbeat, no delegation verifier), and ANY unrecognised value fell through to the controller (dist/app/server.js) — the exact shape recorded in deploy/helm/oshal/templates/bots.yaml change-log seq 2, where a "bot" booted the controller and crash-looped. Also pins that every BOT_RUNTIME in the deployment manifests is one the entrypoint implements, and that the third worker implementation (any-bot/server/swarm-node.js) is gone.
 */

/**
 * Bot runtime consolidation guard.
 *
 * The boundary this crosses is the container start decision itself: the same
 * shell text that `docker-compose.oshal-local.yml` and the Helm chart exec at
 * boot, evaluated by `sh`, with `node`/`npm`/`npx` replaced by stubs that echo
 * their argv. Asserting on the script's source text would not cross it — a
 * condition can read correctly and still branch the wrong way — so every
 * runtime case here is decided by the shell, not by a substring.
 *
 * @module bot-runtime-consolidation.spec
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRYPOINT = path.join(REPO_ROOT, 'scripts', 'bot-entrypoint.sh');

/** The line that begins the runtime-selection block; everything after it is the switch. */
const SELECTION_MARKER = 'BOT_RUNTIME="${BOT_RUNTIME:-swarm}"';

/** The declaration the entrypoint uses as its single source of truth for selectable runtimes. */
const CANONICAL_DECLARATION = /^CANONICAL_BOT_RUNTIMES="([^"]*)"$/m;

/** Outcome of evaluating the shipped selection block for one environment. */
interface RuntimeDecision {
  /** Exit status of the shell; non-zero means the entrypoint refused to start anything. */
  status: number | null;
  /** Every command the block launched, in order; empty when it refused to start anything. */
  launched: string[];
  /** The command the block finally `exec`ed, or null when it refused. */
  execed: string | null;
  /** Combined stdout + stderr, for asserting that a refusal is actionable. */
  output: string;
}

/**
 * @description Reads the shipped entrypoint and returns the runtime-selection block verbatim.
 * @returns The text from the BOT_RUNTIME default assignment to end of file.
 */
function selectionBlock(): string {
  const source = fs.readFileSync(ENTRYPOINT, 'utf8');
  const index = source.indexOf(SELECTION_MARKER);
  expect(index, `${SELECTION_MARKER} not found in scripts/bot-entrypoint.sh`).toBeGreaterThan(-1);
  return source.slice(index);
}

/**
 * @description Creates a throwaway bin directory whose `node`, `npm` and `npx` echo their
 * argv, so an `exec` in the shipped block is observable without starting a server.
 * @returns Absolute path to the stub bin directory.
 */
function stubBin(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-bot-runtime-'));
  for (const name of ['node', 'npm', 'npx']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "EXEC ${name} $*"\n`, { mode: 0o755 });
  }
  return bin;
}

const STUB_BIN = stubBin();
const BLOCK = selectionBlock();

/**
 * @description Runs the shipped selection block under `sh` for one BOT_RUNTIME/NODE_ENV pair.
 * @param env Environment overrides; an empty BOT_RUNTIME exercises the unset default.
 * @returns What the entrypoint decided to launch, or the refusal it produced.
 */
function decide(env: Record<string, string>): RuntimeDecision {
  const result = spawnSync('sh', ['-c', BLOCK], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH ?? ''}`, ...env },
  });
  expect(result.error, `sh is required to evaluate ${ENTRYPOINT}`).toBeUndefined();
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // The dev branch runs `npm install` before it execs, so the LAST stub line is the exec.
  const launched = (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('EXEC '))
    .map((line) => line.slice('EXEC '.length).trim());
  return {
    status: result.status,
    launched,
    execed: launched.length > 0 ? launched[launched.length - 1] : null,
    output,
  };
}

/**
 * @description Collects every literal BOT_RUNTIME value assigned in a deployment manifest.
 * @param file Repo-relative manifest path.
 * @returns The runtime values the manifest selects (comment lines excluded).
 */
function declaredRuntimes(file: string): string[] {
  const absolute = path.join(REPO_ROOT, file);
  if (!fs.existsSync(absolute)) return [];
  const values: string[] = [];
  for (const raw of fs.readFileSync(absolute, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    // compose: `BOT_RUNTIME: bot-node`   helm: `value: bot-node` under `name: BOT_RUNTIME`
    const compose = line.match(/^BOT_RUNTIME:\s*["']?([A-Za-z0-9._-]+)["']?$/);
    if (compose) values.push(compose[1]);
  }
  return values;
}

/**
 * @description Collects BOT_RUNTIME values from a Helm template, where the name and the
 * value are adjacent list entries rather than one key/value pair.
 * @param file Repo-relative template path.
 * @returns The runtime values the template sets.
 */
function declaredHelmRuntimes(file: string): string[] {
  const absolute = path.join(REPO_ROOT, file);
  if (!fs.existsSync(absolute)) return [];
  const lines = fs.readFileSync(absolute, 'utf8').split('\n');
  const values: string[] = [];
  lines.forEach((raw, index) => {
    if (!/^\s*-\s*name:\s*BOT_RUNTIME\s*$/.test(raw)) return;
    const next = lines[index + 1] ?? '';
    const match = next.match(/^\s*value:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/);
    if (match) values.push(match[1]);
  });
  return values;
}

describe('bot runtime consolidation — one canonical worker runtime', () => {
  const canonical = (fs.readFileSync(ENTRYPOINT, 'utf8').match(CANONICAL_DECLARATION)?.[1] ?? '')
    .split(/\s+/)
    .filter(Boolean);

  it('declares the complete set of selectable runtimes in one place', () => {
    expect(canonical).toEqual(['swarm', 'bot-node']);
  });

  it('starts the canonical worker for BOT_RUNTIME=bot-node', () => {
    const decision = decide({ BOT_RUNTIME: 'bot-node', NODE_ENV: 'production' });
    expect(decision.status).toBe(0);
    expect(decision.execed).toBe('node dist/app/bot-node-server.js');
  });

  it('starts the controller for BOT_RUNTIME=swarm and for an unset BOT_RUNTIME', () => {
    for (const value of ['swarm', '']) {
      const decision = decide({ BOT_RUNTIME: value, NODE_ENV: 'production' });
      expect(decision.status, `BOT_RUNTIME=${value || '<unset>'}`).toBe(0);
      expect(decision.execed, `BOT_RUNTIME=${value || '<unset>'}`).toBe('node dist/app/server.js');
    }
  });

  it('keeps the development hot-swap path on the controller runtime', () => {
    const decision = decide({ BOT_RUNTIME: 'swarm', NODE_ENV: 'development' });
    expect(decision.status).toBe(0);
    expect(decision.execed).toContain('npx nodemon');
    expect(decision.execed).toContain('src/app/server.ts');
  });

  it('refuses the demoted any-bot runtime instead of booting the legacy JS server', () => {
    const decision = decide({ BOT_RUNTIME: 'any-bot', NODE_ENV: 'production' });
    expect(decision.status).not.toBe(0);
    expect(decision.launched).toEqual([]);
    expect(decision.output).not.toContain('any-bot/server/app.js');
    // The refusal has to say what to use instead, or it is just a crash loop.
    expect(decision.output).toContain('BOT_RUNTIME=bot-node');
  });

  it('refuses an unrecognised BOT_RUNTIME instead of silently booting the controller', () => {
    for (const value of ['worker', 'botnode', 'bot_node', 'swarm-node']) {
      const decision = decide({ BOT_RUNTIME: value, NODE_ENV: 'production' });
      expect(decision.status, `BOT_RUNTIME=${value}`).not.toBe(0);
      expect(decision.launched, `BOT_RUNTIME=${value} must not launch a process`).toEqual([]);
      expect(decision.output, `BOT_RUNTIME=${value}`).toContain(value);
    }
  });

  it('refuses any-bot even when delegation material is configured', () => {
    const decision = decide({
      BOT_RUNTIME: 'any-bot',
      NODE_ENV: 'production',
      OSHAL_DELEGATION_PUBLIC_KEYS: 'kid-1:AAAA',
    });
    expect(decision.status).not.toBe(0);
    expect(decision.launched).toEqual([]);
  });

  it('selects only runtimes the entrypoint implements from every deployment manifest', () => {
    const selected = [
      ...declaredRuntimes('docker-compose.oshal-local.yml'),
      ...declaredRuntimes('docker-compose.swarm-local.yml'),
      ...declaredRuntimes('docker-compose.incident-lab.yml'),
      ...declaredHelmRuntimes('deploy/helm/oshal/templates/api.yaml'),
      ...declaredHelmRuntimes('deploy/helm/oshal/templates/bots.yaml'),
    ];
    // A manifest that set nothing would make this vacuous.
    expect(selected.length).toBeGreaterThanOrEqual(3);
    for (const value of selected) {
      expect(canonical, `manifest selects BOT_RUNTIME=${value}`).toContain(value);
      // And the shell agrees the value starts something.
      expect(decide({ BOT_RUNTIME: value, NODE_ENV: 'production' }).execed).not.toBeNull();
    }
  });

  it('keeps exactly one bot-worker implementation in the tree', () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src', 'app', 'bot-node-server.ts')),
      'the canonical worker runtime must exist',
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'any-bot', 'server', 'swarm-node.js')),
      'any-bot/server/swarm-node.js is the retired third worker runtime — it must not come back',
    ).toBe(false);
  });

  it('marks the legacy any-bot server as demoted in its own source', () => {
    const appSource = fs.readFileSync(path.join(REPO_ROOT, 'any-bot', 'server', 'app.js'), 'utf8');
    expect(appSource).toContain('NOT a supported BOT_RUNTIME target');
    expect(appSource).toContain('src/app/bot-node-server.ts');
  });
});
