# Importing Agent-Skills markdown skills

**Status: BUILT 2026-07-11.** Absorb a stranger's [Agent Skills](https://keepachangelog.com/)-format
`SKILL.md` into a governed, capability-scoped OSHAL bot — the persona + `swarm-apps` manifest shape
the app store (ADR-085) already loads. The importer is a **deterministic, non-interactive
[codex-packer](../../ai-lab/bot-personas/codex-packer.yaml)**: instead of interviewing an operator it
reads the skill and emits the same two artifacts, run through a security audit gate.

> **Why this is a security feature, not just a compat feature.** Public skill marketplaces have shipped
> supply-chain malware. The importer never blind-executes a skill: bundled scripts are **quarantined**,
> declared tools are **translated and minimized** (never copied 1:1), and every imported skill lands as
> an **inactive** manifest an operator must review and flip live. The pitch: *run your skills inside a
> sandbox with RLS, cost caps, least-privilege tools, and approval gates.*

## What it maps

| SKILL.md source | → | OSHAL target |
|---|---|---|
| frontmatter `name` | → | persona `name` + a deterministic `agent_id` (`b0000000-…`) + manifest `name`/`ticketType` |
| frontmatter `description` | → | persona `selector_descriptor` + mined `routing_keywords` (the ADR-083 router signal) |
| markdown **body** | → | persona `perspective` (the system prompt), wrapped in an OSHAL governance footer |
| frontmatter `allowed-tools` + inline `mcp__*` | → | **translated** to OSHAL tool ids, minimized; unmapped/foreign tools recorded, **not granted** |
| bundled `scripts/` | → | **quarantined** — copied aside, never wired for execution |
| bundled `references/` | → | RAG collection (`<slug>-refs`; `--ingest-refs` POSTs them to `/api/rag/ingest`) |
| `license` / `metadata` | → | persona + manifest `source` provenance |

The emitted `perspective` is the skill body **verbatim** under an `## Imported skill instructions`
heading, followed by an `## OSHAL governance` footer that binds the foreign skill to the quality gate
(Mode B on uncertainty, citation rules, the exact granted-tools list, an explicit "these foreign tools
were NOT granted" line, the quarantined-scripts notice, and `DRY_RUN=true` side-effect defaults).

## The security audit gate

Every import is graded (mirrors the connector [`auditSpec`](../../src/app/connectors/runtime/catalog-audit.ts)
→ marketplace `installState` quarantine rails):

- **`blocked`** — an error (no/invalid `name`, no `description`, empty body). **No artifacts are emitted.**
- **`review`** — passes, but has warnings (bundled scripts, foreign `mcp__*` tools, no "use when" clause,
  unknown frontmatter keys). Emitted, but an operator must sign off before enabling.
- **`clean`** — passes with no warnings. Safe to enable after a glance.

`allowed_tools` never emits the empty array (OSHAL reads `[]` as *"don't narrow the grant"* — unrestricted).
When nothing maps, the persona gets a minimal read-only grant (`[read_file]`).

## Usage

```bash
# Dry-run — parse, audit, print the verdict (no files written):
npx ts-node -r tsconfig-paths/register scripts/skill-import.ts <skill-dir-or-SKILL.md>

# Stage deploy-ready artifacts under an output dir:
npx ts-node -r tsconfig-paths/register scripts/skill-import.ts <skill-dir> \
  --write ./imported/<slug> \
  --source-url https://example.com/skills/<slug> --source-ref v1.0.0 \
  --rag-collection <slug>-refs

# Machine-readable result:
npx ts-node -r tsconfig-paths/register scripts/skill-import.ts <skill-dir> --json

# Also ingest the skill's references/ into its RAG collection (<slug>-refs):
npx ts-node -r tsconfig-paths/register scripts/skill-import.ts <skill-dir> \
  --ingest-refs --api http://127.0.0.1:35457 --token oshal_pat_...
```

`--ingest-refs` POSTs each `references/` doc to `/api/rag/ingest` (a `requiresAuth` route — supply a
personal access token via `--token` or `OSHAL_CLI_TOKEN`, from `swarm-cli login`). Each doc is stamped
with a `skill:<slug>/<file>` `doc_id` so a citation is traceable to the imported third-party skill (the
same provenance discipline as `web:`-prefixed content). Empty docs are dropped; a doc that fails to
ingest is reported per-line and the CLI exits 3. It never runs the bundled `scripts/` — only text refs.

`--write` stages `<slug>.persona.yaml`, `<slug>.manifest.yaml`, and — if the skill bundled scripts —
a `quarantine/` folder (the scripts + a `QUARANTINE.md`). A **blocked** skill writes nothing and exits 2.

## Deploy (operator, after reviewing the audit)

1. Copy `<slug>.persona.yaml` → `ai-lab/bot-personas/<slug>.yaml`.
2. Copy `<slug>.manifest.yaml` → `deployed-apps/<slug>.yaml` (workspace, survives restart) or `swarm-apps/`.
3. Flip the manifest `status: inactive` → `active`, then inject via **Bot Forge** or
   `POST /api/swarm/apps/load` (the same dynamic-load path the app store uses). The bot goes live at
   `?app=<slug>`; tickets of type `<slug>` route to it.

## Worked example

[`examples/skill-import/changelog-writer/`](./examples/skill-import/changelog-writer/) is a real
Agent-Skills skill (frontmatter + body + a bundled `scripts/format_changelog.py` + a `references/` doc).
Importing it produces [`examples/skill-import/_emitted/`](./examples/skill-import/): a governance-wrapped
persona, an **inactive** deploy-ready manifest (verified against the real `readManifest` loader), and the
quarantined script. It audits to **`review`** — clean skill, but the bundled script forces operator sign-off.

## Implementation

Architecture rationale + non-goals: [ADR-089](../adr/089-skill-import-adapter.md).

- Pure core (no fs/network, fully unit-tested): [`src/features/skill-import/`](../../src/features/skill-import/)
  — `parseSkillMd` · `translateTools` · `auditSkill` · `mapSkillToPersona`/`mapSkillToManifest` · `importSkill`.
- CLI (fs wrapper, reuses `serializeManifest` from the swarm-apps barrel):
  [`scripts/skill-import.ts`](../../scripts/skill-import.ts).
- Tests: `tests/unit/skill-import-{parser,audit,mapper}.spec.ts` (31 cases).

## Remaining

- ~~Wire the `references/` → RAG ingest step~~ **DONE** — `--ingest-refs` (pure payload builders in
  [`skill-rag.ts`](../../src/features/skill-import/services/skill-rag.ts), unit-tested; the CLI POSTs
  them). The successful-ingest path needs a live PAT; the build + auth-handling path is proven end-to-end.
- A cockpit "Import a skill" surface over the CLI (drop a folder → audit report → one-click stage).
- Translate more foreign tool vocabularies (Claude/Codex covered; add others as skills are absorbed).
