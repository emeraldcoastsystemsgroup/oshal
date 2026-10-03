/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the /api/swarm-execute app/capability/pattern boundary: valid trusted configuration reaches the envelope payload exactly, while malformed or oversized authority fails closed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The image-turn render instruction (SEC-05 carve for image turns, ADR-130 amendment 2026-10-02): `renderInstruction` reaches the envelope payload exactly beside the brief `text`, only with a literal `imageTurn: true`; without it, or with a non-boolean marker, the carrier is refused, and the empty, control-bearing and oversized shapes are rejected like `pattern`.
 */

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBotNodePromptCarrier } from '../../src/app/bot-node-request-scope';

function envelopePayloadFromHttpBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    text: body.text,
    ...parseBotNodePromptCarrier(body),
  };
}

describe('bot-node HTTP trusted prompt carrier', () => {
  it('forwards app, capability, and pattern from the HTTP body into the envelope payload exactly', () => {
    const pattern = '# STRUCTURE_NOTE\nReturn the server-declared JSON contract.';
    const payload = envelopePayloadFromHttpBody({
      text: '# RAW NOTES\nCalled the prospect.',
      app: 'intelligent-sales',
      capability: 'summarize',
      pattern,
    });

    expect(payload).toEqual({
      text: '# RAW NOTES\nCalled the prospect.',
      app: 'intelligent-sales',
      capability: 'summarize',
      pattern,
    });
  });

  it('accepts the app + trusted operation pattern shape without inventing a capability', () => {
    const pattern = '# INTELLIGENT SALES OPERATION: STRUCTURE_NOTE';
    expect(parseBotNodePromptCarrier({ app: 'intelligent-sales', pattern })).toEqual({
      app: 'intelligent-sales',
      pattern,
    });
  });

  it('keeps the validated carrier wired into the real /api/swarm-execute envelope', () => {
    const source = fs.readFileSync(new URL('../../src/app/bot-node-server.ts', import.meta.url), 'utf8');
    const routeStart = source.indexOf("app.post(\n    '/api/swarm-execute'");
    const routeEnd = source.indexOf("app.post('/api/token-chase/replay-call'", routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(route).toContain('promptCarrier = parseBotNodePromptCarrier(body)');
    expect(route).toContain('...promptCarrier,');
    expect(route.indexOf('...promptCarrier,')).toBeGreaterThan(route.indexOf('payload: {'));
  });

  it.each([
    [{ app: '../intelligent-sales' }, 'app'],
    [{ app: 'A'.repeat(65) }, 'app'],
    [{ capability: 'structure-note' }, 'capability'],
    [{ pattern: '' }, 'pattern'],
    [{ pattern: 'trusted\u0000override' }, 'pattern'],
    [{ pattern: 'x'.repeat(65_537) }, 'pattern'],
    [{ imageTurn: true, renderInstruction: '' }, 'renderInstruction'],
    [{ imageTurn: true, renderInstruction: 'trusted\u0000override' }, 'renderInstruction'],
    [{ imageTurn: true, renderInstruction: 'x'.repeat(65_537) }, 'renderInstruction'],
  ])('rejects malformed or oversized HTTP authority (%s)', (candidate, field) => {
    expect(() => parseBotNodePromptCarrier(candidate)).toThrow(`bot prompt carrier ${field} is invalid`);
  });

  it('carries the image-turn render instruction beside the brief, only with a literal imageTurn: true', () => {
    const instruction = 'You are a headless image-rendering task.\nCall your generate_image tool exactly once with these inputs: Prompt = the brief.';
    expect(envelopePayloadFromHttpBody({ text: 'make the circle blue', imageTurn: true, renderInstruction: instruction })).toEqual({
      text: 'make the circle blue',
      renderInstruction: instruction,
    });
    for (const body of [{ renderInstruction: instruction }, { imageTurn: 'true', renderInstruction: instruction }, { imageTurn: false, renderInstruction: instruction }]) {
      expect(() => parseBotNodePromptCarrier(body)).toThrow('bot prompt carrier renderInstruction requires an image turn');
    }
  });

  it('keeps the legacy request shape a no-op when no carrier fields are supplied', () => {
    expect(parseBotNodePromptCarrier({ text: 'hello' })).toEqual({});
  });
});
