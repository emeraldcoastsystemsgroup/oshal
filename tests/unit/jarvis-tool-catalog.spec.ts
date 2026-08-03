/**
 * Guards for the Jarvis tool catalog — specifically, that a CLI's advertised subcommands keep up
 * with the CLI.
 *
 * WHY THIS EXISTS: buildToolsBlock() is Jarvis's ONLY view of a tool, and the block it emits says
 * "These are your ONLY tools — a script not listed here is off-limits even if you can see it." A
 * capability the usage string does not mention therefore does not exist as far as the assistant is
 * concerned. oshal-uber-rides.js grew `geocode` and `reverse` with the rides map fix — they are what
 * the surface calls to drop and drag pins — and the catalog kept advertising only estimate/ride, so
 * Jarvis answered "where is X" by guessing while a real geocoder sat one subcommand away.
 *
 * The assertions are deliberately TWO-SIDED: each one checks the catalog advertises the subcommand
 * AND that the CLI still implements it. A one-sided check on the usage string alone would keep
 * passing after someone deleted the subcommand, which is the same "guard that isn't a guard" shape
 * this repo has been burned by before.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Two-sided guard that the rides CLI's geocode/reverse subcommands stay advertised in the Jarvis tool block and stay implemented in the CLI. Closes the "Jarvis cannot use the new geocoding subcommands" rides follow-up.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildToolsBlock } from '../../src/app/routes/jarvis-tool-catalog';

/** The dispatch source for the rides CLI — the authority on which subcommands really exist. */
const RIDES_CLI = readFileSync(resolve(__dirname, '../../scripts/oshal-uber-rides.js'), 'utf8');

/**
 * The CATALOG ENTRY line buildToolsBlock emits for a CLI, or undefined when it is not advertised.
 *
 * Anchored on the entry's `→ node /app/scripts/<script>` suffix, not a bare substring match: the
 * block's preamble names oshal-uber-rides.js in its worked example ("e.g. an Uber ride →
 * oshal-uber-rides.js"), so a loose `includes(script)` returns that instructional line instead. The
 * first draft of this file did exactly that, and `ride` passed against the words "an Uber ride"
 * while asserting nothing about the catalog at all.
 */
function toolLine(script: string): string | undefined {
  return buildToolsBlock()
    .split('\n')
    .find((l) => l.startsWith('- ') && l.includes(`node /app/scripts/${script}`));
}

/** True when the CLI's argv dispatch has a `case '<name>':` arm for this subcommand. */
function cliImplements(sub: string): boolean {
  return new RegExp(`case\\s+'${sub}'\\s*:`).test(RIDES_CLI);
}

describe('Jarvis tool catalog — rides geocoding is reachable', () => {
  it('advertises the rides CLI at all', () => {
    expect(toolLine('oshal-uber-rides.js')).toBeDefined();
  });

  // Two-sided on purpose: catalog drops it -> red; CLI drops it -> red.
  it.each(['estimate', 'ride', 'geocode', 'reverse'])(
    'advertises `%s` and the CLI implements it',
    (sub) => {
      expect(cliImplements(sub), `oshal-uber-rides.js has no case '${sub}':`).toBe(true);
      expect(toolLine('oshal-uber-rides.js')).toContain(sub);
    },
  );

  it('tells Jarvis what geocode/reverse are FOR, not just that they exist', () => {
    // A bare subcommand name routes nothing: the assistant has to recognise that "what is at these
    // coordinates" maps to `reverse`. The direction words are the part that makes it selectable.
    const line = toolLine('oshal-uber-rides.js') ?? '';
    expect(line).toMatch(/address/i);
    expect(line).toMatch(/lat|coordinate/i);
  });
});
