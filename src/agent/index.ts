/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: Agent worker barrel — re-exports from existing feature locations
 */

/**
 * @description Agent worker layer barrel.
 *
 * This module re-exports all agent-worker-only features from their current
 * locations in src/features/. No files have been moved — this is a convention
 * layer that establishes the import boundary.
 *
 * Import rule: src/agent/ CANNOT import from src/swarm/
 *              src/agent/ CAN import from src/shared/, src/entities/, src/features/
 *
 * Modules:
 *   - chat            → chat session management
 *   - orchestration   → agentic loop, tool execution, task orchestration
 *   - llm             → LLM API calls (Claude, OpenAI, etc.)
 *   - streaming       → SSE/WebSocket streaming
 *   - memory          → conversation memory layer
 *   - rag             → RAG vector search and retrieval
 *   - tools           → tool loading, registry, approval, verification, switch, integrations
 *   - voice           → voice integration
 *   - presentation    → slide/report generation
 *   - rca             → root cause analysis
 *   - auth            → Claude Code CLI auth, OpenAI Codex OAuth
 */

// ── Chat Orchestration (agentic loop, tool execution) ────────────────────────
export * from '@/features/chat-orchestration/index.js';

// ── LLM Provider ─────────────────────────────────────────────────────────────
export * from '@/features/llm-provider/index.js';

// ── Streaming ────────────────────────────────────────────────────────────────
export * from '@/features/streaming/index.js';

// ── Tool Loader ──────────────────────────────────────────────────────────────
export * from '@/features/tool-loader/index.js';

// ── Tool Registry ────────────────────────────────────────────────────────────
export * from '@/features/tool-registry/index.js';

// ── Chat (session management) ────────────────────────────────────────────────
// Note: chat/ does not have a barrel export — re-export when available
// export * from '@/features/chat/index.js';

// ── Memory ───────────────────────────────────────────────────────────────────
// Note: memory/ may not have a barrel export yet
// export * from '@/features/memory/index.js';

// ── RAG ──────────────────────────────────────────────────────────────────────
// Note: rag/ may not have a barrel export yet
// export * from '@/features/rag/index.js';

// ── Tool Approval ────────────────────────────────────────────────────────────
// Note: tool-approval/ may not have a barrel export yet
// export * from '@/features/tool-approval/index.js';

// ── Tool Verification ────────────────────────────────────────────────────────
// Note: tool-verification/ may not have a barrel export yet
// export * from '@/features/tool-verification/index.js';

// ── Tool Switch ──────────────────────────────────────────────────────────────
// Note: tool-switch/ may not have a barrel export yet
// export * from '@/features/tool-switch/index.js';

// ── Tool Integrations ────────────────────────────────────────────────────────
// Note: tool-integrations/ may not have a barrel export yet
// export * from '@/features/tool-integrations/index.js';

// ── Voice ────────────────────────────────────────────────────────────────────
// Note: voice/ may not have a barrel export yet
// export * from '@/features/voice/index.js';

// ── Presentation Generation ──────────────────────────────────────────────────
// Note: presentation-generation/ may not have a barrel export yet
// export * from '@/features/presentation-generation/index.js';

// ── RCA Analysis ─────────────────────────────────────────────────────────────
// Note: rca-analysis/ may not have a barrel export yet
// export * from '@/features/rca-analysis/index.js';

// ── Auth (Claude Code + Codex OAuth) ─────────────────────────────────────────
// Note: claude-code-auth/ and openai-codex-oauth/ may not have barrel exports
// export * from '@/features/claude-code-auth/index.js';
// export * from '@/features/openai-codex-oauth/index.js';