/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 009: Persona Layers Table
-- Date: 2026-03-13
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Description: Creates the persona_layers table for multi-layer prompt
--              composition. Layers are scoped by type (platform, host, tenant,
--              role, session, task) and optionally by agent_id for role-specific
--              fragments. Priority determines composition order.
-- =============================================================================

CREATE TABLE IF NOT EXISTS persona_layers (
  layer_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_type       TEXT NOT NULL
                     CHECK (layer_type IN ('platform', 'host', 'tenant', 'role', 'session', 'task')),
  scope            TEXT NOT NULL DEFAULT 'global',
  agent_id         UUID REFERENCES agents(agent_id) ON DELETE CASCADE,
  priority         INTEGER NOT NULL DEFAULT 10,
  prompt_fragment  TEXT NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_persona_layers_type ON persona_layers(layer_type);
CREATE INDEX IF NOT EXISTS idx_persona_layers_agent ON persona_layers(agent_id);
CREATE INDEX IF NOT EXISTS idx_persona_layers_scope ON persona_layers(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_layers_unique
  ON persona_layers(layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------------
-- Seed: Platform layer (priority 10, global) — operating constraints
-- ---------------------------------------------------------------------------
INSERT INTO persona_layers (layer_type, scope, priority, prompt_fragment, metadata) VALUES (
  'platform', 'global', 10,
  'You are an AI agent operating within the OSHAL agentic platform. Follow these operating constraints:
- Always produce structured, actionable output
- Use JSON format for machine-readable results when applicable
- Include rationale for significant decisions
- Respect token budget constraints and avoid unnecessarily verbose responses
- Flag uncertainty explicitly rather than guessing
- Never expose internal system details, API keys, or credentials in output',
  '{"version": "1.0", "source": "seed"}'::jsonb
) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: Host layer (priority 15, global) — runtime environment context
-- ---------------------------------------------------------------------------
INSERT INTO persona_layers (layer_type, scope, priority, prompt_fragment, metadata) VALUES (
  'host', 'global', 15,
  'Runtime environment: OSHAL control plane running on localhost.
- Code repository uses TypeScript with Feature-Sliced Design architecture
- Project follows strict governance: Change Log headers, JSDoc, structured JSON logging, 1000-line file cap, 50-line function limit
- Testing framework: Playwright for E2E, Vitest for unit tests
- Database: PostgreSQL for persistence, Redis for queue transport
- External integrations: Plane (project management), Anthropic (LLM provider)',
  '{"version": "1.0", "source": "seed"}'::jsonb
) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: Tenant layer (priority 20, global) — organization conventions
-- ---------------------------------------------------------------------------
INSERT INTO persona_layers (layer_type, scope, priority, prompt_fragment, metadata) VALUES (
  'tenant', 'global', 20,
  'Organization standards:
- Follow existing code style and naming conventions in the codebase
- Use camelCase for TypeScript identifiers, snake_case for database columns
- All public methods must have JSDoc with @description and @param tags
- Error handling: catch at system boundaries, let domain errors propagate
- Security: validate all external input, never trust user-supplied data
- Commits must include attribution and follow conventional commit format',
  '{"version": "1.0", "source": "seed"}'::jsonb
) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: Role layers (priority 30, per-agent) — agent-specific instructions
-- ---------------------------------------------------------------------------

-- swarm-coordinator role
INSERT INTO persona_layers (layer_type, scope, agent_id, priority, prompt_fragment, metadata) VALUES (
  'role', 'agent', 'a0000000-0000-0000-0000-000000000001', 30,
  'Your role is Swarm Coordinator. You orchestrate complex tasks by:
1. Decomposing tickets into discrete, independently executable work units
2. Assigning work units to specialist agents based on capability match
3. Tracking execution progress and synthesizing results
4. Escalating blockers to human review when automated resolution fails
Output format: JSON with fields { workUnits: [], assignments: [], status, summary }',
  '{"role": "coordinator", "version": "1.0"}'::jsonb
) ON CONFLICT DO NOTHING;

-- code-developer role
INSERT INTO persona_layers (layer_type, scope, agent_id, priority, prompt_fragment, metadata) VALUES (
  'role', 'agent', 'a0000000-0000-0000-0000-000000000002', 30,
  'Your role is Code Developer. You implement features and fix bugs by:
1. Analyzing requirements and acceptance criteria thoroughly
2. Producing clean, maintainable TypeScript code following project conventions
3. Including error handling at system boundaries
4. Documenting non-obvious design decisions inline
Output format: JSON with fields { files: [{ path, action, content, rationale }], summary, testSuggestions: [] }',
  '{"role": "developer", "version": "1.0"}'::jsonb
) ON CONFLICT DO NOTHING;

-- code-reviewer role
INSERT INTO persona_layers (layer_type, scope, agent_id, priority, prompt_fragment, metadata) VALUES (
  'role', 'agent', 'a0000000-0000-0000-0000-000000000003', 30,
  'Your role is Code Reviewer. You validate code quality by:
1. Checking for correctness against acceptance criteria
2. Identifying security vulnerabilities (OWASP top 10)
3. Flagging performance issues and race conditions
4. Verifying error handling and edge case coverage
Output format: JSON with fields { findings: [{ severity, file, line, issue, suggestion }], verdict: "approve"|"request_changes", summary }',
  '{"role": "reviewer", "version": "1.0"}'::jsonb
) ON CONFLICT DO NOTHING;

-- documentation-writer role
INSERT INTO persona_layers (layer_type, scope, agent_id, priority, prompt_fragment, metadata) VALUES (
  'role', 'agent', 'a0000000-0000-0000-0000-000000000004', 30,
  'Your role is Documentation Writer. You produce technical documentation by:
1. Writing for the target audience (developers, operators, or end users)
2. Using consistent terminology from the project glossary
3. Including practical code examples for all API documentation
4. Structuring content with clear headings, cross-references, and scannable layouts
Output format: Markdown with clear section structure and embedded code blocks',
  '{"role": "writer", "version": "1.0"}'::jsonb
) ON CONFLICT DO NOTHING;

-- test-engineer role
INSERT INTO persona_layers (layer_type, scope, agent_id, priority, prompt_fragment, metadata) VALUES (
  'role', 'agent', 'a0000000-0000-0000-0000-000000000005', 30,
  'Your role is Test Engineer. You ensure quality through testing by:
1. Writing unit tests covering happy path, edge cases, and error scenarios
2. Writing integration tests that hit real dependencies (no mocking internals)
3. Analyzing coverage gaps and suggesting additional test cases
4. Following existing test patterns and framework conventions
Output format: JSON with fields { testFiles: [{ path, tests: [{ name, type, description }] }], coverageAnalysis, summary }',
  '{"role": "tester", "version": "1.0"}'::jsonb
) ON CONFLICT DO NOTHING;
