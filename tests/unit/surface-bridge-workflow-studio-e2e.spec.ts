/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Activation guard for the chat↔surface bridge on its first adopter (workflow-studio): a realistic workflow-assistant reply (prose + a workflow-graph fence + an oshal:surface fence) is parsed IDENTICALLY by the server (extractSurfaceDirectives) and the chat-rail client (parseSurfaceOps/stripSurfaceFence); every emitted op is a member of the REAL swarm-apps/workflow-studio.yaml surface.ops allow-list AND passes the OutboundEventSchema contract; the workflow-graph block SURVIVES surface stripping (the two fences coexist); and the workflow-assistant persona actually declares the oshal:surface hook it is now trusted to emit. Guards the V3 persona activation against silent regression (a tightened manifest, a removed persona hook, or server/client parser drift would go red here).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the TALK-TO-BUILD-path guard (the workflow-studio panel, not the chat rail): the /api/workflow-studio/chat route's message-strip (stripBotFencesExceptSurface) removes the workflow-graph fence but PRESERVES the oshal:surface fence, the graph still parses for the canvas (parseGraphBlock), and the panel's self-mode producer posts every op to its OWN window (a to_surface envelope for workflow-studio) while the displayed bubble leaks NEITHER control fence. Guards the fix that the surface fence is no longer discarded server-side and no longer leaks client-side.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { extractSurfaceDirectives } from '../../src/app/routes/jarvis-directives';
import { parseGraphBlock, stripBotFencesExceptSurface } from '../../src/app/routes/workflow-studio-assist-routes';
import { OutboundEventSchema, SURFACE_BRIDGE_CHANNEL, SURFACE_BRIDGE_VERSION, normalizeSurfaceEvent } from '../../src/features/surface-bridge';
// The browser producer under test — plain ESM, imported directly (vitest transforms it; tsc excludes
// tests/, so the untyped .js import is vitest-only), mirroring surface-directives.spec.ts.
import { createSurfaceProducer, parseSurfaceOps, stripSurfaceFence } from '../../src/shared/ui/js/surface-bridge-producer.js';

const F = '```';

/** A realistic workflow-assistant reply: prose + the mandatory workflow-graph block + the optional
 *  oshal:surface block the V3 persona is now trusted to emit (notify + render_options + set_content). */
const REPLY = [
  'I drew a three-stage Partner Outreach workflow: draft → approval gate → deliver.',
  '',
  `${F}workflow-graph`,
  JSON.stringify({
    name: 'Partner Outreach',
    description: 'draft, gate, deliver',
    nodes: [
      { id: 'n-start', type: 'start', title: 'Start', config: { triggerMode: 'manual' } },
      { id: 'n-1', type: 'execute-agent', title: 'Draft', config: { agentBinding: 'content-studio' } },
      { id: 'n-gate', type: 'approval-gate', title: 'Approve' },
      { id: 'n-deliver', type: 'deliver', title: 'Deliver', config: { deliveryMode: 'standard' } },
    ],
    edges: [
      { id: 'e0', source: 'n-start', target: 'n-1' },
      { id: 'e1', source: 'n-1', target: 'n-gate' },
      { id: 'e2', source: 'n-gate', target: 'n-deliver' },
    ],
  }),
  F,
  '',
  `${F}oshal:surface`,
  JSON.stringify({
    ops: [
      { op: 'notify', level: 'success', text: 'Drew Partner Outreach — 3 stages.' },
      { op: 'render_options', prompt: 'What next?', options: [
        { id: 'add-parallel', label: 'Run drafts in parallel' },
        { id: 'tighten-gate', label: 'Require two approvers' },
        { id: 'publish', label: 'Publish this workflow' },
      ] },
      { op: 'set_content', region: 'summary', content: '4 nodes · 3 edges · terminal: deliver' },
    ],
  }),
  F,
].join('\n');

/** The manifest surface.ops allow-list the cockpit relay enforces for workflow-studio. */
function workflowStudioAllowList(): string[] {
  const manifest = loadYaml(
    readFileSync(resolve(process.cwd(), 'swarm-apps/workflow-studio.yaml'), 'utf8'),
  ) as { surface?: { ops?: string[] } };
  return manifest.surface?.ops ?? [];
}

