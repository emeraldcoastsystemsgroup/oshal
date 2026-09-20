/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-16 item 2. The agent-factory bot's seeded systemPrompt asserted a five-value persona-layer vocabulary, one of whose values has never existed - persona_layers.layer_type carries a CHECK constraint naming a different six. The operator chose "correct the seed AND add a forward migration", so the assertion has to be about APPLIED PROMPT TEXT rather than about a file: a seed-only fix leaves every existing database, including the box, still asserting the false fact. These cases run the REAL migrations 010 and 149 as shipped against a disposable postgres and read the row back, so deleting 149 turns them red while the seed alone stays green. The hand-edit case is the one that pins the shape of the migration rather than its effect: it rewrites the phrase, not the prompt, so an operator edit around the phrase survives it - a whole-systemPrompt replacement would pass every other case here and silently discard that edit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/**
 * The false phrase, assembled rather than written out, for the same reason migration 010's own
 * Change Log paraphrases it: the done-when for this entry is a grep of the seed file returning
 * zero, and a spec that spells the phrase out is a file this repo's own criteria would then count.
 */
const FALSE_PHRASE = ['platform', 'organization', 'role', 'task', 'session'].join(', ') + ' layers';

/** The real vocabulary, from the CHECK constraint on persona_layers.layer_type. */
const LAYER_TYPES = ['platform', 'host', 'tenant', 'role', 'session', 'task'];

const MIGRATIONS = join(process.cwd(), 'scripts', 'migrations');
const AGENT_FACTORY = 'a0000000-0000-0000-0000-000000000007';

const fixture = new DisposablePostgres({
  purpose: 'agent-factory-vocabulary',
  migrations: [
    '001-multi-agent-foundation.sql',
    '008-seed-swarm-agents.sql',
    '009-persona-layers.sql',
    '010-seed-agent-factory-bot.sql',
    '149-agent-factory-persona-layer-vocabulary.sql',
  ],
});

let pool: Pool;

beforeAll(async () => { pool = await fixture.start(); }, 180_000);
afterAll(async () => { await fixture.stop(); }, 120_000);

/** The agent-factory bot's system prompt, as the database actually holds it. */
async function appliedPrompt(): Promise<string> {
  const { rows } = await pool.query<{ prompt: string }>(
    `SELECT persona ->> 'systemPrompt' AS prompt FROM agents WHERE name = 'agent-factory'`,
  );
  expect(rows, 'the agent-factory row is missing — the migrations did not run').toHaveLength(1);
  return rows[0].prompt;
}

describe('the agent-factory bot is not told a persona-layer vocabulary that does not exist', () => {
  it('the CHECK constraint really is the six-value union this spec compares against', async () => {
    // Self-validation first. Every assertion below is about a phrase agreeing with the schema, so
    // a spec that got the schema wrong would be confidently wrong in both directions.
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'persona_layers' AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%layer_type%'`,
    );
    expect(rows.length, 'no layer_type CHECK constraint found — the premise is gone').toBe(1);
    for (const layerType of LAYER_TYPES) expect(rows[0].def).toContain(`'${layerType}'`);
    expect(rows[0].def, 'the invented layer type is in the schema after all').not.toContain("'organization'");
  });

  it('the APPLIED prompt does not carry the false phrase — which a seed-only fix cannot achieve', async () => {
    expect(await appliedPrompt()).not.toContain(FALSE_PHRASE);
  });

  it('the applied prompt names the real six-value union', async () => {
    const prompt = await appliedPrompt();
    const sentence = prompt.split('\n').find((line) => line.includes('persona_layers') && line.includes('composition'));
    expect(sentence, 'the persona-composition line is gone entirely, not corrected').toBeDefined();
    for (const layerType of LAYER_TYPES) expect(sentence).toContain(layerType);
  });

  it('corrects a database that already ran the historical migration 010', async () => {
    // The whole reason a forward migration was chosen over editing the seed: on this box, and on
    // every other deployment, 010 is applied history and its file is never read again. This case
    // reconstructs that state and runs 149 against it.
    const forward = readFileSync(join(MIGRATIONS, '149-agent-factory-persona-layer-vocabulary.sql'), 'utf8');
    const stale = `Persona composition uses the \`persona_layers\` table — ${FALSE_PHRASE} (priority 10-50)`;
    await pool.query(
      `UPDATE agents SET persona = jsonb_set(persona, '{systemPrompt}', to_jsonb($1::text)) WHERE agent_id = $2`,
      [`before\n${stale}\nafter`, AGENT_FACTORY],
    );
    expect(await appliedPrompt()).toContain(FALSE_PHRASE);   // the state we are correcting

    await pool.query(forward);

    const corrected = await appliedPrompt();
    expect(corrected).not.toContain(FALSE_PHRASE);
    for (const layerType of LAYER_TYPES) expect(corrected).toContain(layerType);
    expect(corrected.startsWith('before\n'), 'the surrounding prompt was replaced, not the phrase').toBe(true);
    expect(corrected.endsWith('\nafter'), 'the surrounding prompt was replaced, not the phrase').toBe(true);
  });

  it('is idempotent, and does not clobber an operator edit made around the phrase', async () => {
    const forward = readFileSync(join(MIGRATIONS, '149-agent-factory-persona-layer-vocabulary.sql'), 'utf8');
    const handEdited = `## OPERATOR NOTE: do not remove this line.\nPersona composition uses `
      + `\`persona_layers\` — ${FALSE_PHRASE} (priority 10-50)\n## END OPERATOR NOTE`;
    await pool.query(
      `UPDATE agents SET persona = jsonb_set(persona, '{systemPrompt}', to_jsonb($1::text)) WHERE agent_id = $2`,
      [handEdited, AGENT_FACTORY],
    );

    await pool.query(forward);
    const first = await appliedPrompt();
    expect(first).toContain('## OPERATOR NOTE: do not remove this line.');
    expect(first).toContain('## END OPERATOR NOTE');
    expect(first).not.toContain(FALSE_PHRASE);

    // Second run: nothing matches any more, so nothing is rewritten.
    const second = await pool.query(forward);
    expect(await appliedPrompt()).toBe(first);
    expect(second.rowCount ?? 0, 'a re-run rewrote a row it had already corrected').toBe(0);
  });

  it('the seed file itself is corrected too, so a FRESH install never carries it', () => {
    // Done-when (1). The two halves are separate claims: this one is about a new database, the
    // cases above are about every existing one.
    const seed = readFileSync(join(MIGRATIONS, '010-seed-agent-factory-bot.sql'), 'utf8');
    expect(seed).not.toContain(FALSE_PHRASE);
    for (const layerType of LAYER_TYPES) expect(seed).toContain(layerType);
  });
});
