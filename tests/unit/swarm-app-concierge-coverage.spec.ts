/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 executable manifest contract: canonical trimmed selector precedence and ordered external associations; warn/enforce behavior for static, non-empty dynamic and group cockpit surfaces; assistant-only/headless/empty UI exclusions; one stable warning per read; fail-closed invalid deployment mode; and the core person-model concierge's real Jarvis reachability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const logging = vi.hoisted(() => {
  const warn = vi.fn();
  const childLogger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(),
  };
  return { warn, childLogger };
});

vi.mock('@/shared/logger', () => ({
  logger: logging.childLogger,
  createChildLogger: () => logging.childLogger,
  LOG_REDACT_OPTIONS: { paths: [], censor: '[REDACTED]' },
}));

import {
  CONCIERGE_COVERAGE_WARNING_EVENT,
  CONCIERGE_COVERAGE_WARNING_MESSAGE,
  manifestConciergeName,
  manifestExternalAgentNames,
  readManifest,
  resolveConciergeCoverageMode,
  type SwarmAppManifest,
} from '@/features/swarm-apps';
import { isBotAccessibleTo } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';

const tempDirs: string[] = [];

function writeManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-concierge-'));
  tempDirs.push(dir);
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, body, 'utf8');
  return file;
}

const preamble = (name = 'covered') => `name: ${name}\ndisplayName: Covered\nsuite: ai-knowledge\n`;

const staticSurface = [
  'ui:',
  '  static:',
  '    - { toolName: home, label: Home, icon: codicon codicon-home, iframeUrl: /home }',
  '',
].join('\n');

const dynamicSurface = [
  'ui:',
  '  dynamic:',
  '    source: things',
  '    toolNameTemplate: thing-{id}',
  '    labelField: name',
  '    icon: codicon codicon-list-tree',
  '    iframeUrlTemplate: /things/{id}',
  '',
].join('\n');

const groupSurface = [
  'kind: group',
  'dependencies:',
  '  apps: [member]',
  'toolbar:',
  '  - { app: member, surface: member-home }',
  '',
].join('\n');

afterEach(() => {
  vi.unstubAllEnvs();
  logging.warn.mockClear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('canonical manifest concierge selector', () => {
  it('uses trimmed chatBot, then workerBot, then the first declared bot name', () => {
    const manifest = {
      name: 'a', displayName: 'A', chatBot: '  advisor  ',
      workflow: { name: 'w', pipeline: 'manifest-worker', workerBot: ' worker ' },
      bots: [{ agentId: 'a1', name: ' first ', persona: 'p.yaml' }],
    } as SwarmAppManifest;
    expect(manifestConciergeName(manifest)).toBe('advisor');
    expect(manifestConciergeName({ ...manifest, chatBot: '   ' })).toBe('worker');
    expect(manifestConciergeName({ ...manifest, chatBot: '', workflow: undefined })).toBe('first');
  });

  it('treats empty, blank and non-string candidates as absent', () => {
    expect(manifestConciergeName({ name: 'a', displayName: 'A' })).toBeUndefined();
    expect(manifestConciergeName({
      name: 'a', displayName: 'A', chatBot: ' ',
      workflow: { name: 'w', pipeline: 'manifest-worker', workerBot: '\t' },
      bots: [{ agentId: 'a1', name: '\n', persona: 'p.yaml' }],
    })).toBeUndefined();
  });

  it('associates an explicit external chatBot before a distinct external workflow worker', () => {
    const manifest = {
      name: 'a', displayName: 'A', chatBot: ' advisor ',
      workflow: { name: 'w', pipeline: 'manifest-worker', workerBot: ' worker ' },
    } as SwarmAppManifest;

    expect(manifestExternalAgentNames(manifest)).toEqual(['advisor', 'worker']);
  });

  it('does not duplicate external associations that are backed by declared bots', () => {
    const manifest = {
      name: 'a', displayName: 'A', chatBot: 'advisor',
      workflow: { name: 'w', pipeline: 'manifest-worker', workerBot: 'local-worker' },
      bots: [{ agentId: 'a1', name: 'local-worker', persona: 'p.yaml' }],
    } as SwarmAppManifest;

    expect(manifestExternalAgentNames(manifest)).toEqual(['advisor']);
  });

  it('selects the real person-model general-bot, which the registry admits for Jarvis', () => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'enforce');
    const manifest = readManifest(resolve('swarm-apps', 'person-model.yaml'));
    const general = LOCAL_BOT_REGISTRY.find(bot => bot.name === 'general-bot');

    expect(manifestConciergeName(manifest)).toBe('general-bot');
    expect(general, 'general-bot must exist in the default registry').toBeDefined();
    expect(isBotAccessibleTo(general!.agentId, 'jarvis')).toBe(true);
  });
});

