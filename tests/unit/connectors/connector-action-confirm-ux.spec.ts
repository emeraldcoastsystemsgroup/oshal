/**
 * The 428 needs-confirmation UX — guards for the decision, not the markup.
 *
 * WHY THIS EXISTS: the risky-write confirm rail shipped 2026-07-15 and no surface ever rendered it,
 * so a "human approval gate" was something only a curl could satisfy. Now that a panel exists, the
 * two ways a UI silently voids such a gate are worth pinning, because both look fine on screen:
 *   1. sending `confirm` on the FIRST attempt (the refusal never happens, so nobody is ever asked);
 *   2. re-reading the form on approve instead of re-sending the params the refusal described (the
 *      person approves one thing and a different thing runs).
 * Both are properties of two pure functions, so they are guarded without a DOM.
 *
 * Also pinned: the marketplace entry actually carries the declared actions a surface needs to offer
 * the gate at all — `entry.actions` is resource-derived and does not include the `actions:` block.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — first-attempt-never-confirms, approve-resends-identical-params, 428-classified-as-needs-confirmation, and writeActions on the marketplace entry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — cockpit surfaces are plain ESM JavaScript, not part of the TS program.
import { buildActionRequestBody, decideAfterActionResponse } from '../../../src/pages/cockpit/js/views/ConnectorActionRunner.js';
import { ConnectorMarketplaceService } from '../../../src/app/connectors/runtime/marketplace';

describe('the confirm gate cannot be voided by the surface', () => {
  it('never sends the confirm flag on a first attempt', () => {
    expect(buildActionRequestBody({ a: 1 }, false)).toEqual({ params: { a: 1 } });
    expect(Object.keys(buildActionRequestBody({ a: 1 }, false))).not.toContain('confirm');
  });

  it('sends the IDENTICAL params on approval, plus confirm — never a re-derived payload', () => {
    const params = { author: 'urn:li:person:x', nested: { deep: [1, 2, 3] } };
    const first = buildActionRequestBody(params, false);
    const approved = buildActionRequestBody(params, true);
    expect(approved.confirm).toBe(true);
    expect(approved.params).toEqual(first.params);
    expect(approved.params).toBe(params);
  });
});

describe('a 428 is classified as "ask the human"', () => {
  it('turns 428 into needs-confirmation, never into a retry', () => {
    const decision = decideAfterActionResponse(428, { ok: false, error: 'confirmation required' });
    expect(decision.state).toBe('needs-confirmation');
  });

  it('reports success only on an ok 200', () => {
    expect(decideAfterActionResponse(200, { ok: true, data: { id: 'x' } }).state).toBe('done');
    expect(decideAfterActionResponse(200, { ok: false, error: 'nope' }).state).toBe('error');
  });

  it('distinguishes "you are not connected" from a failure, so the fix is obvious', () => {
    const decision = decideAfterActionResponse(401, { ok: false, code: 'not_connected', error: 'x' });
    expect(decision.state).toBe('not-connected');
    expect(decision.message).toMatch(/utilities/i);
  });

  it('surfaces the provider error rather than a generic failure', () => {
    expect(decideAfterActionResponse(502, { ok: false, error: 'LinkedIn said no' }).message).toContain('LinkedIn said no');
  });
});

describe('the marketplace entry carries what the gate needs', () => {
  it('publishes the DECLARED write actions with their risk and required params', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-runner-'));
    const specDir = path.join(root, 'connectors');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'acme.yaml'), [
      'provider: acme',
      'displayName: Acme',
      'baseUrl: https://api.acme.test',
      'auth: { type: apiKey, in: header, name: X-Key }',
      'resources:',
      '  - { name: list-things, tool: acme-list-things, method: GET, path: /things }',
      'actions:',
      '  - name: create-thing',
      '    method: POST',
      '    urlTemplate: /things',
      '    riskLevel: high',
      '    description: Make a thing.',
      '    paramsSchema: { type: object, required: [title], properties: { title: { type: string } } }',
      '  - name: touch-thing',
      '    method: PATCH',
      '    urlTemplate: /things/{id}',
      '    riskLevel: low',
      '    description: Nudge a thing.',
      '    paramsSchema: { type: object, properties: { id: { type: string } } }',
      'metadata:',
      '  category: "Productivity"',
      '  description: "Acme."',
    ].join('\n'));
    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath: path.join(root, 'state.json') });
      const entry = service.list().entries.find((e) => e.id === 'acme');
      expect(entry?.writeActions).toHaveLength(2);
      const create = entry?.writeActions.find((a) => a.name === 'create-thing');
      expect(create).toMatchObject({ method: 'POST', urlTemplate: '/things', riskLevel: 'high', requiresConfirmation: true });
      expect(create?.requiredParams).toEqual(['title']);
      // A low-risk action without approvalRequired does NOT claim the gate it will not get.
      expect(entry?.writeActions.find((a) => a.name === 'touch-thing')?.requiresConfirmation).toBe(false);
      // The resource-derived list is a different thing and must not be mistaken for this one.
      expect(entry?.actions.some((a) => (a as { resource?: string }).resource === 'create-thing')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a read-only connector with no write actions at all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-runner-ro-'));
    const specDir = path.join(root, 'connectors');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'ro.yaml'), [
      'provider: ro',
      'displayName: Read Only',
      'baseUrl: https://api.ro.test',
      'auth: { type: apiKey, in: header, name: X-Key }',
      'resources:',
      '  - { name: list-things, tool: ro-list-things, method: GET, path: /things }',
      'metadata:',
      '  category: "Productivity"',
      '  description: "Read only."',
    ].join('\n'));
    try {
      const service = new ConnectorMarketplaceService({ specDir, statePath: path.join(root, 'state.json') });
      expect(service.list().entries.find((e) => e.id === 'ro')?.writeActions).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
