/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the dev-mode change classifier and Jarvis's changeClass hint. The regression these prevent is a fast lane widening: if a compiled path (src/**\/*.ts, any-bot/server) ever classifies as live-appliable, the sidecar writes code the running image does not contain, the box serves something no commit describes, and the next deploy silently reverts it. Each case pins a specific path shape rather than asserting the function "works".
 */

import { describe, expect, it } from 'vitest';
import {
  classifyChangePath,
  classifyChangeSet,
  isChangeClass,
  isLiveAppliable,
  normalizeRepoRelative,
  restartActionFor,
  type ChangeClass,
} from '@/features/dev-console';
import { extractHandoffs } from '@/app/routes/jarvis-directives';

/** Wrap a directive JSON body in the handoff fence Jarvis emits. */
function fence(json: string): string {
  return ['Working on it.', '```handoff', json, '```'].join('\n');
}

describe('change classification — which lane can actually make a path live', () => {
  it('classifies the bind-mounted static surfaces as assets (no restart at all)', () => {
    for (const p of [
      'src/pages/cockpit/js/jarvis-orb.js',
      'src/api/jarvis.html',
      'src/api/jarvis-stage.css',
      'src/shared/ui/tokens.css',
    ]) {
      expect(classifyChangePath(p), p).toBe('asset');
    }
    expect(restartActionFor('asset')).toBe('none');
  });

  it('treats a COMPILED file under an asset root as core, not as an asset', () => {
    // src/pages is bind-mounted, but a .ts there is compiled into dist and baked into the
    // image. Extension-blind matching on the directory is the exact mistake that would ship
    // a live edit the running process never loads.
    expect(classifyChangePath('src/pages/cockpit/controller.ts')).toBe('core');
    expect(classifyChangePath('src/api/handler.tsx')).toBe('core');
  });

  it('classifies any-bot/server as core even though the API bind-mounts it', () => {
    // Verified against the deployed stack: /app/any-bot/server is bind-mounted into the API
    // but NOT into bot containers, and bots are what execute it. "The API can see it" is not
    // "the runtime that uses it can see it".
    expect(classifyChangePath('any-bot/server/services/llm/ClineProvider.js')).toBe('core');
    expect(restartActionFor('core')).toBe('full-deploy');
  });

  it('classifies manifests, personas and store packages into their own lanes', () => {
    expect(classifyChangePath('swarm-apps/intelligent-operations.yaml')).toBe('manifest');
    expect(classifyChangePath('ai-lab/bot-personas/oshal-developer.yaml')).toBe('persona');
    expect(classifyChangePath('deployed-apps/career-hunter/routes/search.js')).toBe('package');
    expect(restartActionFor('manifest')).toBe('app-reload');
    expect(restartActionFor('persona')).toBe('bot-restart');
    expect(restartActionFor('package')).toBe('api-restart');
  });

  it('classifies operator-owned infrastructure as infra (never automatic)', () => {
    for (const p of [
      'docker-compose.oshal-local.yml',
      'Dockerfile.oshal',
      '.env.example',
      'deploy/helm/oshal/values.yaml',
      '.github/workflows/ci.yml',
      '.githooks/pre-push',
    ]) {
      expect(classifyChangePath(p), p).toBe('infra');
    }
    expect(restartActionFor('infra')).toBe('operator-only');
  });

  it('fails closed: an unknown path is core, an escaping path is infra', () => {
    expect(classifyChangePath('some/unmapped/thing.py')).toBe('core');
    for (const escape of ['../../etc/passwd', '/etc/passwd', 'C:\\Windows\\system32\\drivers\\etc\\hosts', '']) {
      expect(classifyChangePath(escape), escape).toBe('infra');
    }
  });

  it('normalizes Windows separators but never a traversal segment', () => {
    expect(normalizeRepoRelative('src\\pages\\cockpit\\app.js')).toBe('src/pages/cockpit/app.js');
    expect(normalizeRepoRelative('./swarm-apps/eats.yaml')).toBe('swarm-apps/eats.yaml');
    expect(normalizeRepoRelative('src/../../escape')).toBeNull();
  });

  it('gives a MIXED set the highest-severity class present — one core file governs the set', () => {
    // This is the property that stops a fast lane from carrying compiled code along for the
    // ride: forty assets plus one .ts is a core change set, full stop.
    const mixed = [
      'src/pages/cockpit/js/a.js',
      'src/api/b.css',
      'src/features/swarm-orchestration/services/queue-manager-service.ts',
    ];
    expect(classifyChangeSet(mixed)).toBe('core');
    expect(isLiveAppliable(classifyChangeSet(mixed))).toBe(false);

    expect(classifyChangeSet(['src/pages/a.js', 'swarm-apps/x.yaml'])).toBe('manifest');
    expect(classifyChangeSet(['swarm-apps/x.yaml', 'docker-compose.oshal-local.yml'])).toBe('infra');
    // An empty set is core, not "nothing to do" — fail-closed.
    expect(classifyChangeSet([])).toBe('core');
  });

  it('permits exactly four classes on the live lane', () => {
    const live: ChangeClass[] = ['asset', 'manifest', 'persona', 'package'];
    for (const cls of live) expect(isLiveAppliable(cls), cls).toBe(true);
    for (const cls of ['core', 'infra'] as ChangeClass[]) expect(isLiveAppliable(cls), cls).toBe(false);
  });

  it('rejects any value outside the closed class set', () => {
    for (const bad of ['CORE', 'assets', 'ui', '', null, undefined, 7, {}]) {
      expect(isChangeClass(bad), String(bad)).toBe(false);
    }
    expect(isChangeClass('asset')).toBe(true);
  });
});

describe('Jarvis change-class hint — parsed fail-closed, never trusted as authority', () => {
  it('carries a valid changeClass through the handoff fence', () => {
    const { handoffs } = extractHandoffs(fence(
      '{"action":"create","platform":true,"changeClass":"asset","title":"Tweak the orb","description":"Nudge the orb 4px."}',
    ));
    expect(handoffs[0].platform).toBe(true);
    expect(handoffs[0].changeClass).toBe('asset');
  });

  it('DROPS an unrecognized class instead of passing it through', () => {
    // A hallucinated class must not reach a lane selector. Absent means "server, you classify".
    for (const bad of ['"ui"', '"CORE"', 'true', '42', 'null']) {
      const { handoffs } = extractHandoffs(fence(
        `{"action":"create","platform":true,"changeClass":${bad},"title":"T","description":"D"}`,
      ));
      expect(handoffs[0].changeClass, bad).toBeUndefined();
    }
  });

  it('leaves the existing platform contract untouched', () => {
    const { handoffs } = extractHandoffs(fence('{"action":"create","title":"T","description":"D"}'));
    expect(handoffs[0].platform).toBe(false);
    expect(handoffs[0].changeClass).toBeUndefined();
  });
});
