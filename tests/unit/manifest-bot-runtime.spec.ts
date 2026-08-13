/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard fail-closed packaged-bot runtime validation and dynamic registry propagation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-093 Tier 2: guard the bots[].container/port node declaration — passthrough to the dynamic registry (dispatch leaves the controller), the 5000 default, and every fail-closed rejection shape (bad slug, 'oshal-api', orphan port, non-integer port).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1: the omitted-runtime default is now codex-cli/openai-codex, not claude-code — changed knowingly, since omitting harnessType is the norm for store packages and the old default minted Claude Code bots into a codex fleet. Added the companion row proving an EXPLICIT claude-code declaration still survives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { manifestBotDefinition } from '../../src/app/extensions/swarm/manifest-bot-definition';
import { readManifest, type SwarmAppBotDeclaration } from '../../src/features/swarm-apps';

const tempDirs: string[] = [];

/** @description Read one throwaway manifest through the production loader. */
function readBot(runtime = ''): SwarmAppBotDeclaration {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-bot-runtime-'));
  tempDirs.push(dir);
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: runtime-test\ndisplayName: Runtime Test\nsuite: ai-creative\nbots:\n  - agentId: dd000000-0000-0000-0000-000000000001\n    name: dungeon-master\n${runtime}`, 'utf8');
  return readManifest(file).bots![0];
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('packaged bot runtime declarations', () => {
  it('accepts and preserves an OpenAI Codex runtime on the inline package bot', () => {
    const bot = readBot('    harnessType: codex-cli\n    apiType: openai-codex\n');
    const definition = manifestBotDefinition(bot);
    expect(definition).toMatchObject({
      agentId: bot.agentId, container: 'oshal-api', port: 3010,
      harnessType: 'codex-cli', apiType: 'openai-codex',
    });
  });

  it('inherits the codex FLEET default when both runtime fields are omitted', () => {
    // Was: 'retains the legacy Claude default…'. Changed knowingly under ADR-128 Amendment 1
    // (operator directive 2026-08-13) — the Claude Code subscription is being cancelled, and
    // omitting harnessType is the NORM for store packages, so the old default quietly minted a
    // Claude Code bot into a codex fleet on every package that never thought about harnesses.
    expect(manifestBotDefinition(readBot())).toMatchObject({
      container: 'oshal-api', harnessType: 'codex-cli', apiType: 'openai-codex',
    });
  });

  it('still honours an explicitly declared Claude runtime — defaults moved, choices did not', () => {
    const definition = manifestBotDefinition(readBot('    harnessType: claude-code\n    apiType: claude-code\n'));
    expect(definition).toMatchObject({
      container: 'oshal-api', harnessType: 'claude-code', apiType: 'claude-code',
    });
  });

  it('accepts a non-Codex Cline provider while retaining the inline container', () => {
    const definition = manifestBotDefinition(readBot('    harnessType: cline\n    apiType: openai\n'));
    expect(definition).toMatchObject({
      container: 'oshal-api', harnessType: 'cline', apiType: 'openai',
    });
  });

  it('rejects partial, unknown, and incompatible runtime declarations', () => {
    expect(() => readBot('    harnessType: codex-cli\n')).toThrow(/declare harnessType and apiType together/);
    expect(() => readBot('    harnessType: future-cli\n    apiType: openai-codex\n')).toThrow(/harnessType is unknown/);
    expect(() => readBot('    harnessType: codex-cli\n    apiType: future-api\n')).toThrow(/apiType is unknown/);
    expect(() => readBot('    harnessType: codex-cli\n    apiType: claude-code\n')).toThrow(/runtime is incompatible/);
    expect(() => readBot('    harnessType: cline\n    apiType: a2a\n')).toThrow(/runtime is incompatible/);
  });

  it('registers a declared node container/port as a dedicated bot-node (ADR-093 Tier 2)', () => {
    const bot = readBot('    container: career-bot\n    port: 5001\n');
    expect(manifestBotDefinition(bot)).toMatchObject({ container: 'career-bot', port: 5001 });
  });

  it('defaults a declared node to the standard execution port 5000', () => {
    expect(manifestBotDefinition(readBot('    container: career-bot\n')))
      .toMatchObject({ container: 'career-bot', port: 5000 });
  });

  it('rejects malformed node declarations fail-closed instead of registering the bot inline', () => {
    expect(() => readBot('    container: "Career Bot"\n')).toThrow(/container must be a Docker service-name slug/);
    expect(() => readBot('    container: oshal-api\n')).toThrow(/must name a dedicated bot-node service/);
    expect(() => readBot('    port: 5000\n')).toThrow(/port is only meaningful together with container/);
    expect(() => readBot('    container: career-bot\n    port: 99999\n')).toThrow(/port must be an integer TCP port/);
    expect(() => readBot('    container: career-bot\n    port: half\n')).toThrow(/port must be an integer TCP port/);
  });
});
