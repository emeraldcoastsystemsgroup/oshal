/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-16 item 2. Migration 010 seeded the agent-factory bot a system prompt containing a FALSE fact about the schema that bot designs agents against. Quoted here so a reviewer can see the change without reconstructing it from the SQL below.  BEFORE: "platform, organization, role, task, session layers (priority 10-50)".  AFTER: "a closed six-value union of layer types: platform, host, tenant, role, session, task (lower priority composes first; the seeded globals are platform 10, host 15, tenant 20, role 30)".  The before string names five types and one of them, `organization`, has never existed: `persona_layers.layer_type` carries CHECK (layer_type IN ('platform','host','tenant','role','session','task')), so an INSERT naming `organization` is rejected outright. 010 is applied history, so correcting its file reaches only a fresh install; this migration reaches the databases that already ran it. Rewrites ONLY that phrase rather than replacing the whole systemPrompt, so an operator who has since edited this prompt by hand keeps their edit. Idempotent by construction - a prompt that no longer contains the phrase is not matched, and the WHERE clause means a second run updates zero rows.
 */

-- =============================================================================
-- Migration 149: Correct the persona-layer vocabulary in the agent-factory prompt
-- Date: 2026-09-20
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Description: The agent-factory bot's seeded systemPrompt asserted a
--              five-value persona-layer vocabulary including a layer type the
--              schema has never had. The real vocabulary is the closed
--              six-value union in the persona_layers CHECK constraint. Targets
--              the phrase, not the prompt, so hand edits survive.
-- =============================================================================

UPDATE agents
SET persona = jsonb_set(
      persona,
      '{systemPrompt}',
      to_jsonb(
        replace(
          persona ->> 'systemPrompt',
          'platform, organization, role, task, session layers (priority 10-50)',
          'a closed six-value union of layer types: platform, host, tenant, role, session, task '
          || '(lower priority composes first; the seeded globals are platform 10, host 15, tenant 20, role 30)'
        )
      )
    ),
    updated_at = NOW()
WHERE name = 'agent-factory'
  AND persona ? 'systemPrompt'
  -- Only a row that still carries the false phrase is touched. This is what makes the
  -- migration idempotent and what keeps it from bumping updated_at on every deploy.
  AND persona ->> 'systemPrompt' LIKE '%platform, organization, role, task, session layers%';
