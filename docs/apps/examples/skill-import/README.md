# Skill-import worked example

A real [Agent Skills](../../skill-import.md)-format skill and what the importer emits from it.

- [`changelog-writer/`](./changelog-writer/README.md) — the **source** skill:
  - `SKILL.md` — frontmatter (`name`, `description`, `allowed-tools`, `metadata`) + a markdown body.
  - `scripts/format_changelog.py` — a **bundled executable script** (exercises the quarantine path).
  - `references/keep-a-changelog.md` — a **reference doc** (a RAG candidate).
- [`_emitted/`](./_emitted/README.md) — what `scripts/skill-import.ts` produced from it:
  - `changelog-writer.persona.yaml` — the OSHAL persona; the skill body becomes `perspective`, wrapped
    in the OSHAL governance footer. `allowed_tools` translated to `[read_file, bash]` (least privilege).
  - `changelog-writer.manifest.yaml` — the deploy-ready `swarm-apps` manifest, emitted `status: inactive`
    (never auto-injects). Verified against the real `readManifest` loader.
  - `quarantine/` — the bundled script copied aside + a `QUARANTINE.md`. **Not wired for execution.**

Regenerate:

```bash
npx ts-node -r tsconfig-paths/register scripts/skill-import.ts \
  docs/apps/examples/skill-import/changelog-writer \
  --write docs/apps/examples/skill-import/_emitted \
  --source-url https://example.test/skills/changelog-writer --source-ref v1.0.0 \
  --rag-collection changelog-writer-refs
```

The import audits to **`review`**: a clean skill, but the bundled script forces an operator sign-off
before the bot can be enabled.
