# oswarm.ai — production website

Source for the public Open Swarm product site — live at **https://oswarm.ai** and
**https://oshal.ai** (both apexes serve the same build).

- `index.html` — the entire site: self-contained (inline CSS/JS, no build step, no external
  requests, no webfonts). Deployable to any static host — Cloudflare Pages / `wrangler`,
  GitHub Pages, or an nginx container.
- `product/` and `platform/` — the product site: **~70 fully generated pages**, one URL per thing.
  A catalog hub, a page per shelf, **a page per application**, a platform hub and a page per
  platform topic. Same self-contained rules as `index.html` (CSS inlined into every page — a linked
  stylesheet that failed to stage would render all seventy unstyled).

  **Every file in those two directories is generated. Do not hand-edit any of them** — your change
  is overwritten on the next deploy, and `tests/unit/site-product-pages.spec.ts` goes red. To change
  something, edit the source and re-run the generator:

  ```bash
  node scripts/site-product-pages.js          # rewrite the trees (also PRUNES delisted apps)
  node scripts/site-product-pages.js --check  # exit 1 if the committed pages are stale or orphaned
  ```

  | To change | Edit |
  |---|---|
  | Application copy, screens, capabilities | The app's own manifest — kernel `swarm-apps/*.yaml`, or the store package's `oshal-app.yaml` |
  | Shelf names, taglines, which shelves exist | `SHELVES` in `scripts/lib/product-site/catalog.js` |
  | Platform page prose | `scripts/lib/product-site/platform-content.js` |
  | Layout, CSS, page shell | `scripts/lib/product-site/theme.js` / `render.js` |

  Counts are read off the tree and substituted into prose through `%token%`, so no number is ever
  typed. If the sibling store trunk is not checked out the generator warns and leaves the committed
  pages alone rather than publishing a site with 47 application pages missing — point it elsewhere
  with `OSHAL_STORE_DIR`.
- `assets/` — real cockpit screenshots copied from the evidence captures
  (`docs/evidence/cockpit-foreground-capture-2026-06-23/`). Refresh them from newer
  evidence captures after major cockpit changes — never stage or mock screenshots.
- Brand tokens follow `docs/assets/oshal/visual-identity.md` (Night `#0B1020`, Runtime Cyan
  `#7DD3FC`, Mesh Green `#34D399`), carried forward into the Open Swarm rebrand.
- Content rules: this is an MIT open-source project site — **no pricing, no sales funnel**.
  Capability claims are split into "Shipped" vs "On the roadmap"; keep that split honest
  when editing (see the `/built-vs-roadmap` section). If the page and the repo disagree,
  the repo wins.
- Naming: brand is **Open Swarm** (wordmark `openswarm`), domain oswarm.ai. Internal
  jargon (bot-node, OSHAL) stays out of user-facing copy except in the architecture diagram
  where it is explained.
- The `#requests` section is the public front door for application/core requests and defects. Keep
  its repository links, prerelease-access notice, security-reporting warning, and release-close
  policy synchronized with `docs/operations/requests-and-defects.md`.

## Deploying

```bash
bash scripts/deploy-oswarm-site.sh
```

Deploys to the Cloudflare Pages project **`oswarm-ai`** (live at https://oswarm-ai.pages.dev).
The script stages a clean public dir (`index.html` + `assets/` only — this README never ships),
runs `wrangler pages deploy`, then **verifies prod serves the page and both screenshots before
reporting success**.

- **Deploy is from the WORKING TREE — a `git push` does not publish.** Same rule as agenticfederal.us.
- Screenshots in `assets/` are real captures copied from `docs/evidence/`. Refresh them from a newer
  evidence capture after major cockpit changes — never stage or mock a screenshot.
- **Custom domain state (verified 2026-07-10):** BOTH `oswarm.ai` and `oshal.ai` are LIVE — each
  apex returns HTTP 200 (`curl -sI https://oswarm.ai/` and `curl -sI https://oshal.ai/`), both
  attached to the `oswarm-ai` Pages project and serving the SAME build. The operator owns both domains.
  `www.` hosts are NOT configured (e.g. `www.oshal.ai` does not resolve) — apex only. The deploy
  script's hash gate verifies against `oswarm-ai.pages.dev`; every attached custom domain serves that
  same build, so no per-domain re-verify is needed.
- **The brand domain is `oswarm.ai`, NOT `openswarm.ai`** — openswarm.ai sits on atom.com
  marketplace nameservers (someone else's / parked), and openswarm.com is a live competitor.
  `oswarm` is the distinctive mark; don't chase the longer names.
