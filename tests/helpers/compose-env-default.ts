/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the value a compose `${NAME:-default}` passthrough hands the process when .env leaves NAME unset or blank. The ADR-052 parity settings TRADING_MARKET_GAP_PCT / TRADING_EXIT_PLAN_SESSIONS are forwarded as `${X:-}`, so an unset value reaches the api as an EMPTY string, not as an absent variable, and a resolver that only handled "absent" read it as 0 (off). Specs take that value from the compose file itself rather than hand-typing '', so the guard follows whatever the compose file actually forwards.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The compose file the local stack (and the api's environment) is built from. */
const COMPOSE_FILE = 'docker-compose.oshal-local.yml';

/**
 * @description The string docker compose substitutes for `NAME` when .env leaves it unset or blank,
 * read from the compose file's own `NAME: ${NAME:-<default>}` passthrough. Compose's `:-` form yields
 * `<default>` for both "unset" and "set to empty", so this is exactly what `process.env.NAME` holds
 * inside the container in that case — for `${NAME:-}`, an empty string. Throws when NAME is not
 * forwarded in that form, or is forwarded with two different defaults, so a spec built on it goes red
 * instead of silently testing a value the deployment never sees.
 * @param name - The environment variable name.
 * @param composeFile - Path to the compose file (default: the repo's docker-compose.oshal-local.yml).
 * @returns The default string compose substitutes for an unset or blank NAME.
 */
export function composeEnvDefault(name: string, composeFile: string = path.resolve(process.cwd(), COMPOSE_FILE)): string {
  const text = fs.readFileSync(composeFile, 'utf8');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^\\s*${esc}:\\s*"?\\$\\{${esc}:-([^}]*)\\}"?\\s*$`, 'gm');
  const defaults = [...text.matchAll(line)].map((m) => m[1]);
  if (defaults.length === 0) throw new Error(`${name} is not forwarded as \${${name}:-...} in ${path.basename(composeFile)}`);
  if (new Set(defaults).size > 1) throw new Error(`${name} is forwarded with conflicting defaults: ${defaults.join(' | ')}`);
  return defaults[0];
}
