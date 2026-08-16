/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards every bot persona against instructing a direct push to main. The oshal-developer persona still carried the PRE-CUTOVER trunk rule ("work directly on main. No feature branches ... git push origin main") long after ADR-115 made the trunk branch-protected, so the platform-development bot was being told to do the one thing the remote rejects — and its ticket work would have died at the push with no branch to recover it from. Repo-wide because the next persona to grow a git section will copy an existing one.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PERSONA_DIR = path.resolve(process.cwd(), 'ai-lab/bot-personas');
const DEVELOPER_PERSONA = path.join(PERSONA_DIR, 'oshal-developer.yaml');

/** Every persona YAML in the kernel persona directory. */
function personaFiles(): string[] {
  return fs.readdirSync(PERSONA_DIR)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => path.join(PERSONA_DIR, f));
}

/** Instructions that tell a bot to put commits straight onto the protected trunk. */
const DIRECT_TO_MAIN_PATTERNS: readonly { what: string; re: RegExp }[] = [
  { what: 'a direct push to main', re: /git\s+push\s+(?:-u\s+)?origin\s+(?:main|master)\b/i },
  { what: '"work directly on main"', re: /(?:work|commit)\s+directly\s+on\s+(?:main|master)\b/i },
  { what: 'a "no feature branches" instruction', re: /no\s+feature\s+branches/i },
];

describe('bot personas must not instruct a direct push to the protected trunk', () => {
  it('finds persona files to check (a guard over an empty set is not a guard)', () => {
    expect(personaFiles().length).toBeGreaterThan(0);
    expect(fs.existsSync(DEVELOPER_PERSONA)).toBe(true);
  });

  it('has no persona telling a bot to commit or push straight to main', () => {
    const offenders: string[] = [];
    for (const file of personaFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of DIRECT_TO_MAIN_PATTERNS) {
        if (pattern.re.test(text)) offenders.push(`${path.basename(file)}: ${pattern.what}`);
      }
    }
    expect(offenders, `main is branch-protected — these personas instruct work that cannot land:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});

describe('the platform-development persona teaches the branch → PR → merge contract', () => {
  const text = fs.readFileSync(DEVELOPER_PERSONA, 'utf8');

  it('tells the bot to branch, push the branch, and open a PR', () => {
    expect(text, 'must name the branch command').toMatch(/git\s+switch\s+-c/);
    expect(text, 'must push the BRANCH, not main').toMatch(/git\s+push\s+-u\s+origin\s+<branch>/);
    expect(text, 'must open a pull request').toMatch(/gh\s+pr\s+create/);
  });

  it('states WHY: the trunk rejects a direct push', () => {
    // Without the reason, the next agent to hit a push failure "fixes" it by pushing to main.
    expect(text).toMatch(/branch-protected/i);
  });

  it('keeps the one-active-branch rule and the explicit-pathspec commit discipline', () => {
    expect(text).toMatch(/ONE active development branch/i);
    expect(text).toMatch(/git add <explicit paths>/);
  });

  it('still forbids bypassing the guard hooks and rewriting shared history', () => {
    // These survived the rewrite; losing them would trade one hazard for a worse one.
    expect(text).toMatch(/--no-verify/);
    expect(text).toMatch(/force-push/i);
    expect(text).toMatch(/reset --hard/);
  });

  it('still confines the bot to its own clone', () => {
    expect(text).toMatch(/\/app\/dev-repo/);
    expect(text).toMatch(/NEVER write to \/app\/src/);
  });
});
