/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One definition of "the retired standalone product name" for the guards that hunt it in shipped user-facing strings. Two specs need the same rule (the installer scripts and the route-rendered strings), and two copies of a naming regex drift apart the moment one of them is tuned — which is how a guard quietly stops covering half its targets.
 */

/**
 * Detects the retired standalone product name in user-facing copy.
 *
 * CLAUDE.md sanctions exactly two forms — "oshal" and "open swarm oshal" — and grandfathers
 * existing technical identifiers. Those three facts decide the shape of the pattern below:
 *
 *  - It matches only the SPACE-SEPARATED display form. The grandfathered filenames spell the old
 *    name hyphenated (`Open-Swarm-Node.cmd`) or closed up (`Install-OpenSwarm.bat`), so neither can
 *    match and neither needs a per-file exception — which is what keeps this from becoming a guard
 *    that gets narrowed to whatever tripped it.
 *  - The two sanctioned continuations are excluded by lookahead, not by allowlist: the attached
 *    acronym expansion ("Open Swarm Harness Agent LLM") and the attached mark ("open swarm oshal").
 *    A standalone use is precisely one with neither continuation.
 *
 * @module retired-product-name
 */

/**
 * The retired standalone product name as a reader encounters it.
 * Global + case-insensitive; callers that need `.test()` should use {@link findStandaloneNameUses}
 * instead, because a shared global regex carries `lastIndex` between calls.
 */
const STANDALONE_RETIRED_NAME = /\bOpen[ \t]+Swarm\b(?![ \t]+(?:Harness\b|oshal\b))/gi;

/**
 * @description Finds every line of `text` that uses the retired standalone product name.
 * Line-based on purpose: a failure message naming the offending line is what makes the guard
 * actionable, and per-line reporting is also what lets a caller exempt a specific kind of line
 * (a one-time upgrade lookup) without weakening the pattern itself.
 * @param text - Source to scan. Callers strip comments first when prose about the rename would
 * otherwise be flagged; this function deliberately does no stripping of its own.
 * @returns The offending lines, trimmed, in file order. Empty when the text is clean.
 */
export function findStandaloneNameUses(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => new RegExp(STANDALONE_RETIRED_NAME.source, 'i').test(line))
    .map((line) => line.trim());
}

/**
 * @description True when a line is the one-time upgrade lookup of an old name rather than a string
 * a user reads. The operator's 2026-09-20 decision was "rename in place on upgrade", so the
 * installer must still be able to FIND what an older install left behind — a firewall rule matched
 * by display name, a shortcut matched by filename. Those lookups are recognized structurally: the
 * old name may appear only where it is assigned to a `$legacy…` variable, which is a shape a
 * reviewer can check and a rename cannot accidentally satisfy.
 * @param line - A single source line, already trimmed or not.
 * @returns True if the line assigns a `$legacy…` PowerShell variable.
 */
export function isLegacyNameLookup(line: string): boolean {
  return /^\s*\$legacy\w*\s*=/i.test(line);
}

/**
 * @description Strips the comments of a Windows batch/command script, so a guard over `.cmd` files
 * tests what the script DOES rather than the change log recording what it used to be called. An
 * append-only change log necessarily quotes the old name; counting that as a violation is how a
 * guard ends up demanding that history be falsified.
 * @param text - Raw `.cmd` contents.
 * @returns The same text with `REM` and `::` comment lines removed.
 */
export function cmdCodeOnly(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:REM\b|::)/i.test(line))
    .join('\n');
}
