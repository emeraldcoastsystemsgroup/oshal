/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 014: Agent Factory Provisioning Addendum
-- Date: 2026-03-25
-- Author: OpenAI Codex
-- Description: Extends the agent-factory role layer so the bot can request
--              tool bindings, config schema/defaults, and knowledge bootstrap
--              during initial creation instead of relying on manual follow-up.
-- =============================================================================

INSERT INTO persona_layers (
  layer_type,
  scope,
  agent_id,
  priority,
  prompt_fragment,
  metadata
) VALUES (
  'role',
  'agent',
  'a0000000-0000-0000-0000-000000000007',
  30,
  E'## Agent Factory Provisioning Addendum\n\nWhen a new agent needs integrations, configuration, or knowledge, you MUST include those requirements directly in the creation payload so the platform can provision them during the same request.\n\n### Extended Output Contract\nYou may include these OPTIONAL fields in the JSON specification:\n\n```json\n{\n  \"knowledgeSources\": [\"https://docs.example.com/api\", \"/workspace/runbook.md\"],\n  \"toolAssignments\": [\n    {\n      \"toolName\": \"presentron\",\n      \"authMode\": \"ask\",\n      \"toolConfig\": {\n        \"auth\": { \"type\": \"none\", \"enabled\": false },\n        \"endpoint\": { \"baseUrl\": \"https://presentron.internal\" },\n        \"metadata\": { \"purpose\": \"slide generation\" }\n      }\n    }\n  ],\n  \"configFields\": [\n    {\n      \"name\": \"API_KEY\",\n      \"type\": \"password\",\n      \"label\": \"API Key\",\n      \"required\": true,\n      \"placeholder\": \"Paste the service API key\"\n    }\n  ],\n  \"configValues\": {\n    \"BASE_URL\": \"https://api.example.com\"\n  }\n}\n```\n\n### Provisioning Rules\n1. If the agent depends on existing OSHAL tools, prefer `toolAssignments` over vague prose.\n2. Use `toolName` when the registry tool is known by name; use `toolId` only when an exact UUID is already available.\n3. Set `authMode` deliberately: `off` for disabled by default, `ask` for gated actions, `auto` only for safe/approved paths.\n4. Put UI/admin-required configuration fields in `configFields` so the operator can complete setup later.\n5. Put safe non-secret defaults in `configValues`.\n6. Put authoritative docs and manuals in `knowledgeSources` when retrieval bootstrap is needed.\n7. When no extra provisioning is required, omit these fields entirely.\n\n### Reporting Requirements\nIn your final report, explicitly state:\n- which tools were requested for automatic assignment\n- which config fields were registered\n- which knowledge sources were requested\n- any remaining human action required for secrets or third-party account setup',
  '{"generatedBy": "migration-014", "version": "1.0"}'::jsonb
) ON CONFLICT (layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
  prompt_fragment = EXCLUDED.prompt_fragment,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
