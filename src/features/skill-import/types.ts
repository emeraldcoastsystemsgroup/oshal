/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill-import adapter types — parse an Agent-Skills SKILL.md into the codex-packer/ADR-038 persona + manifest shape, security-gated (BACKLOG "Absorb, don't fight").
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: EmittedManifest.suite + SkillImportOptions.suite — every generated manifest declares its ONE primary catalog shelf (plain string here to preserve the no-cross-feature-dependency shape; the swarm-apps loader enum-validates at registration).
 */

/**
 * Frontmatter parsed from a SKILL.md. Accepts both the Anthropic/Claude dialect
 * (hyphenated `allowed-tools`) and the Codex mirror (`metadata:` map, name+description
 * only). Unknown keys are tolerated on import (recorded as an audit warning) rather
 * than rejected — the whole point is to ABSORB a stranger's skill, not gatekeep its schema.
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  'allowed-tools'?: string[] | string;
  metadata?: Record<string, unknown>;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  context?: unknown;
  agent?: unknown;
  [key: string]: unknown;
}

/** A parsed SKILL.md — frontmatter + the markdown body (the instructions/system prompt). */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** The markdown body after the frontmatter block — becomes the persona `perspective`. */
  body: string;
  /** `mcp__*` tool references named inline in the body (foreign, security-relevant). */
  inlineToolMentions: string[];
}

export type SkillAuditLevel = 'error' | 'warn' | 'info';

/** One audit finding. Mirrors the connector-catalog AuditIssue shape. */
export interface SkillAuditIssue {
  level: SkillAuditLevel;
  code: string;
  message: string;
}

/**
 * Audit verdict for an imported skill. Mirrors the connector ConnectorAudit +
 * marketplace installState rails: `pass` = no error-level issues; `installState`
 * is the quarantine gate — 'blocked' emits nothing, 'review' emits but must be
 * operator-approved before enable, 'clean' is safe to enable.
 */
export interface SkillAudit {
  name: string;
  pass: boolean;
  installState: 'blocked' | 'review' | 'clean';
  issues: SkillAuditIssue[];
}

/** Result of translating source tool names into OSHAL tool ids (least-privilege). */
export interface ToolTranslation {
  /** OSHAL tool ids to grant (minimized; never the empty-array "unrestricted" footgun). */
  granted: string[];
  /** Source tool names with no OSHAL equivalent — deliberately NOT granted. */
  unmapped: string[];
}

/** The emitted OSHAL persona (BotPersona-compatible, snake_case). */
export interface EmittedPersona {
  name: string;
  role: string;
  agent_id: string;
  perspective: string;
  capabilities: string[];
  selector_descriptor: string;
  routing_keywords: string[];
  allowed_tools: string[];
  runtime: { harness: string; model: string; sandbox: string };
  source: { type: 'skill-import'; skill: string; license?: string };
}

/** One bot entry in the emitted manifest. Structurally assignable to SwarmAppBotDeclaration. */
export interface EmittedManifestBot {
  agentId: string;
  name: string;
  persona: string;
  role: string;
  capabilities: string[];
  selectorDescriptor: string;
  routingKeywords: string[];
}

/**
 * The emitted swarm-apps manifest. A structural subset of SwarmAppManifest
 * (@/features/swarm-apps) — kept local so this slice has no same-layer cross-feature
 * dependency; the CLI bridges it to `serializeManifest`. The `rag` block mirrors
 * codex-packer's manifest template (documentary; consumed by a separate ingest step).
 */
export interface EmittedManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  status: 'active' | 'inactive';
  /** ADR-097 primary catalog shelf. Plain string (not the swarm-apps enum) to keep this
   *  slice free of same-layer cross-feature imports; the loader enum-validates on load. */
  suite: string;
  ticketType: string;
  workflow: { name: string; pipeline: string; workerBot: string };
  bots: EmittedManifestBot[];
  source: { type: string; url?: string; ref?: string; path?: string };
  rag?: { collection: string };
}

/**
 * One bundled reference doc, shaped for `POST /api/rag/ingest`. The route requires `format` + a
 * non-empty `content`; `collection` defaults server-side to 'default' (we always name it explicitly).
 */
export interface RagIngestPayload {
  collection: string;
  format: string;
  title: string;
  content: string;
  metadata: Record<string, string>;
}

/** The outcome of ingesting one reference doc (reported by the CLI; never throws). */
export interface RagIngestOutcome {
  /** The doc_id stamped into the corpus (`skill:<slug>/<file>`), the citation key. */
  docId: string;
  ingested: boolean;
  /** Chunks the RAG service created, when the ingest succeeded. */
  chunkCount?: number;
  /** Sanitized failure reason (never contains a token). */
  error?: string;
}

/** Caller-supplied options for an import (defaults chosen for least privilege). */
export interface SkillImportOptions {
  /** Deterministic agent id override; default derived from the skill name. */
  agentId?: string;
  /** Harness for the emitted bot. Default 'codex-cli' (shell-capable, matches codex-packer). */
  harness?: string;
  /** Model hint for the runtime block. */
  model?: string;
  /** Sandbox mode. Default 'workspace-write' — NOT danger-full-access for an untrusted import. */
  sandbox?: string;
  /** Provenance stamped into persona + manifest `source`. */
  source?: { url?: string; ref?: string; path?: string };
  /** RAG collection for bundled references, when the skill ships `references/`. */
  ragCollection?: string;
  /** ADR-097 catalog suite for the emitted manifest. Default 'ai-productivity' — the
   *  general-purpose shelf; the operator re-shelves during the inactive-review pass. */
  suite?: string;
  /** Bundled executable script paths discovered by the caller (fs) — QUARANTINED, never wired. */
  bundledScripts?: string[];
  /** Bundled reference-doc paths discovered by the caller — RAG candidates. */
  referenceDocs?: string[];
}

/** The full outcome of importing one skill. */
export interface SkillImportResult {
  slug: string;
  audit: SkillAudit;
  /** null when the audit BLOCKED the skill — a quarantined skill emits no runnable artifacts. */
  persona: EmittedPersona | null;
  manifest: EmittedManifest | null;
  toolTranslation: ToolTranslation;
  /** Bundled scripts held back for operator review — never wired for auto-execution. */
  quarantinedScripts: string[];
}
