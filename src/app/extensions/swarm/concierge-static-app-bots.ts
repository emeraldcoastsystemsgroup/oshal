/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: the reviewed list of application concierges that core ALSO defines in a static registry. The concierge node (#1101) serves only package-governed inline app bots, so these eleven (live check 2026-10-06: Spaces answered 422 NO_HOSTED_BRAIN for the operator while seven package-governed concierges answered on Antigravity) stayed on the hosted-only inline path. Each one here is a store package's concierge that its package also declares, runs controller-inline (container oshal-api, no requiresOwnNode) and is not a kernel identity. Naming them is deliberate: a static or core bot reaches the concierge only by being listed here in a reviewed change, never by a package re-declaring its id.
 */

/**
 * Store-package concierges whose agent id is also a static registry entry, by agent id. A bot here
 * qualifies for the concierge node only while an installed package declares it in its `bots:` block (controller:
 * inline-app-bots.ts) and an installed application owns it (node: bot-node-served-agents.ts). Kernel
 * identities must never appear here; tests/unit/concierge-static-app-bots.spec.ts pins that.
 */
export const CONCIERGE_STATIC_APP_BOT_IDS: ReadonlySet<string> = new Set([
  'b0200000-0000-0000-0000-000000000001', // camera-operator (camera)
  'b00f0000-0000-0000-0000-000000000001', // drone-operator (drone)
  'b0102000-0000-0000-0000-000000000001', // sat-operator (sat-ops)
  'b0300000-0000-0000-0000-000000000001', // spaces-operator (spaces)
  'a0000000-0000-0000-0000-000000000054', // pumpkin-bot (pumpkin)
  'b00d0000-0000-0000-0000-000000000001', // world-analyst (world)
  'b00e0000-0000-0000-0000-000000000001', // vids-operator (creative-studio, vids, daily-trade-recap)
  'fd000000-0000-0000-0000-000000000001', // feeds-curator (feeds)
  'b0000000-0000-0000-0000-000000000040', // capture-specialist (federal-capture, gov-contracting)
  'b0000000-0000-0000-0000-000000000041', // capture-coordinator (capture-crm)
  'a0000000-0000-0000-0000-000000000052', // screenplay-writer (video)
]);
