# Legacy product-name disposition

The product name is **oshal**, written lowercase in user-facing copy. Exactly two forms are
sanctioned: **oshal**, and **open swarm oshal** — "open swarm" never stands alone. Existing
technical identifiers keep their forms. The rule and its date are in
[CLAUDE.md](../../CLAUDE.md) "Naming" (operator directive 2026-07-24).

This page is the disposition register for the retired-name occurrences that remain in the tree:
what was rewritten, what is retained as historical evidence, and why. It is the closing record for
the "Legacy product-name archival disposition" item removed from [the backlog](../BACKLOG.md).

## The rule that was applied

Four classes, decided per occurrence rather than by a blanket rewrite.

1. **Infrastructure identifier — keep.** `oswarm.ai`, `site/oswarm.ai/`, the `oswarm-ai` Pages
   project, `scripts/release/openswarm-sync.sh` and the forward-sync flow named after it,
   `Install-OpenSwarm.bat`, `installer/Open-Swarm-Node.cmd`. These are addresses and filenames, not
   the product name; CLAUDE.md grandfathers identifiers explicitly, and renaming one breaks an
   install, a DNS record, or a runbook.
2. **Acronym expansion attached to the mark — keep.** "OSHAL — Open Swarm Harness Agent LLM" and
   "oshal (Open Swarm Harness Agent LLM)" gloss the acronym with the mark present, so the phrase is
   not standing alone. CLAUDE.md's own opening line uses this form; so do the wordmark, the
   whitepaper masthead, the overview deck, the OCI image label and the npm description.
3. **Standalone use in current copy — rewrite.** Anywhere a reader would reasonably take
   "Open Swarm" for today's product name.
4. **Standalone use in a historical record — mark, do not rewrite.** An archived completion
   narrative, a superseded draft, or a CHANGE LOG entry records what something was called at the
   time. Rewriting it falsifies the record, so the containing document carries an explicit
   historical-naming note instead. This is the option the backlog item's own done-when allowed.

## Rewritten (class 3)

| File | Was |
|---|---|
| `README.md` | title read "oshal — Open Swarm" |
| `.env.example` | "to try Open Swarm" |
| `INSTALL.md` | "Open Swarm can run its own Headscale" |
| `docs/channels/telegram.md` | "your Open Swarm assistant" |
| `docs/security/SECURITY-POSTURE.md` | "the OSHAL / Open Swarm harness" |
| `docs/business/competitive-claims-honest.md` | five standalone uses in the claim rows and notes |
| [`site/oswarm.ai/README.md`](../../site/oswarm.ai/README.md) | its Naming bullet still instructed editors that the brand was "Open Swarm" and the brand domain `oswarm.ai` — current guidance that contradicted the directive |
| `site/oswarm.ai/index.html` | an "open swarm" chip on the live page |
| `packages/oshal-vids-operator/RECAP-SOP.md` | spoken line "I work with the open swarm" |
| [`installer/install.ps1`](../../installer/install.ps1) | the graphical installer's window title, "Open Swarm - Install" — the first words on a fresh Windows box |
| [`installer/lib/common.ps1`](../../installer/lib/common.ps1) | the join-code refusal ("Not an Open Swarm join code") and the busy-port doctor row ("If that is an older Open Swarm this install reuses it") |
| [`installer/lib/install-node.ps1`](../../installer/lib/install-node.ps1) | the checkout-folder hint, the shortcut description, "look for the Open Swarm window", and the Desktop/Startup shortcut name "Open Swarm Node" |
| [`installer/lib/install-swarm.ps1`](../../installer/lib/install-swarm.ps1) | the cockpit firewall rule's display name, "Open Swarm cockpit (\<port\>)" |
| [`installer/Open-Swarm-Node.cmd`](../../installer/Open-Swarm-Node.cmd) | the launcher's console title (the FILENAME is class 1 and keeps its form) |
| [`src/app/routes/chat-channel-routes.ts`](../../src/app/routes/chat-channel-routes.ts) | both replies an unlinked Telegram chat receives: "an Open Swarm account" and "Welcome to Open Swarm" |

## Generated artifacts — the generator was fixed, not the output

