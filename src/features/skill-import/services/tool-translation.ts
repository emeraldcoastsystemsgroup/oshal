/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Translate source (Claude/Codex) tool names into OSHAL tool ids — least-privilege, never a 1:1 copy. Unmapped names are recorded, not granted.
 */

import type { SkillFrontmatter, ParsedSkill, ToolTranslation } from '../types';

/**
 * Source tool name (normalised lowercase) → OSHAL tool id. Only the tool ids that
 * actually exist in the OSHAL registry are mapping targets (bash, read_file,
 * write_to_file, search_files, list_files, execute_command). Anything with no entry
 * here — including every `mcp__*` server tool — is deliberately UNMAPPED: recorded as
 * a warning and NOT granted, so importing a skill can never silently confer a
 * capability OSHAL can't scope. This is codex-packer's "strip anything it does not need".
 */
const SOURCE_TO_OSHAL: Record<string, string> = {
  bash: 'bash',
  shell: 'bash',
  terminal: 'bash',
  executecommand: 'execute_command',
  execute_command: 'execute_command',
  read: 'read_file',
  read_file: 'read_file',
  readfile: 'read_file',
  cat: 'read_file',
  view: 'read_file',
  write: 'write_to_file',
  write_to_file: 'write_to_file',
  writefile: 'write_to_file',
  edit: 'write_to_file',
  create: 'write_to_file',
  glob: 'search_files',
  grep: 'search_files',
  search: 'search_files',
  search_files: 'search_files',
  find: 'search_files',
  ls: 'list_files',
  list: 'list_files',
  list_files: 'list_files',
  listdir: 'list_files',
};

/** Minimal read-only grant used when nothing maps — NEVER an empty array (which OSHAL reads as "don't narrow the grant"). */
export const MINIMAL_TOOL_GRANT = ['read_file'];

/**
 * @description Normalises the frontmatter `allowed-tools` (YAML list OR comma string OR
 * absent) into a flat string array of source tool names.
 * @param fm - the parsed frontmatter
 * @returns the declared source tool names (possibly empty)
 */
export function declaredTools(fm: SkillFrontmatter): string[] {
  const raw = fm['allowed-tools'];
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * @description Translates a skill's declared tools (frontmatter `allowed-tools`) PLUS any
 * `mcp__*` tools named only inline in the body into an OSHAL grant. Mapped names collapse to
 * their OSHAL id (de-duplicated); unmapped names — foreign MCP tools, unknown verbs — are
 * returned separately and never granted. An empty grant degrades to MINIMAL_TOOL_GRANT.
 * @param parsed - the parsed skill (frontmatter + inline mentions)
 * @returns the granted OSHAL tool ids and the unmapped source names
 */
export function translateTools(parsed: ParsedSkill): ToolTranslation {
  const sources = [...declaredTools(parsed.frontmatter), ...parsed.inlineToolMentions];
  const granted = new Set<string>();
  const unmapped = new Set<string>();

  for (const src of sources) {
    const key = src.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const mapped = SOURCE_TO_OSHAL[key];
    if (mapped) granted.add(mapped);
    else unmapped.add(src);
  }

  return {
    granted: granted.size > 0 ? [...granted] : [...MINIMAL_TOOL_GRANT],
    unmapped: [...unmapped],
  };
}
