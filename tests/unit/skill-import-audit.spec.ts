/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill-import security-audit tests: broken skills BLOCK (no artifacts), bundled scripts force REVIEW + quarantine, foreign tools warn, clean skills pass CLEAN.
 */

import { describe, expect, it } from 'vitest';
import { parseSkillMd, translateTools, auditSkill } from '../../src/features/skill-import';

function audit(raw: string, scripts: string[] = []) {
  const parsed = parseSkillMd(raw);
  return auditSkill(parsed, translateTools(parsed), scripts);
}

const CLEAN = `---
name: changelog-writer
description: Draft changelog entries from a git diff. Use when the user asks for release notes.
allowed-tools:
  - Read
---
# Changelog Writer
Summarise the diff into Keep-a-Changelog sections.
`;

describe('auditSkill', () => {
  it('passes a clean skill with installState "clean"', () => {
    const a = audit(CLEAN);
    expect(a.pass).toBe(true);
    expect(a.installState).toBe('clean');
    expect(a.issues.some(i => i.level === 'error')).toBe(false);
  });

  it('BLOCKS a skill with no name (error) — installState blocked', () => {
    const a = audit('---\ndescription: something. use when needed.\n---\nbody');
    expect(a.pass).toBe(false);
    expect(a.installState).toBe('blocked');
    expect(a.issues.some(i => i.code === 'missing-name')).toBe(true);
  });

  it('BLOCKS a non-hyphen-case name', () => {
    const a = audit('---\nname: Not A Slug!\ndescription: x. use when x.\n---\nbody');
    expect(a.issues.some(i => i.code === 'invalid-name')).toBe(true);
    expect(a.pass).toBe(false);
  });

  it('BLOCKS a skill with an empty body (nothing to become the perspective)', () => {
    const a = audit('---\nname: empty-bot\ndescription: x. use when x.\n---\n   ');
    expect(a.issues.some(i => i.code === 'body-empty')).toBe(true);
    expect(a.pass).toBe(false);
  });

  it('forces REVIEW and quarantines when the skill bundles executable scripts', () => {
    const a = audit(CLEAN, ['scripts/run.py', 'scripts/build.sh']);
    expect(a.pass).toBe(true);
    expect(a.installState).toBe('review');
    const scriptIssue = a.issues.find(i => i.code === 'bundled-scripts-quarantined');
    expect(scriptIssue?.message).toContain('QUARANTINED');
  });

  it('warns (not blocks) on foreign mcp__ tools and unknown frontmatter keys', () => {
    const raw = `---
name: xcode-bot
description: Build iOS apps. Use when building Xcode projects.
weird-key: 1
---
Call mcp__XcodeBuildMCP__build to build.
`;
    const a = audit(raw);
    expect(a.pass).toBe(true);
    expect(a.installState).toBe('review');
    expect(a.issues.some(i => i.code === 'inline-mcp-tools')).toBe(true);
    expect(a.issues.some(i => i.code === 'frontmatter-extra-keys')).toBe(true);
  });

  it('warns when the description lacks a "use when" trigger clause', () => {
    const a = audit('---\nname: vague-bot\ndescription: Does things with data.\n---\nbody');
    expect(a.issues.some(i => i.code === 'description-no-trigger')).toBe(true);
  });
});
