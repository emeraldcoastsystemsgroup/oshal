/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum (skill profiles): pin the whole contract — closed capability set (distinct from KERNEL_SKILLS), fail-closed manifest validation (unknown capability, stub profile, null/array shape), register→resolve→teardown-on-deactivate lifecycle, and the two-profile composition proof (one summarize capability, class-notes vs email-digest → domain-appropriate prompts). Also asserts the two in-repo consumer manifests parse with valid profiles.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3: retired the in-repo consumer-manifest check — email-summarizer (the last kernel manifest declaring skillProfiles) carved to the store; its email-digest profile rides the packaged manifest, registered at activate(). The registry/composition mechanism suites are unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readManifest } from '../../src/features/swarm-apps';
import {
  SKILL_CAPABILITY_IDS,
  isSkillCapabilityId,
  registerAppSkillProfiles,
  unregisterAppSkillProfiles,
  resolveSkillProfileByApp,
  resolveSkillProfileByTicketType,
  composeSkillProfilePrompt,
  type SkillProfile,
} from '../../src/shared/skill-profiles';

/**
 * @description Write a manifest and read it through the real readManifest.
 * @param body - YAML appended to the required name/displayName.
 * @returns the parsed manifest.
 */
function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-skillprof-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const APP = 'demo-summary-app';
afterEach(() => unregisterAppSkillProfiles(APP));

describe('capability set (ADR-090 addendum)', () => {
  it('summarize is a known capability; a kernel-skill id is NOT one', () => {
    expect([...SKILL_CAPABILITY_IDS]).toContain('summarize');
    expect(isSkillCapabilityId('summarize')).toBe(true);
    // deliberately disjoint from KERNEL_SKILLS — a module id is not a capability id
    expect(isSkillCapabilityId('deck-generation')).toBe(false);
    expect(isSkillCapabilityId('made-up')).toBe(false);
  });
});

describe('manifest validation is fail-closed', () => {
  it('accepts a well-formed summarize profile', () => {
    const m = read('skillProfiles:\n  summarize:\n    pattern: class-notes\n    instructions: Pull out key concepts.\n');
    expect(m.skillProfiles?.summarize?.pattern).toBe('class-notes');
  });

  it('rejects an unknown capability key', () => {
    expect(() => read('skillProfiles:\n  translate:\n    pattern: x\n    instructions: y\n')).toThrow(
      /unknown capability/,
    );
  });

  it('rejects a stub profile — a label with no instructions', () => {
    expect(() => read('skillProfiles:\n  summarize:\n    pattern: class-notes\n')).toThrow(/instructions must be non-empty/);
  });

  it('rejects a profile with no pattern label', () => {
    expect(() => read('skillProfiles:\n  summarize:\n    instructions: do things\n')).toThrow(/pattern must be a non-empty/);
  });

  it('rejects a non-map skillProfiles (YAML null / a list)', () => {
    expect(() => read('skillProfiles:\n')).toThrow(/must be a map/);
    expect(() => read('skillProfiles:\n  - summarize\n')).toThrow(/must be a map/);
  });

  it('a missing skillProfiles is fine (feature is opt-in)', () => {
    expect(read('').skillProfiles).toBeUndefined();
  });

  // The optional fields the dispatch composer consumes must fail CLOSED at load — a mistyped
  // `sections` or `outputContract` otherwise passes validation and throws a TypeError at dispatch.
  it('rejects a non-list sections', () => {
    expect(() =>
      read('skillProfiles:\n  summarize:\n    pattern: p\n    instructions: i\n    sections: notalist\n'),
    ).toThrow(/sections, when present, must be an array/);
  });

  it('rejects a sections list with an empty entry', () => {
    expect(() =>
      read('skillProfiles:\n  summarize:\n    pattern: p\n    instructions: i\n    sections: ["ok", "  "]\n'),
    ).toThrow(/sections, when present, must be an array/);
  });

  it('rejects a non-string outputContract', () => {
    expect(() =>
      read('skillProfiles:\n  summarize:\n    pattern: p\n    instructions: i\n    outputContract: 42\n'),
    ).toThrow(/outputContract, when present, must be a non-empty string/);
  });

  it('accepts a full profile with valid sections + outputContract', () => {
    const m = read(
      'skillProfiles:\n  summarize:\n    pattern: p\n    instructions: i\n    sections: [a, b]\n    outputContract: markdown\n',
    );
    expect(m.skillProfiles?.summarize?.sections).toEqual(['a', 'b']);
    expect(m.skillProfiles?.summarize?.outputContract).toBe('markdown');
  });
});

