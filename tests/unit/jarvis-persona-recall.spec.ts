/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Jarvis deferral the operator commissioned away (2026-09-22): asked about something from a DIFFERENT thread, Jarvis told the user to go to the app. The persona said the only tool it used directly was reading OPEN WORK and that a catalog question it held no data for should be handed off or linked, so even with the recall tools declared it had no instruction to reach for them. Pins, over the parsed persona: the recall rule names the two runtime tool names (imported, so a rename reddens here), it runs BEFORE the catalog deferral, the direct-tool carve-out names both lookups, the list-then-one-fetch discipline and the empty/withheld semantics are stated, and allowed_tools stays empty so a persona re-seed never narrows the live grant.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  BOT_NODE_CONVERSATION_FETCH_TOOL,
  BOT_NODE_CONVERSATION_QUERY_TOOL,
} from '@/app/bot-node-read-only-tools';

interface PersonaDoc {
  agent_id: string;
  perspective: string;
  allowed_tools: unknown;
}

const PERSONA_PATH = path.join(__dirname, '..', '..', 'ai-lab', 'bot-personas', 'oshal-assistant.yaml');
const persona = yaml.load(fs.readFileSync(PERSONA_PATH, 'utf8')) as PersonaDoc;
const perspective = persona.perspective;

/**
 * @description The paragraph of the perspective that contains a marker phrase.
 * @param marker - Phrase unique to the paragraph.
 * @returns The blank-line-delimited paragraph, flattened to single spaces.
 */
function paragraphWith(marker: string): string {
  const paragraph = perspective.split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' '))
    .find((block) => block.includes(marker));
  if (!paragraph) throw new Error(`no persona paragraph contains ${JSON.stringify(marker)}`);
  return paragraph;
}

/**
 * @description The section of the perspective under one `## ` heading.
 * @param heading - Text the heading line starts with.
 * @returns The section body up to the next heading, flattened to single spaces.
 */
function section(heading: string): string {
  const start = perspective.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`no persona section headed ${JSON.stringify(heading)}`);
  const next = perspective.indexOf('\n  ## ', start + 3);
  return perspective.slice(start, next < 0 ? undefined : next).replace(/\s+/g, ' ');
}

describe('Jarvis persona: recall across the user\'s own threads before deferring', () => {
  it('is the Jarvis persona and keeps allowed_tools empty so a re-seed never narrows the live grant', () => {
    expect(persona.agent_id).toBe('a0000000-0000-0000-0000-000000000050');
    expect(persona.allowed_tools).toEqual([]);
  });

  it('carries a recall section naming both runtime tools by their exact names', () => {
    const recall = section('Your own earlier conversations and tasks');
    expect(recall).toContain(`\`${BOT_NODE_CONVERSATION_QUERY_TOOL}\``);
    expect(recall).toContain(`\`${BOT_NODE_CONVERSATION_FETCH_TOOL}\``);
    expect(recall, 'the rule must be to TRY before deferring, not an optional hint').toMatch(/ALWAYS try before/);
  });

  it('states the list-then-ONE-fetch discipline and what empty and withheld mean', () => {
    const recall = section('Your own earlier conversations and tasks');
    expect(recall).toMatch(/Pick the ONE best match/);
    expect(recall).toMatch(/Never fetch every hit/);
    expect(recall).toMatch(/empty result means the record holds nothing matching, not that it never came up/);
    expect(recall).toContain('withheld: "protected_result"');
    expect(recall).toMatch(/OWN record only, never anyone else's/);
  });

  it('puts recall into the per-turn rule and forbids batching it as a handoff', () => {
    const step = paragraphWith('RECALL BEFORE YOU DEFER');
    expect(step).toContain(BOT_NODE_CONVERSATION_QUERY_TOOL);
    expect(step).toMatch(/never batch them as a handoff/);
    // The step must come before the answer-now/batch rules it overrides.
    expect(perspective.indexOf('RECALL BEFORE YOU DEFER')).toBeLessThan(perspective.indexOf('BATCH AS A TASK'));
  });

  it('carves both lookups out of the tools-you-run-directly rule', () => {
    expect(perspective).not.toMatch(/The only "tool" you use directly is reading your OPEN WORK/);
    const direct = paragraphWith('The only tools you use directly');
    expect(direct).toContain(BOT_NODE_CONVERSATION_QUERY_TOOL);
    expect(direct).toContain(BOT_NODE_CONVERSATION_FETCH_TOOL);
  });

  it('makes the catalog deferral apply only after recall comes back empty', () => {
    const catalog = paragraphWith('say which app owns it');
    const recallAt = catalog.indexOf(BOT_NODE_CONVERSATION_QUERY_TOOL);
    expect(recallAt, 'the catalog deferral paragraph no longer mentions recall').toBeGreaterThanOrEqual(0);
    expect(recallAt).toBeLessThan(catalog.indexOf('say which app owns it'));
    expect(catalog).toMatch(/only when recall comes back empty/);
  });

  it('sends a task missing from OPEN WORK to recall instead of "I don\'t have it"', () => {
    const openWork = paragraphWith('A task that is not in OPEN WORK is still on record');
    expect(openWork).toContain(BOT_NODE_CONVERSATION_QUERY_TOOL);
    expect(openWork).toContain(BOT_NODE_CONVERSATION_FETCH_TOOL);
  });
});
