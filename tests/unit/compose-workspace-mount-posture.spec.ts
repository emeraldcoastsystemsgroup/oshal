/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-20 / R3.3 done-when (1) and (3). Every container that runs bot work mounts the SAME workspace volume read-write with no subpath, so every ticket's and every owner's working directory is a sibling of every other. ADR-060 already records that a directory layout on a shared read-write mount is attribution, not enforcement. Nothing here CHANGES that - the option is the operator's to choose (ADR-060 lists three, this repo's entry adds a fourth) - but an unmeasured property is one nobody notices changing, so the posture is pinned: the counts, the :rw, the absence of a subpath, and the exact mounting set. Asserted against the RESOLVED compose, because the mounts arrive through a `<<:` merge and a regex cannot tell an anchor from a service block. The second half pins why persona YAML does not help: runtimeToolMatchesCapabilities short-circuits for CORE_RUNTIME_TOOL_NAMES, and execute_command is in it - a reader who assumes capabilities gate the shell is repeating a belief this entry exists to correct.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve the compose through loadComposeYaml (@/shared/config). The bare js-yaml load failed on the library's default merge-key limit once #869 took docker-compose.oshal-local.yml past 10000 units; the shared loader carries the repository's explicit budget and still resolves every `<<:` merge.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | futures-research-worker (30097d55, 2026-09-25) joined the shared read-write workspace without a CKR-20 review, turning the 39/40 count pin red for nine days. Reviewed 2026-10-04 under the operator's delegation: it does not trip reversal trigger 2 (core image and runtime, package supplies persona YAML only, reason-only tool-less dispatch, profile-gated off by default). The count pin becomes a NAME pin (REVIEWED_WORKSPACE_BOTS) so the next bot to join names itself in the failure and must be reviewed rather than re-counted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadComposeYaml } from '@/shared/config';
import { HARNESS_NATIVE_TOOL_NAMES } from '@/shared/tools/embedded-tool-tier';

const COMPOSE = join(process.cwd(), 'docker-compose.oshal-local.yml');
const WORKSPACE_VOLUME = 'oshal_workspace';

type Service = { environment?: Record<string, unknown>; volumes?: unknown[] };

/** The merge key is resolved by the PARSER — this is what each container actually receives. */
function services(): Record<string, Service> {
  const doc = loadComposeYaml(readFileSync(COMPOSE, 'utf8')) as { services?: Record<string, Service> };
  return doc.services ?? {};
}

function workspaceMounts(): Array<{ service: string; spec: string; subpath: unknown }> {
  const out: Array<{ service: string; spec: string; subpath: unknown }> = [];
  for (const [service, svc] of Object.entries(services())) {
    for (const volume of svc?.volumes ?? []) {
      const spec = typeof volume === 'string' ? volume : JSON.stringify(volume);
      if (!spec.includes(WORKSPACE_VOLUME)) continue;
      const subpath = typeof volume === 'object' && volume
        ? (volume as { volume?: { subpath?: unknown } }).volume?.subpath
        : undefined;
      out.push({ service, spec, subpath });
    }
  }
  return out;
}

describe('the shared workspace mount posture is measured, not assumed', () => {
  it('every container that mounts the workspace mounts it READ-WRITE with no subpath', () => {
    // This is the property ADR-060 item 3 says has to change before a directory layout means
    // anything. Recorded here so that if it ever DOES change, the change is visible in a diff
    // rather than discovered by someone looking for it again.
    const mounts = workspaceMounts();
    expect(mounts.length, 'no workspace mounts found — the parse or the volume name changed')
      .toBeGreaterThan(30);

    const notReadWrite = mounts.filter((m) => !/:rw$/.test(m.spec)).map((m) => m.service);
    const withSubpath = mounts.filter((m) => m.subpath !== undefined).map((m) => m.service);

    expect(notReadWrite, 'a mount is no longer :rw — update this pin deliberately').toEqual([]);
    expect(withSubpath, 'a subpath mount appeared — that is ADR-060 item 3 landing; record it').toEqual([]);
  });

  it('the mounting set is exactly the bot-anchor inheritors plus code-server', () => {
    // 40 inheritors + code-server = 41. oshal-api is itself an inheritor, so the invariant is
    // inheritors + 1, not + 2 — which is the arithmetic a reader is most likely to get wrong.
    const all = services();
    const inheritors = Object.entries(all)
      .filter(([, svc]) => svc?.environment?.BOT_RUNTIME !== undefined)
      .map(([name]) => name)
      .sort();
    const mounting = [...new Set(workspaceMounts().map((m) => m.service))].sort();

    expect(inheritors, 'a bot joined or left the shared read-write workspace — review it under CKR-20 '
      + '(does it run a store package\'s bot with a tool surface? that is reversal trigger 2), record the '
      + 'decision in this file\'s change log, then update REVIEWED_WORKSPACE_BOTS').toEqual(REVIEWED_WORKSPACE_BOTS);
    expect(mounting, 'a service mounts the shared workspace that is neither a bot nor code-server')
      .toEqual([...inheritors, 'code-server'].sort());
  });
});

