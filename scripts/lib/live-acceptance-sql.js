/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the closed set of SQL statements the automated live-acceptance cases may run, by name. A case never sends SQL text: it names one of these, and both bindings (the host runner's in-container helper and the Test Lab adapter) run it under the owner's own request identity, so row policies scope it exactly as they scope the owner's requests. Every statement takes the owner subject as $1 and its fixture key after it. Used only where a product exposes no delete route (the ADR-160 Floater record, a queue-created LinkedIn draft) and for residue/usage reads.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The three `lora.*` statements the LoRA gallery-import proof (scripts/operations/lora-import-live-proof.js) runs in both its modes: the fixture character's id, its deletion (the package has no character delete route; receipt, staged bytes and grants cascade) and the residue read. Its gallery mode runs on the host and reaches the database only through the container helper, which admits names from this set alone.
 */

'use strict';

/** The only statements a live-acceptance case may run. $1 is always the owner subject. */
const STATEMENTS = Object.freeze({
  // ADR-160 S4 Floater (aero-lab): the package has no delete route. Evaluations cascade.
  'aero-lab.floater-delete': `DELETE FROM aero_lab_vehicle
    WHERE owner_sub = $1 AND vehicle_id = $2::uuid AND kind = 'solar-dynastat' AND name = 'Floater'`,
  'aero-lab.floater-residue': `SELECT
    (SELECT count(*) FROM aero_lab_vehicle WHERE owner_sub = $1 AND vehicle_id = $2::uuid)::int AS vehicles,
    (SELECT count(*) FROM aero_lab_vehicle_evaluation WHERE owner_sub = $1 AND vehicle_id = $2::uuid)::int AS evaluations`,
  // LinkedIn queue: drafts are reject-only in the product (a rejected draft stays). The unique
  // (user_sub, source_ticket_id) index means one queue ticket owns at most one draft.
  'linkedin.draft-delete': 'DELETE FROM social_content_drafts WHERE user_sub = $1 AND source_ticket_id = $2',
  'linkedin.draft-residue': 'SELECT count(*)::int AS drafts FROM social_content_drafts WHERE user_sub = $1 AND source_ticket_id = $2',
  // Jarvis conversations: what one run can leave behind, by session id ($2 text[]).
  'jarvis.residue': `SELECT
    (SELECT count(*) FROM chat_tasks WHERE owner_sub = $1 AND task_id = ANY($2::text[]))::int AS chat_tasks,
    (SELECT count(*) FROM chat_messages WHERE task_id = ANY($2::text[]))::int AS chat_messages,
    (SELECT count(*) FROM tickets WHERE owner_sub = $1 AND ticket_type = 'chat'
        AND metadata->>'taskId' = ANY($2::text[]))::int AS chat_tickets,
    (SELECT count(*) FROM jarvis_tasks WHERE user_sub = $1 AND session_id = ANY($2::text[]))::int AS work_items`,
  // Jarvis spend per call since the run started ($2 agent id, $3 ISO start).
  'jarvis.cost-events': `SELECT task_id, provider_id, model_id, input_tokens, output_tokens, duration_ms, ts
    FROM oshal_cost_events WHERE owner_sub = $1 AND agent_id = $2 AND ts >= $3::timestamptz ORDER BY ts LIMIT 200`,
  // The per-task rollups the run's conversations touched ($2 ISO start, $3 LIKE prefix of the run tag).
  'jarvis.rollups': `SELECT task_id, total_input_tokens, total_output_tokens, usage_by_model FROM chat_tasks
    WHERE owner_sub = $1 AND updated_at >= $2::timestamptz AND task_id LIKE $3 ORDER BY task_id LIMIT 50`,
  // LoRA gallery import: the package has no character delete route; the receipt, staged bytes and
  // grants cascade from the fixture character ($2 its subject, $3 its id for the residue read).
  'lora.character-id': 'SELECT id FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2',
  'lora.character-delete': 'DELETE FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2',
  'lora.residue': `SELECT
    (SELECT count(*) FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2)::int AS characters,
    (SELECT count(*) FROM oshal_lora_dataset_images WHERE character_id = $3::uuid)::int AS receipts`,
});

/**
 * @description The SQL text for a named statement.
 * @param {unknown} name - The statement name a case asked for.
 * @returns {string} Its text.
 * @throws {Error} For any name outside the closed set.
 */
function statementText(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(STATEMENTS, name)) {
    throw new Error(`unknown live-acceptance statement: ${String(name).slice(0, 60)}`);
  }
  return STATEMENTS[name];
}

module.exports = { STATEMENTS, statementText };
