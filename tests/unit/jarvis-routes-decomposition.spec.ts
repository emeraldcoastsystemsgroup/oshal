/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins the boundary that closed the "jarvis-routes.ts is over the decomposition threshold" backlog item, because the entry had already been satisfied on main and nothing held it there: the file had drifted 732 -> 762 code lines across six commits since the split, and the next addition to cross 800 would reopen it silently. (a) jarvis-routes.ts and the module it was split into stay under the 800-line decomposition threshold and the 1000-line hard cap, counted by ESLint's own max-lines rule (skipComments + skipBlankLines), never a hand-rolled stripper; (b) the per-thread chat-ticket + session-task registration stays in jarvis-thread-tickets.ts and is consumed from there, so it cannot be inlined back into the route file; (c) the ADR-100 person-model recall hook keeps its single home in jarvis-routes.ts and reaches the slice through the '@/features/person-model' barrel rather than a deep import. Scope is those two files only — no constraint is placed on the other jarvis-* route modules. Red-proved against the live tree on 2026-09-16: 60 appended statements (762 -> 822 code lines) fail (a), a re-inlined threadTicketKey in the route file fails (b), and a deep import of the person-model slice fails (c); the file was restored to blob afee829d unchanged after each. Source pins use character classes rather than a word-boundary escape because this repository's heredoc transport silently collapses a doubled backslash, turning the guard into a literal-backspace match that can never fire.
 * -----------------------------------------------------------------------------
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const ROOT = path.resolve(__dirname, '../..');
const ENTRY = 'src/app/routes/jarvis-routes.ts';
const EXTRACTED = 'src/app/routes/jarvis-thread-tickets.ts';

/** Read one repo-relative source file. */
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Count code lines exactly as ESLint's max-lines rule does (skipComments + skipBlankLines) — the
 * same semantics CLAUDE.md's "comments and blank lines don't count" states and eslint.config.mjs
 * gates on. Lint the file with max 0 and read the reported count back out of the message.
 *
 * @description A hand-rolled stripper disagrees with the linter on trailing block comments and
 * on code that shares a line with a comment, which is how a "compliant" file gets reported twice
 * with two different numbers. Borrowing the rule removes the second opinion.
 * @param rel Repo-relative path of the TypeScript file to measure.
 * @returns The number of lines the rule counts, comments and blank lines excluded.
 */
function eslintCodeLines(rel: string): number {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(read(rel), [{
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser as never, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    rules: { 'max-lines': ['error', { max: 0, skipComments: true, skipBlankLines: true }] },
  }], { filename: path.join(ROOT, rel) });
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`${rel}: ${fatal.message}`);
  const hit = messages.find((m) => m.ruleId === 'max-lines');
  const n = hit ? Number((/\((\d+)\)/.exec(hit.message) ?? [])[1]) : 0;
  if (!Number.isFinite(n)) throw new Error(`${rel}: could not read the max-lines count from "${hit?.message}"`);
  return n;
}

describe('(a) file size — counted by ESLint max-lines (skipComments + skipBlankLines), never a hand-rolled counter', () => {
  it.each([ENTRY, EXTRACTED])('%s stays under the 800-line decomposition threshold', (rel) => {
    expect(eslintCodeLines(rel)).toBeLessThan(800);
  });

  it.each([ENTRY, EXTRACTED])('%s stays under the 1000-line hard cap', (rel) => {
    expect(eslintCodeLines(rel)).toBeLessThan(1000);
  });
});

describe('(b) the extracted per-thread chat-ticket registration stays extracted', () => {
  const extracted = ['threadTicketKey', 'ensureSessionTask', 'ensureThreadChatTicket', 'closeThreadChatTicket'] as const;

  it.each(extracted)('%s is declared in jarvis-thread-tickets.ts', (name) => {
    expect(read(EXTRACTED)).toMatch(new RegExp('^export (?:async )?function ' + name + '[(<]', 'm'));
  });

  it('the route file consumes them from the sibling instead of redeclaring them', () => {
    const src = read(ENTRY);
    expect(src).toMatch(/^import \{[^}]*\} from '\.\/jarvis-thread-tickets';$/m);
    for (const name of extracted) {
      expect(src, `${name} must not be redeclared in ${ENTRY}`)
        .not.toMatch(new RegExp('^(?:export )?(?:async )?function ' + name + '[(<]', 'm'));
    }
  });
});

describe('(c) the ADR-100 person-model recall hook keeps one home and one front door', () => {
  const frontDoor = ['detectPersonModelIntent', 'answerPersonModelIntent', 'ownerHasAmbientData'] as const;

  it('reaches the slice through the @/features/person-model barrel, never a deep import', () => {
    const src = read(ENTRY);
    const importBlock = /import \{([^}]*)\} from '@\/features\/person-model';/.exec(src);
    expect(importBlock, 'the recall hook must import from the person-model barrel').not.toBeNull();
    for (const name of frontDoor) expect(importBlock?.[1]).toContain(name);
    expect(src, 'no deep import into the person-model slice').not.toMatch(/from '@\/features\/person-model\//);
  });

  it('the deterministic recall answer is gated on the owner actually having ambient data', () => {
    expect(read(ENTRY)).toMatch(/ownerHasAmbientData\(\s*ctx\.pool,\s*sub\s*\)/);
  });
});
