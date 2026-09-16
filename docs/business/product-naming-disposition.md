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

The legacy agent identity above survives in change-log prose only. No live identifier, image tag,
container name, route, persona or user-facing string carries it, and nothing in the tree matches the
operator identifier list enforced by `scripts/publish-gate.sh`.

## Out of scope here

Product-code strings still using the standalone form — the installer's window title, desktop
shortcut and firewall rule, and two Telegram reply strings — are shipped user-facing behaviour
rather than docs or evidence, and renaming a shortcut or a firewall rule is an installer change with
its own proof obligations. They are filed as their own backlog item.