describe('readManifest P8 cockpit coverage', () => {
  it('defaults to warn, normalizes configured values, and fails closed on an invalid mode', () => {
    expect(resolveConciergeCoverageMode(undefined)).toBe('warn');
    expect(resolveConciergeCoverageMode(' ENFORCE ')).toBe('enforce');
    expect(() => resolveConciergeCoverageMode('observe')).toThrow(
      'OSHAL_CONCIERGE_COVERAGE_MODE must be warn or enforce',
    );
  });

  it('loads in warn mode and emits exactly one stable structured warning per violating read', () => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'warn');
    const file = writeManifest(preamble() + staticSurface);

    expect(readManifest(file).name).toBe('covered');

    expect(logging.warn).toHaveBeenCalledTimes(1);
    expect(logging.warn).toHaveBeenCalledWith(
      {
        event: CONCIERGE_COVERAGE_WARNING_EVENT,
        app: 'covered',
        path: file,
        mode: 'warn',
      },
      CONCIERGE_COVERAGE_WARNING_MESSAGE,
    );
  });

  it.each([
    ['static', staticSurface],
    ['dynamic', dynamicSurface],
    ['group', groupSurface],
  ])('rejects a surfaced %s package with no concierge in enforce mode', (_kind, surface) => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'enforce');
    const file = writeManifest(preamble() + surface);

    expect(() => readManifest(file)).toThrow(
      /cockpit surface for app "covered" requires a concierge.*chatBot, workflow\.workerBot, or bots\[0\]\.name/,
    );
  });

  it('accepts a group chatBot as metadata while executable group keys remain forbidden', () => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'enforce');
    const loaded = readManifest(writeManifest(preamble() + 'chatBot: member-concierge\n' + groupSurface));
    expect(loaded.chatBot).toBe('member-concierge');

    expect(() => readManifest(writeManifest(
      preamble('bad-group') + 'chatBot: member-concierge\n' + groupSurface
        + 'routes:\n  - { module: routes/x.js, factory: f, mountPath: /api/g, auth: oidc }\n',
    ))).toThrow(/a group carries no code.*remove routes/);
  });

  it('does not classify assistant-only, headless, empty-static, or empty-dynamic manifests as cockpit surfaces', () => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'enforce');
    const assistant = 'ui:\n  assistant: { label: Ask, icon: codicon codicon-comment, iframeUrl: /ask }\n';
    for (const body of [assistant, '', 'ui:\n  static: []\n', 'ui:\n  dynamic: {}\n']) {
      expect(() => readManifest(writeManifest(preamble() + body))).not.toThrow();
    }
    expect(logging.warn).not.toHaveBeenCalled();
  });

  it('rejects blank candidates on a surface instead of counting key presence', () => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'enforce');
    expect(() => readManifest(writeManifest(preamble() + 'chatBot: "   "\n' + staticSurface)))
      .toThrow(/requires a concierge/);
  });

  it('rejects an invalid global mode even for a headless manifest', () => {
    vi.stubEnv('OSHAL_CONCIERGE_COVERAGE_MODE', 'typo');
    expect(() => readManifest(writeManifest(preamble())))
      .toThrow('OSHAL_CONCIERGE_COVERAGE_MODE must be warn or enforce');
  });
});
