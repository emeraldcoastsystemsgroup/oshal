# ADR-089: Skill-import adapter — absorb Agent-Skills markdown skills into governed OSHAL bots

**Status:** Accepted — BUILT 2026-07-11
**Relates to:** ADR-038 (apps bundled by type / the packer shape), ADR-085 (remote app packages & dynamic loading), ADR-083 (call-out routing / selector discipline), ADR-065 (connector catalog audit gate)

## Context

The [Agent Skills](https://www.anthropic.com/news/skills) format — a folder with a `SKILL.md`
(YAML frontmatter `name`/`description`/`allowed-tools` + a markdown body of instructions), plus
optional bundled `scripts/`, `references/`, and `assets/` — has become a common way to package a
single-purpose agent capability. Public skill marketplaces already exist, and one shipped a
supply-chain malware incident (~12% of a marketplace's skills). The operator's instinct: *"take md
files into our bots and absorb the thing through integration"* — ride the ecosystem instead of
fighting it, and turn the security story into a feature: *run a stranger's skill inside a governed
sandbox with RLS, cost caps, least-privilege tools, and approval gates.*

OSHAL already has the exact target shape. [codex-packer](../../ai-lab/bot-personas/codex-packer.yaml)
**interviews** an operator and emits a single-purpose bot as two artifacts — a **persona YAML**
(`perspective` block = the system prompt) and a **`swarm-apps` manifest** (ticketType + one worker
bot) — which ADR-085's loader turns into a live, routable bot via `POST /api/swarm/apps/load` or the
Bot Forge inject gate. An imported skill is structurally the same thing, minus the interview.

The naïve import is dangerous: copy `allowed-tools` verbatim (grants foreign, unscoped capabilities),
run bundled scripts (blind-executes untrusted code), or emit an `active` manifest (auto-injects an
unreviewed bot into everyone's swarm). Each of those is a rejected non-goal.

## Decision

A **skill-import adapter** — a deterministic, non-interactive codex-packer. It parses a `SKILL.md`,
runs it through a security audit gate, and (only if not blocked) emits the same persona + manifest
the packer does. It is a **pure** feature slice ([src/features/skill-import/](../../src/features/skill-import/));
all filesystem/network I/O lives in the CLI wrapper ([scripts/skill-import.ts](../../scripts/skill-import.ts)).

### 1. The mapping (skill → OSHAL)

- frontmatter `name` → persona `name` + a **deterministic** `agent_id` (sha256 of the slug under the
  reserved `b0000000-` imported-bot prefix, so re-import is idempotent and never collides with the registry).
- frontmatter `description` → persona `selector_descriptor` + mined `routing_keywords` (the ADR-083
  router signal — omitting these makes the seeder dump the whole perspective and mis-route).
- markdown **body** → persona `perspective`, verbatim under an `## Imported skill instructions`
  heading, followed by an `## OSHAL governance` footer (Mode B on uncertainty, citation rules, the
  exact granted-tools list, an explicit "these foreign tools were NOT granted" line, the
  quarantined-scripts notice, and `DRY_RUN=true` side-effect defaults). **This footer is where the
  governed-sandbox promise is realised** — the foreign instructions are bound to the quality gate.
- The manifest is one worker bot on a one-and-done `incident-rca` workflow, `ticketType` = the slug.

### 2. The security audit gate (mirrors the connector audit → quarantine rails)

Every import is graded like a connector spec ([catalog-audit.ts](../../src/app/connectors/runtime/catalog-audit.ts) `auditSpec` → marketplace `installState`):

- **`blocked`** — an error (no/invalid `name`, no `description`, empty body). **No artifacts emitted.**
- **`review`** — passes but has warnings (bundled scripts, foreign `mcp__*` tools, unknown frontmatter
  keys, no "use when" clause). Emitted, but an operator must sign off before enabling.
- **`clean`** — passes with no warnings.

Three hard safety rules:

- **Bundled `scripts/` are quarantined** — copied aside into a `quarantine/` folder with a
  `QUARANTINE.md`, **never wired for execution**. Blind-executing untrusted code is the non-goal.
- **Tools are translated + minimized, never copied.** Source tool names (`Bash`, `Read`, `mcp__*`)
  map to the OSHAL tool registry's ids (`bash`, `read_file`, …); anything with no mapping — every
  foreign MCP tool — is **recorded and not granted**. An empty grant degrades to a minimal read-only
  set (`[read_file]`), never the empty array (which OSHAL reads as *"don't narrow the grant"* — unrestricted).
- **Emitted manifests are `status: inactive`.** An import never auto-injects; the operator reviews the
  audit and flips it live through the same ADR-085 load path the app store uses.

### 3. Non-goals

Not a runtime that executes skills natively; not a live marketplace/registry (that is ADR-085's
store); not an auto-installer. The adapter produces reviewable artifacts and stops.

## Consequences

- **Positive:** the ecosystem's skills become governed OSHAL bots for the cost of a transform — no new
  runtime, no new database, no new service. The security posture (quarantine + least-privilege + review
  gate) is an honest, differentiating feature, not a compat afterthought. Reuses the packer/ADR-085
  rails end-to-end (the emitted manifest was verified against the real `readManifest` loader).
- **Negative / limits:** the RAG-ingest of bundled `references/` is named in the manifest but not yet
  auto-run (a separate `POST /api/rag/ingest`); only the Claude/Codex tool vocabulary is translated so
  far; there is no cockpit "import a skill" surface yet (CLI only). These are tracked follow-ups.
- **Reversible:** a new, self-contained slice + one CLI + docs; nothing in the core load path changed.

## As-built

- Slice: [src/features/skill-import/](../../src/features/skill-import/) — `parseSkillMd` · `translateTools`
  · `auditSkill` · `mapSkillToPersona`/`mapSkillToManifest` · `importSkill`. 31 unit tests
  (`tests/unit/skill-import-{parser,audit,mapper}.spec.ts`), tsc clean.
- CLI: [scripts/skill-import.ts](../../scripts/skill-import.ts) (reuses `serializeManifest`).
- Doc: [docs/apps/skill-import.md](../apps/skill-import.md); worked example
  [docs/apps/examples/skill-import/](../apps/examples/skill-import/).
- Commit `2a4a668b`.