/**
 * Every bot service that receives the shared read-write workspace, by NAME. A bare count let
 * futures-research-worker join unreviewed (30097d55, 2026-09-25) and only surfaced as "39 became
 * 40"; a name list makes the next arrival identify itself and forces the CKR-20 review below.
 * Reviewed 2026-10-04: futures-research-worker does NOT trip CKR-20 reversal trigger 2. It runs the
 * core oshal-bot image and core runtime code; its package supplies only persona YAML; its dispatch is
 * reason-only and tool-less (no shell, so the cross-ticket traversal CKR-20 is about is unreachable
 * from it); and it is profile-gated off until the package is installed. A package bot WITH a tool
 * surface would trip the trigger.
 */
const REVIEWED_WORKSPACE_BOTS = [
  'career-bot', 'cloud-ops-bot', 'code-developer', 'code-reviewer', 'deck-builder-bot', 'devops-bot',
  'documentation-writer', 'eats-bot', 'email-bot', 'facebook-bot', 'finance-bot', 'futures-research-worker',
  'general-bot', 'home-bot', 'identity-bot', 'incident-remediation-bot', 'incident-response-bot', 'jarvis-bot',
  'movies-bot', 'oshal-api', 'oshal-developer', 'oshal-task-manager', 'queue-bot', 'rca-specialist',
  'research-bot', 'rides-bot', 'sales-bot', 'security-analyst', 'self-healing-bot', 'shopping-bot',
  'social-writer-bot', 'spotify-bot', 'storage-bot', 'system-architect', 'test-engineer', 'tester-bot',
  'trading-bot', 'travel-bot', 'weather-bot', 'workflow-assistant',
] as const;

describe('persona capabilities do not gate the shell tool', () => {
  it('execute_command is a core runtime tool, so capability matching never sees it', async () => {
    // The false belief this pins against: that a persona's declared capabilities decide whether a
    // bot can run a shell command. runtimeToolMatchesCapabilities short-circuits to true for
    // anything in CORE_RUNTIME_TOOL_NAMES, and execute_command is in that set — so whatever the
    // YAML says, the tool is reachable. That is why the mount posture above is the real boundary.
    expect(HARNESS_NATIVE_TOOL_NAMES, 'execute_command left the harness-native set — re-check the claim')
      .toContain('execute_command');

    const source = readFileSync(
      join(process.cwd(), 'src/features/llm-provider/services/tool-capability-scope.ts'),
      'utf8',
    );
    // The short-circuit itself: a return true for the core set BEFORE any tag/capability work.
    const fn = source.slice(source.indexOf('function runtimeToolMatchesCapabilities'));
    const shortCircuit = fn.indexOf('CORE_RUNTIME_TOOL_NAMES.has(name)');
    const firstTagWork = fn.indexOf('identifierTags(');

    expect(shortCircuit, 'the core-runtime short-circuit is gone from runtimeToolMatchesCapabilities')
      .toBeGreaterThan(-1);
    expect(firstTagWork, 'capability tag matching is gone — this pin needs rewriting').toBeGreaterThan(-1);
    expect(shortCircuit, 'capability matching now runs BEFORE the core-runtime short-circuit — if that '
      + 'is deliberate, persona capabilities DO gate the shell now and CKR-20 should say so')
      .toBeLessThan(firstTagWork);
  });
});
