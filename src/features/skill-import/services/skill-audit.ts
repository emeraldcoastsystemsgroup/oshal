/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill security-audit gate — mirrors the connector auditSpec/installState quarantine rails. Bundled scripts + unmapped tools drive the skill to 'review'; broken skills 'blocked'.
 */

import type { ParsedSkill, SkillAudit, SkillAuditIssue, ToolTranslation } from '../types';

/** Frontmatter keys the Agent-Skills format sanctions; anything else is a (tolerated) warning. */
const KNOWN_FRONTMATTER_KEYS = new Set([
  'name', 'description', 'license', 'allowed-tools', 'metadata',
  'disable-model-invocation', 'user-invocable', 'context', 'agent',
]);

/** A valid skill/persona slug: hyphen-case, letters/digits/hyphens, <=64 chars. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Phrases that signal a routing/trigger clause in the description (mis-routing guard). */
const TRIGGER_HINTS = ['use when', 'use this', 'when the user', 'when you', 'for when', 'invoke when'];

/**
 * @description Grades a parsed skill against the import safety checklist and returns a verdict
 * with a quarantine `installState`. Errors (missing/invalid name, missing description, empty
 * body) BLOCK the import — no artifacts are emitted. Warnings (bundled scripts, foreign tools,
 * unknown frontmatter keys, no trigger clause) still import but force 'review' so an operator
 * signs off before the bot is enabled. This is the "run a stranger's skill inside a governed
 * sandbox" gate — bundled executable scripts are ALWAYS a review item, never blind-executed.
 * @param parsed - the parsed skill
 * @param translation - the tool translation result (source unmapped tools raise a warning)
 * @param bundledScripts - executable script paths the caller discovered (quarantine drivers)
 * @returns the audit verdict (name, pass, installState, issues)
 */
export function auditSkill(
  parsed: ParsedSkill,
  translation: ToolTranslation,
  bundledScripts: string[] = [],
): SkillAudit {
  const fm = parsed.frontmatter;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  const issues: SkillAuditIssue[] = [];

  auditIdentity(name, fm.description, parsed.body, issues);
  auditFrontmatterKeys(fm, issues);
  auditTriggerClause(fm.description, issues);
  auditToolsAndScripts(parsed, translation, bundledScripts, issues);

  const pass = !issues.some(i => i.level === 'error');
  const installState = !pass
    ? 'blocked'
    : issues.some(i => i.level === 'warn') || bundledScripts.length > 0
      ? 'review'
      : 'clean';
  return { name: name || '(unnamed)', pass, installState, issues };
}

/** Errors that make a skill non-runnable: no valid name, no description, no body/instructions. */
function auditIdentity(name: string, description: unknown, body: string, issues: SkillAuditIssue[]): void {
  if (!name) issues.push({ level: 'error', code: 'missing-name', message: 'SKILL.md frontmatter has no `name`.' });
  else if (!SKILL_NAME_RE.test(name)) {
    issues.push({ level: 'error', code: 'invalid-name', message: `\`name\` "${name}" is not hyphen-case (letters/digits/hyphens, <=64 chars).` });
  }
  if (typeof description !== 'string' || !description.trim()) {
    issues.push({ level: 'error', code: 'missing-description', message: 'SKILL.md frontmatter has no `description` (the routing signal).' });
  } else if (description.length > 1024) {
    issues.push({ level: 'warn', code: 'description-too-long', message: `\`description\` is ${description.length} chars (>1024).` });
  }
  if (!body.trim()) {
    issues.push({ level: 'error', code: 'body-empty', message: 'SKILL.md has no body — nothing to become the persona `perspective`.' });
  }
}

/** Unknown frontmatter keys are tolerated (we absorb foreign schemas) but recorded. */
function auditFrontmatterKeys(fm: Record<string, unknown>, issues: SkillAuditIssue[]): void {
  const extra = Object.keys(fm).filter(k => !KNOWN_FRONTMATTER_KEYS.has(k));
  if (extra.length > 0) {
    issues.push({ level: 'warn', code: 'frontmatter-extra-keys', message: `Non-standard frontmatter keys ignored: ${extra.join(', ')}.` });
  }
}

/** A description with no "use when" clause mis-routes (the ADR-083 seeder-fallback trap). */
function auditTriggerClause(description: unknown, issues: SkillAuditIssue[]): void {
  if (typeof description !== 'string') return;
  const lower = description.toLowerCase();
  if (!TRIGGER_HINTS.some(h => lower.includes(h))) {
    issues.push({ level: 'warn', code: 'description-no-trigger', message: 'Description has no "use when" clause — router selector may be weak.' });
  }
}

/** Foreign tools are recorded (never granted); bundled scripts are always a quarantine review item. */
function auditToolsAndScripts(
  parsed: ParsedSkill,
  translation: ToolTranslation,
  bundledScripts: string[],
  issues: SkillAuditIssue[],
): void {
  if (translation.unmapped.length > 0) {
    issues.push({ level: 'warn', code: 'unmapped-tools', message: `Foreign tools NOT granted (need operator wiring): ${translation.unmapped.join(', ')}.` });
  }
  if (parsed.inlineToolMentions.length > 0) {
    issues.push({ level: 'warn', code: 'inline-mcp-tools', message: `Body references MCP tools not in allowed-tools: ${parsed.inlineToolMentions.join(', ')}.` });
  }
  if (bundledScripts.length > 0) {
    issues.push({ level: 'warn', code: 'bundled-scripts-quarantined', message: `${bundledScripts.length} bundled script(s) QUARANTINED — not wired for execution pending operator review: ${bundledScripts.join(', ')}.` });
  }
}
