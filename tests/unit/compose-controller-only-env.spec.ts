/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the controller-only environment keys against the RESOLVED compose, not its source text. OSHAL_STORE_TOKEN was added to the x-bot-env anchor, which merges into the api and all 38 bot-nodes, so a repository read credential reached every bot - and bots are this project's confirmed prompt-injection surface. A source-text guard could not have caught it: a key under the anchor and a key on a service block look identical to a regex, and the whole defect is WHERE the key sits. js-yaml resolves the `<<:` merge, so this asserts what each container would actually receive. The bot floor is what stops it passing vacuously if the services are ever renamed out from under it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const COMPOSE = join(process.cwd(), 'docker-compose.oshal-local.yml');

type Service = { environment?: Record<string, unknown> };

/** The merge key is resolved by the PARSER, which is the point — this is the effective env. */
function services(): Record<string, Service> {
  const doc = yaml.load(readFileSync(COMPOSE, 'utf8')) as { services?: Record<string, Service> };
  return doc.services ?? {};
}

function holdersOf(key: string): string[] {
  return Object.entries(services())
    .filter(([, svc]) => svc?.environment && key in svc.environment)
    .map(([name]) => name)
    .sort();
}

/** Credentials whose every reader is controller-side. A bot has no use for these. */
const CONTROLLER_ONLY = [
  'OSHAL_STORE_TOKEN',
  'OSHAL_DELEGATION_SIGNING_PRIVATE_KEY',
  'OSHAL_CONNECTOR_TOKEN_MASTER_KEY',
];

describe('controller-only credentials never reach a bot container', () => {
  it('the fixture is not vacuous — the anchor really does expand into many bots', () => {
    const all = services();
    const bots = Object.entries(all).filter(([, s]) => s?.environment?.BOT_RUNTIME === 'bot-node');
    expect(bots.length, 'no bot-node services found — the parse or the file shape changed')
      .toBeGreaterThanOrEqual(30);
    // A bot inherits the anchor, so it must carry MANY keys. If this is small the merge did not
    // resolve and every assertion below would pass for the wrong reason.
    expect(Object.keys(bots[0][1].environment ?? {}).length, 'the <<: merge did not resolve')
      .toBeGreaterThan(50);
  });

  it('no bot-node carries a controller-only credential', () => {
    for (const key of CONTROLLER_ONLY) {
      const holders = holdersOf(key);
      const bots = holders.filter((name) => name !== 'oshal-api');
      expect(bots, `${key} reached ${bots.length} non-api service(s) — it belongs on oshal-api only`)
        .toEqual([]);
    }
  });

  it('the store token is still wired to the api, so the guard is not just asserting absence', () => {
    // Removing it everywhere would satisfy the case above and break the store. It must be present
    // on exactly the one service that reads it.
    expect(holdersOf('OSHAL_STORE_TOKEN')).toEqual(['oshal-api']);
  });
});