[`scripts/site-oshal-report.js`](../../scripts/site-oshal-report.js) composed the weekly report's
lede as "a weekly, numbers-first status on the Open Swarm build" and the pipeline republishes that
page, so a hand-edit of the artifact would have reverted on the next run. Fixed at the source and
recorded in the file's CHANGE LOG (SEQ 4). Its sibling
[`scripts/site-lab-report.js`](../../scripts/site-lab-report.js) had already taken the same fix in
its own CHANGE LOG (SEQ 2).

No other generator in the tree emits a retired form: `build_oshal_deck.py` and the wordmark emit the
class-2 attached expansion, and `scripts/copyright-deposit.js` emits the sanctioned
"oshal (open swarm oshal)".

## Retained as historical (class 4)

| Where | What it is | How it is marked |
|---|---|---|
| [`docs/backlog/archive/`](../backlog/archive/README.md) | two standalone uses inside resolved-item completion narratives | a naming note at the top of the directory README, covering every file in it |
| [`demo/trading-appliance/01-product-spec.md`](../../demo/trading-appliance/01-product-spec.md) | a superseded buyer-facing draft titled "OpenSwarm TradeBox" | a historical banner under the title; its sibling README already framed it as "kept as-authored" |
| `any-bot/server/**` (7 files) | CHANGE LOG entries recording the pre-OSS rebrand of a legacy agent identity and namespace onto the neutral OSHAL namespace | each entry already names it as *legacy*, in quotes, in the past tense, inside the append-only change log — the house format's own record of a removal. This register deliberately does not repeat that name |
| `scripts/site-oshal-report.js`, `scripts/site-lab-report.js` | the retired form quoted inside a CHANGE LOG entry describing its own removal | same: a change log is the record of the change |
| [`installer/Open-Swarm-Node.cmd`](../../installer/Open-Swarm-Node.cmd) | the launcher's first CHANGE LOG entry, written when the product still carried that name | same: rewriting it would falsify the record. The guard over this file strips `REM`/`::` comments, so the entry neither trips it nor satisfies it |

The legacy agent identity above survives in change-log prose only. No live identifier, image tag,
container name, route, persona or user-facing string carries it, and nothing in the tree matches the
operator identifier list enforced by `scripts/publish-gate.sh`.

## The two that were identities, not just copy (class 3, with an upgrade path)

Two of the installer rows above were never only wording. Windows matches a firewall rule by its
**DisplayName** and a shortcut by its **filename**, so on a machine installed before the rename
those are identities that machine already carries. Changing the string alone would have left an
upgraded box with two rules opening the cockpit port and two shortcuts to the same launcher — one
of each still advertising the retired name, and the duplicate in the Startup folder launching the
node a second time at every sign-in.

**Decision (operator, 2026-09-20): rename in place on upgrade.** The installer looks the old
firewall rule and the old `.lnk` up once, removes them, then creates the oshal-named ones, so an
upgraded box ends with exactly one of each and no dual-name lookup survives past that migration.
The alternative considered and rejected was leaving existing installs alone and using the new names
only on fresh ones, which would have left the retired name visible on every box already in service.

Those two lookups — `$legacyRuleName` in `install-swarm.ps1` and `$legacyShortcutName` in
`install-node.ps1` — are the only places in the installer that still know the old name, and each is
consumed by a removal rather than merely declared.

## What keeps this closed

- [`tests/unit/installer-scripts-parse.spec.ts`](../../tests/unit/installer-scripts-parse.spec.ts)
  scans every installer script a Windows user runs and fails on the standalone form, permitting it
  only on a `$legacy…` assignment; a second case asserts the upgrade actually removes the old
  firewall rule and the old shortcut, from the Desktop **and** the Startup folder, before the
  oshal-named ones are created.
- [`tests/unit/node-installer.spec.ts`](../../tests/unit/node-installer.spec.ts) covers the strings a
  route composes: the rendered one-click node installer, and the two Telegram replies.
- The shared rule lives in
  [`tests/helpers/retired-product-name.ts`](../../tests/helpers/retired-product-name.ts). It matches
  the space-separated display form only, so the class-1 filenames cannot trip it, and excludes the
  class-2 attached expansion and the attached mark by lookahead rather than by allowlist.
