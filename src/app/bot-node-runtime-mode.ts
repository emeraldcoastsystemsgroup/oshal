/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add a fail-closed interactive-only bot-node mode for DB-less managed Jarvis/Sales nodes so they serve signed HTTP turns without bidding for or consuming Redis queue work.
 */

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * @description Resolves the explicit HTTP-only node posture. Invalid nonblank values throw so a
 * production typo cannot silently re-enable background mesh consumption.
 * @param env - Bot-node environment.
 * @returns True when the node must not subscribe, bid, or consume Redis work envelopes.
 */
export function isBotNodeInteractiveOnly(env: RuntimeEnvironment = process.env): boolean {
  const value = String(env.BOT_NODE_INTERACTIVE_ONLY ?? '').trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0' || value === 'off' || value === 'no') {
    return false;
  }
  if (value === 'true' || value === '1' || value === 'on' || value === 'yes') {
    return true;
  }
  throw new Error('BOT_NODE_INTERACTIVE_ONLY must be true or false');
}
