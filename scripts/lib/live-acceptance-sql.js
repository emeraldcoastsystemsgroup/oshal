/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the closed set of SQL statements the automated live-acceptance cases may run, by name. A case never sends SQL text: it names one of these, and both bindings (the host runner's in-container helper and the Test Lab adapter) run it under the owner's own request identity, so row policies scope it exactly as they scope the owner's requests. Every statement takes the owner subject as $1 and its fixture key after it. Used only where a product exposes no delete route (the ADR-160 Floater record, a queue-created LinkedIn draft) and for residue/usage reads.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Three vids statements for the vids-publish case: insert one tagged finished job for the owner (the package makes a job 'done' only when a registered Vids worker settles it, so no route can produce one), delete exactly that job (owner, id, tag and status), and the residue read (job, export row, publication and the export's artifact id for the file probe).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The three `lora.*` statements the LoRA gallery-import proof (scripts/operations/lora-import-live-proof.js) runs in both its modes: the fixture character's id, its deletion (the package has no character delete route; receipt, staged bytes and grants cascade) and the residue read. Its gallery mode runs on the host and reaches the database only through the container helper, which admits names from this set alone.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Five `tickets-in-tickets.*` statements for the build-lane case: the run's tree, its status history, its work items, one leftover delete (work items, the swarm runs they reference, governance, DLQ and escalation rows: the tables without row-level security), and a residue count by exact id. Every one but the residue count is anchored to one root owned by the caller and titled with the case's run tag.
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
  // vids (store) publication: a job is created only by dispatching it to a registered Vids worker and
  // becomes 'done' only when that worker settles it, and the package has no job delete route. The
  // case inserts one finished job for the owner whose idea is its fixture tag ($2), never a second one
  // for the same tag; nothing dispatches it. Delete is bound to owner, id, tag and status, and the
  // export row cascades (its file is removed first through the package's own DELETE route).
  'vids.done-job-insert': `INSERT INTO vids_jobs (user_sub, status, idea, outcome)
    SELECT $1::text, 'done', $2::text, jsonb_build_object('liveAcceptance', true)
    WHERE NOT EXISTS (SELECT 1 FROM vids_jobs WHERE user_sub = $1 AND idea = $2)
    RETURNING job_id::text AS job_id`,
  'vids.job-delete': `DELETE FROM vids_jobs
    WHERE user_sub = $1 AND job_id = $2::uuid AND idea = $3 AND status = 'done'`,
  'vids.residue': `SELECT
    (SELECT count(*) FROM vids_jobs WHERE user_sub = $1 AND job_id = $2::uuid)::int AS jobs,
    (SELECT count(*) FROM vids_artifacts WHERE owner_sub = $1 AND job_id = $2::uuid)::int AS exports,
    (SELECT count(*) FROM vids_artifacts WHERE owner_sub = $1 AND job_id = $2::uuid AND public_token IS NOT NULL)::int AS published,
    (SELECT artifact_id::text FROM vids_artifacts WHERE owner_sub = $1 AND job_id = $2::uuid) AS artifact_id`,
  // LoRA gallery import: the package has no character delete route; the receipt, staged bytes and
  // grants cascade from the fixture character ($2 its subject, $3 its id for the residue read).
  'lora.character-id': 'SELECT id FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2',
  'lora.character-delete': 'DELETE FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2',
  'lora.residue': `SELECT
    (SELECT count(*) FROM oshal_lora_characters WHERE owner_sub = $1 AND subject = $2)::int AS characters,
    (SELECT count(*) FROM oshal_lora_dataset_images WHERE character_id = $3::uuid)::int AS receipts`,
  // Tickets in tickets (build lane): every read and delete is anchored to ONE root, owned by the
  // caller ($1) and titled with this case's run tag; children are that root's own children.
  // work_items, swarm_runs, ticket_governance, oshal_queue_dlq and swarm_escalations carry no
  // row-level security, which is why the anchor goes through the RLS-scoped tickets table.
  'tickets-in-tickets.tree': `SELECT t.ticket_id::text AS ticket_id, t.parent_ticket_id::text AS parent_ticket_id, t.title, t.status,
      t.ticket_type, t.owner_sub, t.metadata, t.created_at
    FROM tickets t
    WHERE t.owner_sub = $1 AND (t.ticket_id = $2::uuid OR t.parent_ticket_id = $2::uuid)
      AND EXISTS (SELECT 1 FROM tickets r WHERE r.ticket_id = $2::uuid AND r.owner_sub = $1
        AND r.title LIKE 'testlab-live-tickets-in-tickets-%')
    ORDER BY t.created_at`,
  // A root whose filing reply was lost: the exact title only one run mints, owned by the caller.
  'tickets-in-tickets.find-root': `SELECT t.ticket_id::text AS ticket_id FROM tickets t
    WHERE t.owner_sub = $1 AND t.title = $2 AND t.title LIKE 'testlab-live-tickets-in-tickets-%' AND t.parent_ticket_id IS NULL`,
  'tickets-in-tickets.history': `SELECT h.ticket_id::text AS ticket_id, h.from_status, h.to_status, h.metadata->>'reason' AS reason,
      h.metadata->>'message' AS message, h.created_at
    FROM ticket_status_history h JOIN tickets t ON t.ticket_id = h.ticket_id
    WHERE t.owner_sub = $1 AND (t.ticket_id = $2::uuid OR t.parent_ticket_id = $2::uuid)
      AND EXISTS (SELECT 1 FROM tickets r WHERE r.ticket_id = $2::uuid AND r.owner_sub = $1
        AND r.title LIKE 'testlab-live-tickets-in-tickets-%')
    ORDER BY h.created_at`,
  'tickets-in-tickets.work-items': `WITH tree AS (
      SELECT t.ticket_id::text AS id FROM tickets t
      WHERE t.owner_sub = $1 AND (t.ticket_id = $2::uuid OR t.parent_ticket_id = $2::uuid)
        AND EXISTS (SELECT 1 FROM tickets r WHERE r.ticket_id = $2::uuid AND r.owner_sub = $1
          AND r.title LIKE 'testlab-live-tickets-in-tickets-%'))
    SELECT w.external_id, w.unit_id, w.status, w.assigned_agent_id, w.execution_output->>'provider' AS provider,
      w.execution_output->>'model' AS model, w.updated_at
    FROM work_items w
    WHERE w.external_id IN (SELECT id FROM tree)
      OR w.external_id IN (SELECT 'verify:' || id FROM tree)
      OR w.external_id LIKE ANY (SELECT 'review:' || id || ':%' FROM tree)
    ORDER BY w.created_at`,
  'tickets-in-tickets.delete-leftovers': `WITH tree AS (
      SELECT t.ticket_id::text AS id FROM tickets t
      WHERE t.owner_sub = $1 AND (t.ticket_id = $2::uuid OR t.parent_ticket_id = $2::uuid)
        AND EXISTS (SELECT 1 FROM tickets r WHERE r.ticket_id = $2::uuid AND r.owner_sub = $1
          AND r.title LIKE 'testlab-live-tickets-in-tickets-%')),
    items AS (DELETE FROM work_items w
      WHERE w.external_id IN (SELECT id FROM tree)
        OR w.external_id IN (SELECT 'verify:' || id FROM tree)
        OR w.external_id LIKE ANY (SELECT 'review:' || id || ':%' FROM tree)
      RETURNING w.swarm_run_id),
    runs AS (DELETE FROM swarm_runs r WHERE r.run_id IN (SELECT swarm_run_id FROM items)
      OR (jsonb_typeof(r.processed) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.processed) e
        WHERE e->>'externalId' IN (SELECT id FROM tree))) RETURNING run_id),
    governance AS (DELETE FROM ticket_governance WHERE ticket_id IN (SELECT id FROM tree) RETURNING ticket_id),
    dlq AS (DELETE FROM oshal_queue_dlq WHERE ticket_id IN (SELECT id FROM tree) RETURNING ticket_id),
    escalations AS (DELETE FROM swarm_escalations WHERE ticket_external_id IN (SELECT id FROM tree) RETURNING id)
    SELECT (SELECT count(*) FROM items)::int AS work_items, (SELECT count(*) FROM runs)::int AS swarm_runs,
      (SELECT count(*) FROM governance)::int AS governance, (SELECT count(*) FROM dlq)::int AS dlq,
      (SELECT count(*) FROM escalations)::int AS escalations`,
  // What one run's ids ($2 text[]) can leave once the root is gone: no anchor ticket remains, so the
  // count is by exact id, and the tickets count is the caller's own.
  'tickets-in-tickets.residue': `SELECT
    (SELECT count(*) FROM tickets WHERE owner_sub = $1 AND ticket_id::text = ANY($2::text[]))::int AS tickets,
    (SELECT count(*) FROM work_items WHERE external_id = ANY($2::text[])
      OR external_id IN (SELECT 'verify:' || x FROM unnest($2::text[]) AS x)
      OR external_id LIKE ANY (SELECT 'review:' || x || ':%' FROM unnest($2::text[]) AS x))::int AS work_items,
    (SELECT count(*) FROM ticket_governance WHERE ticket_id = ANY($2::text[]))::int AS governance,
    (SELECT count(*) FROM oshal_queue_dlq WHERE ticket_id = ANY($2::text[]))::int AS dlq,
    (SELECT count(*) FROM swarm_escalations WHERE ticket_external_id = ANY($2::text[]))::int AS escalations,
    (SELECT count(*) FROM swarm_runs r WHERE jsonb_typeof(r.processed) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.processed) e WHERE e->>'externalId' = ANY($2::text[])))::int AS swarm_runs`,
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
