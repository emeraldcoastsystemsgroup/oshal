/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill-import parser + tool-translation tests: frontmatter/body split (both dialects, CRLF, no-frontmatter), inline mcp__ capture, and least-privilege tool translation (never the empty-array grant).
 */

import { describe, expect, it } from 'vitest';
import {
  parseSkillMd,
  translateTools,
  declaredTools,
  MINIMAL_TOOL_GRANT,
} from '../../src/features/skill-import';

const ANTHROPIC_SKILL = `---
name: pdf-editor
description: Rotate, split, and fill PDF forms. Use when the user works with .pdf files.
license: MIT
allowed-tools:
  - Bash
  - Read
  - Write
metadata:
  short-description: Edit and transform PDFs
---
# PDF Editor
Do the work. You may call mcp__pdfLib__rotate to rotate pages.
`;

describe('parseSkillMd', () => {
  it('splits frontmatter from body and keeps the body as the instructions', () => {
    const parsed = parseSkillMd(ANTHROPIC_SKILL);
    expect(parsed.frontmatter.name).toBe('pdf-editor');
    expect(parsed.frontmatter.description).toContain('Rotate, split');
    expect(parsed.frontmatter.license).toBe('MIT');
    expect(parsed.body.startsWith('# PDF Editor')).toBe(true);
  });

  it('captures inline mcp__ tool mentions the frontmatter omits', () => {
    const parsed = parseSkillMd(ANTHROPIC_SKILL);
    expect(parsed.inlineToolMentions).toContain('mcp__pdfLib__rotate');
  });

  it('tolerates CRLF line endings', () => {
    const parsed = parseSkillMd(ANTHROPIC_SKILL.replace(/\n/g, '\r\n'));
    expect(parsed.frontmatter.name).toBe('pdf-editor');
    expect(parsed.body).toContain('PDF Editor');
  });

  it('degrades a file with no frontmatter to an empty frontmatter + whole-file body', () => {
    const parsed = parseSkillMd('# Just a heading\nno frontmatter here');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toContain('Just a heading');
  });

  it('degrades malformed frontmatter YAML to empty frontmatter (never throws)', () => {
    const parsed = parseSkillMd('---\n: : : not yaml : :\n---\nbody');
    expect(parsed.frontmatter.name).toBeUndefined();
    expect(parsed.body).toBe('body');
  });
});

describe('declaredTools', () => {
  it('reads a YAML list', () => {
    expect(declaredTools({ 'allowed-tools': ['Bash', 'Read'] })).toEqual(['Bash', 'Read']);
  });
  it('reads a comma-separated string', () => {
    expect(declaredTools({ 'allowed-tools': 'Bash, Read , Write' })).toEqual(['Bash', 'Read', 'Write']);
  });
  it('returns [] when absent', () => {
    expect(declaredTools({})).toEqual([]);
  });
});

describe('translateTools (least privilege)', () => {
  it('maps source tool names to OSHAL tool ids and de-duplicates', () => {
    const parsed = parseSkillMd(ANTHROPIC_SKILL);
    const t = translateTools(parsed);
    expect(t.granted).toEqual(expect.arrayContaining(['bash', 'read_file', 'write_to_file']));
    // Bash + Read + Write → 3 distinct OSHAL ids, no dupes.
    expect(new Set(t.granted).size).toBe(t.granted.length);
  });

  it('records foreign mcp__ tools as unmapped and NEVER grants them', () => {
    const parsed = parseSkillMd(ANTHROPIC_SKILL);
    const t = translateTools(parsed);
    expect(t.unmapped).toContain('mcp__pdfLib__rotate');
    expect(t.granted).not.toContain('mcp__pdfLib__rotate');
  });

  it('falls back to the minimal read-only grant (never []) when nothing maps', () => {
    const parsed = parseSkillMd('---\nname: talk-bot\ndescription: chat. use when chatting.\n---\nbody');
    const t = translateTools(parsed);
    expect(t.granted).toEqual(MINIMAL_TOOL_GRANT);
    expect(t.granted.length).toBeGreaterThan(0);
  });
});
