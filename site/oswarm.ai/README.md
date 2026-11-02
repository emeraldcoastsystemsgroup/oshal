# Open Swarm public website

Public brand: **Open Swarm**. Canonical domain: **https://oswarm.ai**.
**https://oshal.ai** serves the same release. OSHAL remains the internal/local
software name. These directions reflect the operator's October 2026 rebrand.

The current website source is in the sibling kernel checkout:
`../../../../oshal-kernel/marketing_videos/v2/oswarm_site/` (relative to this directory).
Read that directory's `README.txt` for building, previewing, and publishing.
It contains 72 content pages, a 47-film library, 250 feature explanations, and
widescreen/vertical players with captions, chapter links, and downloads.

Publish through the existing entry point from this repository root:

```bash
bash scripts/deploy-oswarm-site.sh
```

The entry point delegates to the curated launch source. Override
`OSWARM_SITE_SOURCE` if that checkout lives elsewhere. It fails closed when the
source is unavailable; it must not fall back to the retired site generator.
Publication uses the existing Cloudflare Pages project `oswarm-ai`, then checks
page hashes, media delivery, and both custom domains. A Git push does not deploy.

The HTML, catalog generators, and assets retained in this directory are legacy
source, preserved for reference. They are not the deployed October launch and
must not overwrite it. The prior README and deployment script were preserved in
`oswarm_site/review/legacy-publish-backup/` before this handover.

Public claims must follow the application evidence and provider availability.
Do not imply all connectors are configured, unrestricted autonomy, universal
model compatibility, or privacy when external processing/storage is selected.
