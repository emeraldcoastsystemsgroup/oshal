/**
 * Connector Token Broker — controller-side, per-request short-lived token provision.
 *
 * Security model (the "token broker" fix): bots run codex with danger-full-access, so
 * a compromised/injected swarm that has SESSION_SECRET could read oshal_connections and
 * decrypt EVERY user's Gmail/X/LinkedIn tokens. To remove that capability, the bot must
 * stop needing the key. This module is the controller side of that: at dispatch time the
 * controller (which legitimately holds SESSION_SECRET + the pg pool) decrypts ONLY the
 * caller's own access token(s) and hands them to the bot as short-lived, single-user
 * values. The bot writes them into its per-request workspace as `.oshal-cred-<provider>`
 * files and uses them directly — no DB decryption, no SESSION_SECRET dependency.
 *
 * Best-effort by design: if a provider isn't connected (or can't be refreshed) we simply
 * omit that cred and the bot's tool falls back to its existing DB-decrypt path. Threaded
 * alongside OSHAL_USER_SUB through the same `creds`/`extraEnv` channel the user-scoping
 * file write already uses, so it works for both the remote any-bot path (user-scoping.js)
 * and the in-controller harness path (base-cli-harness-adapter.ts).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial token broker: resolveBotCreds() decrypts the caller's google/twitter access tokens (via getValidAccessToken) into an env-key map (OSHAL_CRED_GOOGLE/OSHAL_CRED_TWITTER) the bot dispatch threads to the per-request workspace as .oshal-cred-* files. Additive — bots keep the DB-decrypt fallback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add 'twilio' → OSHAL_CRED_TWILIO: the user's pasted "SID:AuthToken" secret brokered to the communications-bot for its phone/text leg (scripts/oshal-twilio.js).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add 'outlook' → OSHAL_CRED_OUTLOOK: the caller's Microsoft Graph access token brokered to the communications-bot for its M365 mail leg (scripts/oshal-outlook.js) — ADR-037 provider parity with Gmail, so the bot reads/sends Outlook mail without SESSION_SECRET.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Add 'plaid' → OSHAL_CRED_PLAID: the caller's Plaid Link access token (now a hub connector, not the app-private oshal_finance_items store) brokered to the finance bot's ADR-083 read-only fallback (scripts/oshal-plaid.js). The Finance controller decrypts server-side directly; this covers the bot-shell-out path.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Multi-account-per-provider (ADR-113 section 4): resolveBotCreds accepts an optional per-provider ConnectionSelector so a caller/app can broker a NAMED account ("work email") instead of always getting the resolved default, and logs at WARN when a provider has several accounts and no selector was given — the ambiguity is now visible in the log instead of being decided silently by resolution order. Default behaviour with no selectors is unchanged (the marked default).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Consult per-user connector enablement (BACKLOG.md:2718): before resolving each provider's token, skip any provider the caller has EXPLICITLY disabled for themselves (oshal_connector_user_enablement, enabled=false) so a user-disabled connector is never brokered even if a credential exists. Default-allow + FAIL-OPEN — absence of an override, or any read error, leaves every provider brokerable, so no existing flow regresses.
 *
 * @module connector-token-broker
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { readConnectorUserDisabledProviders } from '@/app/connectors/runtime/user-enablement-store';
import { getValidAccessToken } from './connectors-routes';
import { connectionCount, type ConnectionSelector } from './connector-tenancy';

const logger = createChildLogger({ module: 'connector-token-broker' });

/**
 * @description Provider → env-key the bot workspace writer maps to a `.oshal-cred-<provider>`
 * file. Keep in sync with user-scoping.js (remote path) + base-cli-harness-adapter.ts
 * (in-controller path) which read these keys, and with the tool scripts that prefer the file.
 */
