/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard fail-closed packaged-bot runtime validation and dynamic registry propagation.
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

  it('retains the legacy Claude default only when both runtime fields are omitted', () => {
    expect(manifestBotDefinition(readBot())).toMatchObject({
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
});
