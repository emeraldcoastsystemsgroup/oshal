/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 013: Repair Agent Factory / Research Bot Seed Collision
-- Date: 2026-03-15
-- Author: OpenAI Codex
-- Description: Restores agent-factory on UUID ...0007 after migration 011
--              accidentally reused that UUID for research-bot. Seeds
--              research-bot onto UUID ...000c so future stacks keep both bots.
-- =============================================================================

-- Restore agent-factory selector/persona metadata on its canonical UUID.
UPDATE agents
SET
  name = 'agent-factory',
  persona = $af_persona${
    "systemPrompt": "You are the Agent Factory Bot — the meta-agent of the OSHAL swarm. Your singular purpose is to research, design, configure, create, and register NEW specialist agents into the swarm. When someone says \"I need an agent that can do X\", you make it happen.",
    "role": "factory"
  }$af_persona$::jsonb,
  base_capabilities = ARRAY['agent-creation', 'bot-provisioning', 'capability-expansion', 'agent-design', 'persona-generation'],
  base_selector_descriptor = 'Meta-agent that creates and registers new specialist agents into the swarm. Dispatched by project-manager when a capability gap is detected. Follows a 9-phase SOP: analyze, research, design, write system prompt, persist, load knowledge, verify, and report.',
  base_routing_keywords = ARRAY['create-bot', 'new-agent', 'agent-factory', 'provision', 'spawn', 'generate-bot', 'capability-gap', 'bot-creation', 'add-specialist', 'create-agent'],
  metadata = jsonb_build_object(
    'topology', 'swarm',
    'role', 'specialist',
    'createdBy', 'migration-010'
  ),
  updated_at = NOW()
WHERE agent_id = 'a0000000-0000-0000-0000-000000000007';

-- Seed research-bot on its own UUID so it no longer overwrites agent-factory.
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-00000000000c',
  'research-bot', 'active', 'openai-codex', 'codex-mini-latest',
  '{"systemPrompt": "You are a Research Analyst. Investigate topics thoroughly, analyze with structured methodology, synthesize into evidence-based reports with cited sources. Store findings in ChromaDB.", "role": "research-analyst"}'::jsonb,
  ARRAY['research', 'analysis', 'documentation', 'investigation'],
  'Select for IN-DEPTH RESEARCH, ANALYSIS, or INVESTIGATION. Web research, competitive analysis, technology evaluation, evidence-based reports.',
  ARRAY['research', 'investigate', 'analyze', 'evaluate', 'report', 'study'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-011"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  name = EXCLUDED.name,
  api_provider_id = EXCLUDED.api_provider_id,
  model_id = EXCLUDED.model_id,
  persona = EXCLUDED.persona,
  base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