const CRED_ENV_KEYS: Record<string, string> = {
  google: 'OSHAL_CRED_GOOGLE',
  // Email swarm (ADR-037): the Microsoft Graph access token for the caller's own
  // M365 mailbox, refreshed first when needed, brokered to the communications-bot
  // so scripts/oshal-outlook.js works without the bot holding SESSION_SECRET.
  outlook: 'OSHAL_CRED_OUTLOOK',
  twitter: 'OSHAL_CRED_TWITTER',
  // Smart-home: the SmartThings OAuth access token, refreshed first when needed,
  // then brokered to the home-bot without exposing DB/SESSION_SECRET.
  smartthings: 'OSHAL_CRED_SMARTTHINGS',
  // Cloud/DevOps: the GCP OAuth access token brokered to cloud-ops-bot so its
  // gcp tools (scripts/oshal-gcp.js + the private scripts/oshal-gcp-diag.js
  // diagnostics) work without the bot holding SESSION_SECRET.
  gcp: 'OSHAL_CRED_GCP',
  // Shopping: the operator's Walmart I/O affiliate credential brokered to the
  // shopping-concierge so scripts/oshal-walmart.js can search + build carts.
  walmart: 'OSHAL_CRED_WALMART',
  // Food delivery: the operator's optional Uber Eats affiliate/marketing config
  // brokered to the eats-concierge so scripts/oshal-uber.js can search + build the
  // order deep link (the deep link itself works with or without the cred).
  uber: 'OSHAL_CRED_UBER',
  // Transportation: the operator's optional Uber Rides config brokered to the
  // rides-concierge so scripts/oshal-uber-rides.js can build the ride deep link.
  'uber-rides': 'OSHAL_CRED_UBER_RIDES',
  // Music: the user's Spotify access token, refreshed first when needed, brokered to the
  // spotify-concierge for any bot-side Web API tool (the surface routes call Spotify directly).
  spotify: 'OSHAL_CRED_SPOTIFY',
  // Media: the operator's TMDB API key brokered to the movies-concierge for any bot-side
  // discovery tool (the surface routes call TMDB directly via getOperatorTmdbKey).
  tmdb: 'OSHAL_CRED_TMDB',
  // Travel: the traveller's/operator's Duffel access token brokered to the travel-concierge
  // so scripts/oshal-duffel.js can run real flight search (else the DUFFEL_ACCESS_TOKEN env).
  duffel: 'OSHAL_CRED_DUFFEL',
  // Phone + text: the user's own Twilio "AccountSid:AuthToken" combined secret brokered to
  // the communications-bot so scripts/oshal-twilio.js can read messages/calls and (confirm-
  // gated) send SMS / place calls on THEIR Twilio account — BYO, never a platform key.
  twilio: 'OSHAL_CRED_TWILIO',
  // Prediction markets: the user's Kalshi "keyId:privateKeyPem" combined secret (every Kalshi
  // request is RSA-PSS signed — there is no bearer token) for portfolio reads and, later,
  // confirm-gated order placement on THEIR Kalshi account — BYO, never a platform key.
  kalshi: 'OSHAL_CRED_KALSHI',
  // Finnhub: the user's own market-data API key (BYO), brokered to the trading bot's tools for
  // earnings-surprise reads that feed the fundamental event overlay — never a platform key.
  finnhub: 'OSHAL_CRED_FINNHUB',
  // Finance (Plaid): the caller's linked-bank access token brokered to the finance bot's ADR-083
  // read-only fallback (scripts/oshal-plaid.js on its own node) so it can read balances/holdings/
  // transactions without SESSION_SECRET. The Finance controller path decrypts server-side directly;
  // this is only for the bot-shell-out fallback. NB: a user may hold MANY plaid Items (one token
  // each) — getValidAccessToken returns the default/first; the controller enumerates all rows.
  plaid: 'OSHAL_CRED_PLAID',
};

/**
 * @description Resolve the caller's decrypted, refreshed-if-needed access tokens for the
 * providers a bot may use, as an env-key map to thread into the bot's per-request workspace.
 * The controller decrypts here (it holds SESSION_SECRET); the bot never needs the key.
 *
 * Best-effort: a provider that isn't connected or can't be refreshed is silently skipped —
 * the bot's tool then falls back to its DB-decrypt path. Never throws; a broker failure must
 * not break the dispatch (the request still carries OSHAL_USER_SUB).
 *
 * @param pool - the Postgres pool (holds oshal_connections).
 * @param userSub - the authenticated caller's OIDC sub. No-op (returns {}) if absent.
 * @param providers - providers to resolve tokens for (default: google + twitter).
 * @param selectors - optional per-provider account selector for the multi-account case (ADR-113
 *   section 4). A user may hold two accounts of one provider; pass `{ google: { label: 'work' } }`
 *   to broker a NAMED one. Omitted → the account the user marked default (deterministic). A
 *   selector that matches nothing resolves to no token for that provider, so a bot fails visibly
 *   rather than acting on the wrong mailbox.
 * @returns a map of env keys (OSHAL_CRED_GOOGLE/OSHAL_CRED_TWITTER) → raw access token. Empty if none resolvable.
 */
export async function resolveBotCreds(
  pool: unknown,
  userSub: string | undefined,
  providers: string[] = ['google', 'twitter'],
  selectors: Record<string, ConnectionSelector> = {},
): Promise<Record<string, string>> {
  if (!userSub) return {};
  // Per-user enablement OVERRIDE (BACKLOG.md:2718): a connector the caller has EXPLICITLY disabled
  // for themselves must not be brokered even if a credential exists. Fail-open by contract — the
  // store read defaults to allow-all on absence/error, so this can never break dispatch.
  const disabledProviders = await readConnectorUserDisabledProviders(pool as Pool, userSub);
  const creds: Record<string, string> = {};
  await Promise.all(
    providers.map(async (provider) => {
      const envKey = CRED_ENV_KEYS[provider];
      if (!envKey) return;
      if (disabledProviders.has(provider)) {
        logger.info({ provider, userSub }, 'token broker: connector disabled for this user — not brokering (per-user enablement)');
        return;
      }
      try {
        const selector = selectors[provider];
        if (!selector) {
          // Multi-account ambiguity must be VISIBLE. Resolution is deterministic (the marked
          // default), but a bot brokered one of several accounts without being told which — that is
          // worth a log line, not silence.
          const accounts = await connectionCount(pool, userSub, provider).catch(() => 1);
          if (accounts > 1) {
            logger.warn({ provider, userSub, accounts }, 'token broker: several accounts for this provider and no selector — brokering the marked default');
          }
        }
        const token = await getValidAccessToken(pool, userSub, provider, selector);
        if (token) creds[envKey] = token;
      } catch (err) {
        // Best-effort: a refresh/decrypt failure for one provider must not break dispatch.
        logger.warn({ err, provider }, 'token broker: could not resolve cred (bot falls back to DB path)');
      }
    }),
  );
  return creds;
}
