/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Skill-import mapper + orchestrator tests: deterministic ids, governance-wrapped perspective, least-privilege persona, manifest emitted inactive, blocked skills emit no artifacts, re-import is idempotent.
 */

import { describe, expect, it } from 'vitest';
import {
  parseSkillMd,
  importSkill,
  importSkillFromText,
  mapSkillToPersona,
  translateTools,
  deriveAgentId,
  slugify,
  mineKeywords,
} from '../../src/features/skill-import';

const SKILL = `---
name: release-notes
description: Draft release notes from commits. Use when the user asks for a changelog or release summary.
allowed-tools:
  - Read
  - Bash
---
# Release Notes
Summarise commits into sections. You may call mcp__git__log for history.
`;

describe('deterministic identifiers', () => {
  it('slugify normalises to hyphen-case, capped at 64 chars', () => {
    expect(slugify('PDF Editor!!')).toBe('pdf-editor');
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(64);
  });
  it('deriveAgentId is stable and uses the reserved imported prefix', () => {
    expect(deriveAgentId('release-notes')).toBe(deriveAgentId('release-notes'));
    expect(deriveAgentId('release-notes')).toMatch(/^b0000000-0000-0000-0000-[0-9a-f]{12}$/);
    expect(deriveAgentId('release-notes')).not.toBe(deriveAgentId('other-skill'));
  });
  it('mineKeywords drops stopwords and short tokens', () => {
    const kw = mineKeywords('Use this bot when the user asks for a changelog', 8);
    expect(kw).toContain('changelog');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('use');
  });
});

describe('mapSkillToPersona', () => {
  const parsed = parseSkillMd(SKILL);
  const persona = mapSkillToPersona(parsed, translateTools(parsed));

  it('maps the body into the perspective verbatim under an imported-instructions heading', () => {
    expect(persona.perspective).toContain('## Imported skill instructions');
    expect(persona.perspective).toContain('Summarise commits into sections');
  });

  it('appends an OSHAL governance footer binding the skill to the quality gate', () => {
    expect(persona.perspective).toContain('## OSHAL governance');
    expect(persona.perspective).toContain('Mode B');
    expect(persona.perspective).toContain('DRY_RUN=true');
  });

  it('names the granted tools and the ungranted foreign tools in the perspective', () => {
    expect(persona.perspective).toContain('your granted tools are [read_file, bash]');
    expect(persona.perspective).toContain('mcp__git__log');
    expect(persona.perspective).toContain('NOT granted');
  });

  it('emits a least-privilege allowed_tools (never empty) + a routable selector/keywords', () => {
    expect(persona.allowed_tools.length).toBeGreaterThan(0);
    expect(persona.allowed_tools).not.toContain('mcp__git__log');
    expect(persona.selector_descriptor).toContain('release');
    expect(persona.routing_keywords).toContain('release');
    expect(persona.capabilities).toContain('imported-skill');
  });

  it('defaults the sandbox to workspace-write (not danger-full-access) for an untrusted import', () => {
    expect(persona.runtime.sandbox).toBe('workspace-write');
  });
});

describe('importSkill (orchestrator)', () => {
  it('emits a persona + an INACTIVE manifest pinned to the worker bot for a clean skill', () => {
    const r = importSkillFromText(SKILL);
    expect(r.audit.pass).toBe(true);
    expect(r.persona).not.toBeNull();
    expect(r.manifest).not.toBeNull();
    expect(r.manifest!.status).toBe('inactive'); // never auto-enables on import
    expect(r.manifest!.ticketType).toBe('release-notes');
    expect(r.manifest!.workflow.workerBot).toBe('release-notes');
    expect(r.manifest!.bots[0].agentId).toBe(r.persona!.agent_id);
    expect(r.manifest!.bots[0].persona).toBe('ai-lab/bot-personas/release-notes.yaml');
  });

  it('emits NO artifacts for a blocked (quarantined) skill but still returns the audit', () => {
    const r = importSkillFromText('---\ndescription: no name here. use when x.\n---\nbody');
    expect(r.audit.pass).toBe(false);
    expect(r.persona).toBeNull();
    expect(r.manifest).toBeNull();
  });

  it('reports bundled scripts as quarantined and forces the manifest to review', () => {
    const parsed = parseSkillMd(SKILL);
    const r = importSkill(parsed, { bundledScripts: ['scripts/gen.py'] });
    expect(r.quarantinedScripts).toEqual(['scripts/gen.py']);
    expect(r.audit.installState).toBe('review');
    expect(r.persona!.perspective).toContain('QUARANTINED');
  });

  it('is idempotent — re-importing the same skill yields the same agent id + slug', () => {
    const a = importSkillFromText(SKILL);
    const b = importSkillFromText(SKILL);
    expect(a.persona!.agent_id).toBe(b.persona!.agent_id);
    expect(a.slug).toBe(b.slug);
  });

  it('stamps provenance from options into the manifest source', () => {
    const r = importSkillFromText(SKILL, { source: { url: 'https://example.test/skills/release-notes', ref: 'v1' } });
    expect(r.manifest!.source.url).toBe('https://example.test/skills/release-notes');
    expect(r.manifest!.source.ref).toBe('v1');
  });
});
