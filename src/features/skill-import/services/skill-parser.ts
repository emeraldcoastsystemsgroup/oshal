/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pure SKILL.md parser — frontmatter + body + inline mcp__ tool mentions. No fs, no network.
 */

import yaml from 'js-yaml';
import type { ParsedSkill, SkillFrontmatter } from '../types';

/** Matches a leading YAML frontmatter block delimited by --- fences. */
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** Foreign MCP tool references named inline in the body, e.g. mcp__XcodeBuildMCP__build. */
const MCP_MENTION_RE = /mcp__[A-Za-z0-9_]+/g;

/**
 * @description Parses raw SKILL.md text into frontmatter + markdown body. Tolerant of
 * both source dialects and of a missing frontmatter block (treats the whole file as body,
 * with empty frontmatter, so the audit — not the parser — decides validity).
 * @param raw - the full text of a SKILL.md file
 * @returns the parsed skill (frontmatter, body, inline mcp__ mentions)
 */
export function parseSkillMd(raw: string): ParsedSkill {
  const match = FRONTMATTER_RE.exec(raw ?? '');
  if (!match) {
    return { frontmatter: {}, body: (raw ?? '').trim(), inlineToolMentions: [] };
  }

  const [, fmText, body] = match;
  const frontmatter = parseFrontmatter(fmText);
  const trimmedBody = (body ?? '').trim();
  return { frontmatter, body: trimmedBody, inlineToolMentions: extractMcpMentions(trimmedBody) };
}

/**
 * @description Parses the frontmatter YAML into a SkillFrontmatter, normalising the two
 * `allowed-tools` shapes (YAML list OR comma-separated string) is left to the tool-translator;
 * a parse failure degrades to empty frontmatter (the audit flags the missing name/description).
 * @param fmText - the raw text between the --- fences
 * @returns the parsed frontmatter object (possibly empty)
 */
function parseFrontmatter(fmText: string): SkillFrontmatter {
  try {
    const parsed = yaml.load(fmText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SkillFrontmatter;
    }
  } catch {
    /* malformed frontmatter — degrade to empty; auditSkill surfaces the missing fields */
  }
  return {};
}

/**
 * @description Extracts unique `mcp__*` tool references named inline in the body — foreign
 * MCP tools the frontmatter `allowed-tools` may not list, so they can't be silently assumed.
 * @param body - the markdown body
 * @returns the de-duplicated list of mcp__ mentions, in first-seen order
 */
function extractMcpMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.match(MCP_MENTION_RE) ?? []) seen.add(m);
  return [...seen];
}
