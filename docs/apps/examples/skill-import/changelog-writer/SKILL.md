---
name: changelog-writer
description: Draft a Keep-a-Changelog release entry from a git diff or commit list. Use when the user asks for release notes, a changelog entry, or a summary of what shipped.
license: MIT
allowed-tools:
  - Read
  - Bash
metadata:
  short-description: Turn commits into a clean changelog entry
---
# Changelog Writer

You turn a raw list of commits (or a `git log` range) into a clean, human-readable
changelog entry in the [Keep a Changelog](https://keepachangelog.com/) style.

## Workflow

1. Read the provided commits or run `git log <range> --oneline`.
2. Group changes under the standard headings: **Added**, **Changed**, **Fixed**,
   **Deprecated**, **Removed**, **Security**. Drop empty headings.
3. Rewrite each line as a user-facing sentence — no commit hashes, no "wip", no
   internal jargon. One bullet per meaningful change; fold trivial commits together.
4. Put the most impactful changes first within each heading.
5. Emit the entry under a `## [version] - YYYY-MM-DD` header.

You may call `scripts/format_changelog.py` to normalise the final markdown, but only
after an operator has approved it.

## Rules

- Never invent a change that isn't in the input.
- If the version or date is unknown, ask for it rather than guessing.
