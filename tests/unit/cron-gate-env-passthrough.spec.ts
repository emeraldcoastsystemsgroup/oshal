/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the two deployment-gated core crons that could not be switched on from .env: jarvis-brief-cron.ts (JARVIS_BRIEF_CRON) and haven-proactivity-cron.ts (HAVEN_PUSH_CRON) read their gate from the api container's environment, but docker-compose.oshal-local.yml never passed either name through, so the operator's .env line changed nothing and both crons logged "disabled" on every boot (cron inventory, 2026-10-06). The bug shape is the a2a-local-enable one: a flag the operator flips in .env must reach the container, and the compose default must stay EMPTY so a missing .env line means off. Also pins the .env.example documentation to commented-only lines, so a copied example never turns either delivery on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

/**
 * @description Reads a repo-root-relative file as UTF-8 for wiring assertions.
 * @param rel - Path relative to the repo root.
 * @returns The file content.
 */
function readRepoFile(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

/** The two deployment gates and the module each one belongs to. */
const GATES = [
  { name: 'JARVIS_BRIEF_CRON', module: 'src/app/routes/jarvis-brief-cron.ts' },
  { name: 'HAVEN_PUSH_CRON', module: 'src/app/routes/haven-proactivity-cron.ts' },
] as const;

/**
 * @description The environment block of the `oshal-api` service, cut from the compose file so the
 * assertions cannot be satisfied by a passthrough on some other service.
 * @param compose - The whole compose file.
 * @returns The text from the `oshal-api:` service header to the next top-level service.
 */
function apiServiceBlock(compose: string): string {
  const start = compose.indexOf('\n  oshal-api:\n');
  expect(start, 'oshal-api service present').toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('deployment-gated core crons reach the api container (JARVIS_BRIEF_CRON, HAVEN_PUSH_CRON)', () => {
  it('each gate is read by its cron module from the environment under exactly that name', () => {
    // jarvis-brief-cron.ts reads process.env directly; haven-proactivity-cron.ts reads the env
    // object it is handed. Either way the container variable must carry this exact name.
    for (const gate of GATES) {
      expect(readRepoFile(gate.module)).toMatch(new RegExp(`\\benv\\.${gate.name}\\b`));
    }
  });

  it('compose passes both gates through to the api service with EMPTY defaults (the .env line is the single flip point)', () => {
    const block = apiServiceBlock(readRepoFile('docker-compose.oshal-local.yml'));
    for (const gate of GATES) {
      expect(block, `${gate.name} passthrough on oshal-api`).toMatch(new RegExp(`${gate.name}:\\s*\\$\\{${gate.name}:-\\}`));
      // No truthy compose-side default may ever be introduced: a box with no .env line stays off.
      expect(block).not.toMatch(new RegExp(`${gate.name}:\\s*\\$\\{${gate.name}:-\\s*(1|true|yes)\\s*\\}`, 'i'));
      expect(block).not.toMatch(new RegExp(`${gate.name}:\\s*["']?\\s*(1|true|yes)\\s*["']?\\s*$`, 'im'));
    }
  });

  it('.env.example documents each flip line COMMENTED-only (a copied example never enables a delivery)', () => {
    const example = readRepoFile('.env.example');
    for (const gate of GATES) {
      // The documented line may carry a trailing `# …` note like the other cron toggles.
      expect(example).toMatch(new RegExp(`^#\\s*${gate.name}=1(\\s|$)`, 'm'));
      expect(example).not.toMatch(new RegExp(`^\\s*${gate.name}=`, 'm'));
    }
  });
});
