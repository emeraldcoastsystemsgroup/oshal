/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill-import orchestrator — parse → audit → (if not blocked) map to persona + manifest. Pure: all fs/network I/O lives in the CLI caller.
 */

import type { ParsedSkill, SkillImportOptions, SkillImportResult } from '../types';
import { parseSkillMd } from './skill-parser';
import { translateTools } from './tool-translation';
import { auditSkill } from './skill-audit';
import { mapSkillToPersona, mapSkillToManifest } from './skill-mapper';
import { slugify } from './skill-identifiers';

/**
 * @description Imports a parsed skill: translate its tools, run the security audit, and — only
 * if the audit did not BLOCK it — map it to an OSHAL persona + swarm-apps manifest. A blocked
 * (quarantined) skill returns its audit with null artifacts, so a caller can never accidentally
 * emit a runnable bot from a broken/unsafe skill. Bundled scripts are always reported as
 * quarantined regardless of verdict — they are never wired for execution here.
 * @param parsed - the parsed SKILL.md
 * @param opts - import options (agent id, harness, provenance, discovered bundled scripts/refs)
 * @returns the import result (slug, audit, persona|null, manifest|null, translation, quarantined scripts)
 */
export function importSkill(parsed: ParsedSkill, opts: SkillImportOptions = {}): SkillImportResult {
  const quarantinedScripts = opts.bundledScripts ?? [];
  const toolTranslation = translateTools(parsed);
  const audit = auditSkill(parsed, toolTranslation, quarantinedScripts);
  const slug = slugify(String(parsed.frontmatter.name ?? ''));

  if (!audit.pass) {
    return { slug, audit, persona: null, manifest: null, toolTranslation, quarantinedScripts };
  }

  const persona = mapSkillToPersona(parsed, toolTranslation, opts);
  const manifest = mapSkillToManifest(persona, opts);
  return { slug, audit, persona, manifest, toolTranslation, quarantinedScripts };
}

/**
 * @description Convenience wrapper: parse raw SKILL.md text then import it in one call.
 * @param raw - the full SKILL.md text
 * @param opts - import options
 * @returns the import result
 */
export function importSkillFromText(raw: string, opts: SkillImportOptions = {}): SkillImportResult {
  const parsed: ParsedSkill = parseSkillMd(raw);
  return importSkill(parsed, opts);
}
