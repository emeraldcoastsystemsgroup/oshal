/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel — skill-import feature. Absorb an Agent-Skills SKILL.md into a governed, capability-scoped OSHAL bot (persona + swarm-apps manifest). BACKLOG "Absorb, don't fight".
 */

export type {
  SkillFrontmatter,
  ParsedSkill,
  SkillAuditLevel,
  SkillAuditIssue,
  SkillAudit,
  ToolTranslation,
  EmittedPersona,
  EmittedManifestBot,
  EmittedManifest,
  SkillImportOptions,
  SkillImportResult,
  RagIngestPayload,
  RagIngestOutcome,
} from './types';

export {
  parseSkillMd,
  translateTools,
  declaredTools,
  MINIMAL_TOOL_GRANT,
  auditSkill,
  SKILL_NAME_RE,
  mapSkillToPersona,
  mapSkillToManifest,
  buildPerspective,
  slugify,
  deriveAgentId,
  mineKeywords,
  deriveCapabilities,
  importSkill,
  importSkillFromText,
  ragCollectionFor,
  formatForFile,
  buildRagIngestPayload,
  buildRagIngestPayloads,
} from './services';