describe('registry lifecycle — register, resolve, tear down on deactivate', () => {
  const profile: SkillProfile = { pattern: 'class-notes', instructions: 'Key concepts + homework.' };

  it('resolves by app name and by ticketType after register; both null after unregister', () => {
    registerAppSkillProfiles({ appName: APP, ticketType: 'demo-education', profiles: { summarize: profile } });
    expect(resolveSkillProfileByApp(APP, 'summarize')?.pattern).toBe('class-notes');
    expect(resolveSkillProfileByTicketType('demo-education', 'summarize')?.pattern).toBe('class-notes');

    // deactivate() calls this — a toggled-off app must hold zero live profiles
    unregisterAppSkillProfiles(APP);
    expect(resolveSkillProfileByApp(APP, 'summarize')).toBeNull();
    expect(resolveSkillProfileByTicketType('demo-education', 'summarize')).toBeNull();
  });

  it('re-register replaces (idempotent — a reload does not double)', () => {
    registerAppSkillProfiles({ appName: APP, ticketType: 'demo-education', profiles: { summarize: profile } });
    registerAppSkillProfiles({
      appName: APP,
      ticketType: 'demo-education',
      profiles: { summarize: { pattern: 'revised', instructions: 'New guidance.' } },
    });
    expect(resolveSkillProfileByApp(APP, 'summarize')?.pattern).toBe('revised');
  });

  it('an empty profile map registers nothing', () => {
    registerAppSkillProfiles({ appName: APP, ticketType: 'demo-education', profiles: {} });
    expect(resolveSkillProfileByApp(APP, 'summarize')).toBeNull();
  });
});

describe('composition proof — one capability, two profiles → domain-appropriate prompts', () => {
  const base = '### Summarize this\n\n(transcript)';
  const classNotes: SkillProfile = {
    pattern: 'class-notes',
    instructions: 'Key concepts, definitions, homework for a K-12 student.',
    sections: ['key-concepts', 'homework-and-assignments'],
  };
  const meetingNotes: SkillProfile = {
    pattern: 'meeting-notes',
    instructions: 'Decisions and action items with owners for a busy professional.',
    sections: ['decisions', 'action-items'],
  };

  it('a null profile is a no-op (callers inject unconditionally)', () => {
    expect(composeSkillProfilePrompt(base, 'summarize', null)).toBe(base);
  });

  it('composes distinct, domain-appropriate guidance per profile', () => {
    const asClass = composeSkillProfilePrompt(base, 'summarize', classNotes);
    const asMeeting = composeSkillProfilePrompt(base, 'summarize', meetingNotes);

    // base content preserved in both
    expect(asClass.startsWith(base)).toBe(true);
    expect(asMeeting.startsWith(base)).toBe(true);

    // each carries ITS domain, not the other's
    expect(asClass).toContain('class-notes');
    expect(asClass).toContain('homework');
    expect(asClass).not.toContain('action-items');

    expect(asMeeting).toContain('meeting-notes');
    expect(asMeeting).toContain('action-items');
    expect(asMeeting).not.toContain('homework');

    // same capability, different output → the whole point
    expect(asClass).not.toBe(asMeeting);
  });
});

// (The in-repo consumer-manifest checks retired with the ADR-085 carves: little-monsters and
//  now email-summarizer both ship as store packages, so no kernel manifest declares
//  skillProfiles anymore. The packaged email-summarizer manifest still declares the
//  email-digest summarize profile — validated by the store package's build/validate gate —
//  and the full register→resolve→compose mechanism stays pinned by the suites above.)
