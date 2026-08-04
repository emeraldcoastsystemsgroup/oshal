/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the per-deployment settings that MUST be env-driven. A customer box whose host has no codex credentials had to hand-edit the jarvis-bot provider in the compose file. That left its git tree permanently dirty, which in turn made the documented core update — `git reset --hard origin/main`, gated on a clean tree — silently revert the setting and take the assistant down. Found 2026-08-03 while updating that box: the reset did exactly that, and the value had to be restored by hand. A setting a deployment must vary belongs in .env, where an update cannot reach it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = 'docker-compose.oshal-local.yml';
const compose = (): string => readFileSync(resolve(process.cwd(), COMPOSE), 'utf8');

describe('per-deployment overrides are env-driven, not hand-edits', () => {
  it('lets a box choose the assistant bot engine without editing a tracked file', () => {
    const yml = compose();

    // The jarvis-bot block is identified by its own comment, not by line number — there are 14
    // identical `FORCE_LLM_PROVIDER: openai-codex` blocks in this file, and both a sed and an
    // edit against the bare literal hit all of them.
    const anchor = yml.indexOf('the same proven pattern as email-bot/home-bot/cloud-ops-bot');
    expect(anchor, 'jarvis-bot anchor comment must be present').toBeGreaterThan(-1);
    const block = yml.slice(anchor, anchor + 1400);

    expect(block).toMatch(/FORCE_LLM_PROVIDER:\s*\$\{JARVIS_LLM_PROVIDER:-openai-codex\}/);
    expect(block).toMatch(/FORCE_LLM_MODEL:\s*\$\{JARVIS_LLM_MODEL:-gpt-5\.5\}/);
  });

  it('preserves the previous behaviour exactly when the vars are unset', () => {
    const yml = compose();

    // `:-` (not `-`) so an EMPTY value also falls back rather than rendering an empty provider,
    // which would start the bot with no engine and fail at first use rather than at boot.
    for (const v of ['JARVIS_LLM_PROVIDER', 'JARVIS_LLM_MODEL']) {
      const re = new RegExp(`\\$\\{${v}:-[^}]+\\}`);
      expect(yml, `${v} must use the :- form so an empty value falls back`).toMatch(re);
      expect(yml).not.toMatch(new RegExp(`\\$\\{${v}-[^}]`));
    }

    // The defaults must still be the literals they replaced. If someone "helpfully" changes the
    // default here, every deployment that never set the var silently switches engine.
    expect(yml).toContain('${JARVIS_LLM_PROVIDER:-openai-codex}');
    expect(yml).toContain('${JARVIS_LLM_MODEL:-gpt-5.5}');
  });

  it('keeps the claude auth mount mode env-driven', () => {
    const yml = compose();
    // Same class of setting, same lesson: a box that signs the CLI in on the host needs the
    // mounted credential directory writable so the token can refresh in place. It was a hand-edit
    // on at least one box before it was parameterised.
    expect(yml).toMatch(/:\/root\/\.claude:\$\{CLAUDE_AUTH_MOUNT_MODE:-ro\}/);
    expect(yml).toMatch(/:\/root\/\.claude\.json:\$\{CLAUDE_AUTH_MOUNT_MODE:-ro\}/);
    // Default stays read-only: writable credential mounts are opt-in, never the default.
    expect(yml).not.toMatch(/:\/root\/\.claude:rw/);
  });
});