describe('chat↔surface bridge — workflow-studio activation (end-to-end contract)', () => {
  it('server and client extract the SAME ops and strip the SAME fence from one realistic reply', () => {
    const server = extractSurfaceDirectives(REPLY);
    const clientOps = parseSurfaceOps(REPLY).map((o) => o.op as string);
    const serverOps = server.ops.map((o) => o.op);

    expect(serverOps).toEqual(['notify', 'render_options', 'set_content']);
    expect(clientOps).toEqual(serverOps);
    expect(server.hadSurfaceFence).toBe(true);

    // Both strippers remove ONLY the oshal:surface fence — the workflow-graph block survives so the
    // studio surface still receives the graph it renders. The prose survives too.
    expect(server.cleanAnswer).toContain('workflow-graph');
    expect(server.cleanAnswer).not.toContain('oshal:surface');
    expect(server.cleanAnswer).toContain('Partner Outreach workflow');
    expect(stripSurfaceFence(REPLY)).toBe(server.cleanAnswer);
  });

  it('every emitted op is on the REAL workflow-studio surface.ops allow-list', () => {
    const allow = new Set(workflowStudioAllowList());
    // The manifest must actually permit the outbound ops the persona is told to emit — a tightened
    // manifest that dropped one would silently kill that affordance; catch it here, not in the browser.
    for (const op of ['notify', 'render_options', 'set_content', 'propose']) {
      expect(allow.has(op)).toBe(true);
    }
    for (const op of extractSurfaceDirectives(REPLY).ops) {
      expect(allow.has(op.op)).toBe(true);
    }
  });

  it('each validated op passes the OutboundEventSchema once the rail stamps channel/v/app', () => {
    for (const op of extractSurfaceDirectives(REPLY).ops) {
      const stamped = { ...op, channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: 'workflow-studio' };
      expect(OutboundEventSchema.safeParse(stamped).success).toBe(true);
    }
  });

  it('the workflow-assistant persona declares the oshal:surface hook it is trusted to emit', () => {
    const persona = readFileSync(resolve(process.cwd(), 'ai-lab/bot-personas/workflow-assistant.yaml'), 'utf8');
    // The activation is real only if the persona actually instructs the bot to emit the fence with
    // the allow-listed op names. If someone removes the hook, this guard goes red (guard-per-fix).
    expect(persona).toContain('oshal:surface');
    for (const op of ['notify', 'render_options', 'set_content', 'propose']) {
      expect(persona).toContain(`"op":"${op}"`);
    }
    // …and it must stay ADDITIVE to (never a replacement for) the mandatory workflow-graph contract.
    expect(persona).toContain('in ADDITION to (never instead of) the mandatory');
    expect(persona.replace(/\s+/g, ' ')).toContain('EXACTLY ONE fenced code block tagged');
  });
});

describe('chat↔surface bridge — talk-to-build path fires the dock and leaks no fence', () => {
  const ORIGIN = 'https://oshal.test';

  /** The exact `message` the POST /api/workflow-studio/chat route now hands the talk-to-build client. */
  function serverMessage(): string {
    return stripBotFencesExceptSurface(REPLY);
  }

  it('the route strips the workflow-graph fence for the canvas but PRESERVES the surface fence for the client', () => {
    // The graph is still extracted server-side (drives the canvas) — unchanged behaviour.
    const graph = parseGraphBlock(REPLY);
    expect(graph?.nodes).toHaveLength(4);

    // The returned message drops the graph JSON (and any code block) but keeps the oshal:surface fence:
    // the CLIENT consumes it (the shell relay refuses a to_surface from a non-chat-rail frame, so the
    // panel drives its own dock — a server strip would silently discard the ops, which was the bug).
    const message = serverMessage();
    expect(message).toContain('oshal:surface');
    expect(message).not.toContain('workflow-graph');
    expect(message).not.toContain('"nodes"'); // the graph JSON is gone from the bubble text
    expect(message).toContain('Partner Outreach workflow');
  });

  it('the panel producer (postTarget:self) posts every op to its OWN window and shows fence-free text', () => {
    const posts: Array<Record<string, unknown>> = [];
    const win: { location: { origin: string; search: string }; postMessage: (m: Record<string, unknown>) => void; parent?: unknown } = {
      location: { origin: ORIGIN, search: '' },
      postMessage: (m) => posts.push(m),
    };
    // The talk-to-build panel is co-resident with the surface-bridge-client in the SAME iframe, so the
    // envelope is posted to THIS window (self), and the app is EXPLICIT (a surface knows its identity).
    win.parent = win;
    const producer = createSurfaceProducer({ win, postTarget: 'self', app: 'workflow-studio' });

    const shown = producer.relayReply(serverMessage());

    // (a) every declared op fired at the dock — posted to this window, stamped as a valid to_surface
    //     envelope for workflow-studio (the surface-bridge-client renders these).
    expect(posts.map((p) => p.op)).toEqual(['notify', 'render_options', 'set_content']);
    for (const env of posts) {
      expect(env).toMatchObject({ channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: 'workflow-studio' });
      const normalized = normalizeSurfaceEvent(env);
      expect(normalized.ok).toBe(true);
      if (normalized.ok) {
        expect(normalized.direction).toBe('to_surface');
      }
    }

    // (b) the displayed bubble leaks NEITHER control fence — the graph fence was stripped server-side,
    //     the surface fence is stripped here after relaying.
    expect(shown).not.toContain('oshal:surface');
    expect(shown).not.toContain('workflow-graph');
    expect(shown).toContain('Partner Outreach');
  });

  it('a plain clarifying-question reply (no fences) passes through untouched — no ops, no leak', () => {
    const question = 'Which specialist should draft the RCA — database or infra?';
    expect(stripBotFencesExceptSurface(question)).toBe(question);

    const posts: Array<Record<string, unknown>> = [];
    const win: { location: { origin: string; search: string }; postMessage: (m: Record<string, unknown>) => void; parent?: unknown } = {
      location: { origin: ORIGIN, search: '' },
      postMessage: (m) => posts.push(m),
    };
    win.parent = win;
    const producer = createSurfaceProducer({ win, postTarget: 'self', app: 'workflow-studio' });
    expect(producer.relayReply(question)).toBe(question);
    expect(posts).toHaveLength(0);
  });
});
