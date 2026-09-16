/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-115 stale-checkout hazard: every Windows scheduled-task launcher in scripts/ must resolve its payload from its OWN directory, never from a typed absolute checkout. Four launchers pointed at the frozen pre-cutover archive, so the keepalive, the signal labeler and the trade-report batch tool ran a tree that had not moved since the cutover commit while their trunk copies diverged. The one deliberate exception (the private evidence board) must declare itself in-band with OSHAL-INTENTIONAL-ARCHIVE-PATH, so a future sweep cannot silently reintroduce a hardcoded path and cannot silently "fix" the one that is meant to stay.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPTS = resolve(__dirname, '../../scripts');

/** In-band opt-out marker. A launcher carrying it is asserted to be intentional, not overlooked. */
const INTENTIONAL = 'OSHAL-INTENTIONAL-ARCHIVE-PATH';

/**
 * A typed Windows checkout root: `C:\Projects\<name>` or `C:/Projects/<name>`, in any case.
 * Gating on the SHAPE (a drive-absolute project checkout) rather than on the one archive name is
 * deliberate: the hazard is "this launcher is pinned to a tree that is not the one it ships in",
 * and that is just as broken when the typed path is the trunk, a worktree, or the next archive.
 */
const TYPED_CHECKOUT = /[A-Za-z]:[\\/]Projects[\\/][A-Za-z0-9._-]+/g;

/** The frozen ADR-115 reference archive, named so a regression report says WHICH tree. */
const ADR_115_ARCHIVE = /open-shal-swarm-harness-agent-llm/;

const read = (file: string) => readFileSync(join(SCRIPTS, file), 'utf8');

/** Windows scheduled-task launchers: the .vbs wrappers plus the .cmd files a task can name. */
const launchers = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('.vbs') || f.endsWith('.cmd'))
  .sort();

/** Registrars that create/replace a scheduled task. They must derive the action from their own path. */
const registrars = readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('register-') && f.endsWith('.ps1'))
  .sort();

describe('scheduled-task launchers resolve their own checkout (ADR-115)', () => {
  it('finds the launchers it is supposed to be guarding', () => {
    // A rename that empties this list would turn every assertion below into a vacuous pass.
    expect(launchers.length).toBeGreaterThanOrEqual(10);
    expect(launchers).toContain('claude-token-keepalive-hidden.vbs');
    expect(launchers).toContain('oshal-signal-daily.cmd');
    expect(launchers).toContain('run-evidence-nightly-hidden.vbs');
    expect(registrars.length).toBeGreaterThanOrEqual(3);
  });

  it.each(launchers)('%s names no typed checkout root, or declares it intentional', (file) => {
    const body = read(file);
    const typed = body.match(TYPED_CHECKOUT) ?? [];
    if (body.includes(INTENTIONAL)) {
      // Declared exceptions still have to be real: the marker is only honest if the file does
      // in fact carry a typed path, and it must say which tree and why right there in the file.
      expect(typed.length).toBeGreaterThan(0);
      return;
    }
    expect(typed, `${file} pins a checkout: ${typed.join(', ')}`).toEqual([]);
  });

  it.each(launchers)('%s derives its payload path from its own location', (file) => {
    const body = read(file);
    if (body.includes(INTENTIONAL)) return;
    const selfLocating = file.endsWith('.vbs')
      ? /WScript\.ScriptFullName/.test(body)
      : /%~dp0/.test(body);
    expect(selfLocating, `${file} must resolve its payload relative to itself`).toBe(true);
  });

  it.each(registrars)('%s builds its action from $PSScriptRoot, not a typed checkout', (file) => {
    const body = read(file);
    expect(body).toMatch(/\$PSScriptRoot/);
    expect(body.match(TYPED_CHECKOUT) ?? []).toEqual([]);
  });

  it('only the private evidence board is allowed to stay on the frozen archive', () => {
    // docs/evidence/ is internal-only and refused by the publish gate, so this trunk cannot hold
    // the board the nightly writes. That is why the job stays put -- and why exactly one launcher
    // may say so. A second entry here means someone repointed a movable task at the archive.
    const onArchive = launchers.filter((f) => ADR_115_ARCHIVE.test(read(f)));
    expect(onArchive).toEqual(['run-evidence-nightly-hidden.vbs']);
    expect(read('run-evidence-nightly-hidden.vbs')).toContain(INTENTIONAL);
  });

  it('the keepalive and signal registrars register the windowless launcher, not a bare powershell', () => {
    // A bare powershell action flashes a console host on the operator's desktop every run, which is
    // why both live tasks had been hand-edited to call the .vbs -- and that hand-edit is exactly
    // what typed the archive path in. Registering the .vbs keeps the repoint and the zero window.
    for (const file of ['register-claude-token-keepalive.ps1', 'register-signal-labeler.ps1']) {
      const body = read(file);
      expect(body).toMatch(/New-ScheduledTaskAction -Execute 'wscript\.exe'/);
      expect(body).toMatch(/-hidden\.vbs/);
      expect(body).toMatch(/-WorkingDirectory \$repo/);
    }
  });
});
