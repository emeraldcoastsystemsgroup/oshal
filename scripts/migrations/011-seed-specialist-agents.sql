/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 011: Seed Specialist Agent Definitions
-- Date: 2026-03-14
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Description: Seeds 5 specialist agents for swarm ecosystem expansion (WS-8):
--              research-bot, devops-bot, rca-specialist, security-auditor-bot,
--              incident-response-bot.
--              Brings total from 6 to 11 seeded agents.
-- =============================================================================

-- research-bot: Investigation & analysis specialist
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-00000000000c',
  'research-bot', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are a Research Analyst. Investigate topics thoroughly, analyze with structured methodology, synthesize into evidence-based reports with cited sources. Store findings in ChromaDB.", "role": "research-analyst"}'::jsonb,
  ARRAY['research', 'analysis', 'documentation', 'investigation'],
  'Select for IN-DEPTH RESEARCH, ANALYSIS, or INVESTIGATION. Web research, competitive analysis, technology evaluation, evidence-based reports.',
  ARRAY['research', 'investigate', 'analyze', 'evaluate', 'report', 'study'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-011"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords, metadata = EXCLUDED.metadata, updated_at = NOW();

-- devops-bot: Infrastructure & CI/CD specialist
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-000000000008',
  'devops-bot', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are a Senior DevOps Engineer. Manage infrastructure, CI/CD, containers, and deployments. Always have rollback plans. Use infrastructure-as-code.", "role": "devops-engineer"}'::jsonb,
  ARRAY['infrastructure', 'cicd', 'kubernetes', 'docker', 'monitoring', 'deployment', 'scripting', 'bash'],
  'Select for INFRASTRUCTURE, CI/CD, KUBERNETES, DOCKER, DEPLOYMENT, and SCRIPTING tasks.',
  ARRAY['infrastructure', 'deploy', 'kubernetes', 'docker', 'cicd', 'pipeline', 'container', 'devops', 'script', 'bash'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-011"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords, metadata = EXCLUDED.metadata, updated_at = NOW();

-- rca-specialist: Root cause analysis expert
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-000000000009',
  'rca-specialist', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are a Senior Root Cause Analyst. Investigate failures using 5 Whys, Ishikawa, and fault tree analysis. Distinguish symptoms from root causes. Produce actionable RCA reports.", "role": "root-cause-analyst"}'::jsonb,
  ARRAY['root-cause-analysis', 'investigation', 'debugging', 'incident-analysis'],
  'Select for ROOT CAUSE ANALYSIS, INCIDENT INVESTIGATION, and DEBUGGING of production failures.',
  ARRAY['rca', 'root-cause', 'incident', 'investigation', 'failure', 'debug', 'postmortem'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-011"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords, metadata = EXCLUDED.metadata, updated_at = NOW();

-- security-auditor-bot: Security & compliance specialist
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-00000000000a',
  'security-auditor-bot', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are a Senior Security Auditor. Audit code for OWASP Top 10, review infrastructure security, assess compliance (SOC2/GDPR/HIPAA). Produce severity-ranked audit reports.", "role": "security-auditor"}'::jsonb,
  ARRAY['security', 'compliance', 'vulnerability-assessment', 'audit'],
  'Select for SECURITY AUDITS, VULNERABILITY SCANNING, COMPLIANCE REVIEW.',
  ARRAY['security', 'audit', 'vulnerability', 'compliance', 'owasp', 'penetration', 'encryption'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-011"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords, metadata = EXCLUDED.metadata, updated_at = NOW();

-- incident-response-bot: Incident triage & resolution specialist
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-00000000000b',
  'incident-response-bot', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are a Senior Incident Responder. Triage by severity, execute runbooks, coordinate response, manage stakeholder communication. Escalation protocol: P1 immediate, P2 30min, P3 4hr, P4 next cycle.", "role": "incident-responder"}'::jsonb,
  ARRAY['incident-response', 'triage', 'runbook-execution', 'stakeholder-communication'],
  'Select for INCIDENT TRIAGE, INCIDENT RESPONSE, and RUNBOOK EXECUTION.',
  ARRAY['incident', 'outage', 'alert', 'triage', 'response', 'runbook', 'escalation'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-011"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords, metadata = EXCLUDED.metadata, updated_at = NOW();
