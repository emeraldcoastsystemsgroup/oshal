# App docs

Documentation for individual OSHAL applications (the `?app=` bundles) and app migrations.

## Building app packages (the app store)

- [authoring-app-packages.md](./authoring-app-packages.md) — how to author, validate, and
  publish an installable, hot-loadable **app package** (ADR-085): the `oshal-app.yaml`
  definition file, the folder layout, the dependency model, and the `oshal-app` CLI helper
  (`scripts/oshal-app.js` — `init` + `validate` + `build` + `install` + `uninstall`).
- [swarm-store-migration-plan.md](./swarm-store-migration-plan.md) — **PLAN (not yet
  executed):** completing the ADR-085 reset — every remaining baked-in app becomes a store
  package. The 13-class resource ledger (routes/tools/bots/containers/security/tables/…),
  the proven LM playbook, Wave 0 framework gaps (incl. the bot-container model decision),
  and the four migration waves ending with the live-money trading apps.
- [kernel-skills.md](./kernel-skills.md) — **BUILT + CI-enforced (ADR-090 D8):** the ten kernel
  skills are the framework's stable, package-facing API — what an installed app may import and the
  kernel promises to keep. Explains the silent-prune bug class it closes (`tsconfig.server.json`
  excludes `src/features/**`, so a feature core stops importing vanishes from the image and the
  first package that imports it dies at *mount*), the build anchor that pins each skill, the
  manifest `uses:` field, and the guard that fails CI if a skill goes missing.
- [skill-registry.md](./skill-registry.md) — **DERIVED evidence** (regenerate: `node scripts/skill-inventory.js`): every skill, who consumes it, and a *proposed* tier; the app→skill matrix; and the `AppContext` surface that is the de-facto kernel API. Classification decisions live in [ADR-090](../adr/090-skills-as-first-class-packages.md).
- [skill-import.md](./skill-import.md) — **BUILT:** absorb a stranger's Agent-Skills `SKILL.md`
  into a governed, capability-scoped OSHAL bot (persona + manifest) through a security audit gate —
  bundled scripts quarantined, tools translated + minimized, imported inactive for operator review.
  A deterministic, non-interactive codex-packer. Slice `src/features/skill-import/` + CLI
  `scripts/skill-import.ts` + a worked example.
- [examples/](./examples/README.md) — worked example fixtures for app capabilities, including the
  skill-import source skill and generated inactive outputs.

## Per-app folders

- [sat-ops.md](./sat-ops.md) — **BUILT + DEPLOYED (ADR-102):** Sat Ops operator guide —
  `?app=sat-ops` fleet plane (3D orbit console, TLE catalog, conjunction screening, pass
  windows, approve-gated ADCS commands, drafting concierge) and how to run sat nodes
  (RK4 or the NASA 42 referee). The ADCS evidence campaign is **not in this repo** — the generated
  `docs/evidence/` tree is internal-only and refused by `scripts/publish-gate.sh` (ADR-115 / CLAUDE.md
  Rule 0b); the campaign's result is summarised in [sat-ops.md](./sat-ops.md) instead.
- [camera-ops.md](./camera-ops.md) — **BUILT + active:** Camera Ops operator guide —
  `?app=camera` fleet control for the embedded simulator, browser/USB camera preview,
  and real GoPro USB/Wi-Fi/COHN devices through the camera-node heartbeat path, with
  honest fallback messaging for network/cloud adapters that still need provider work.
- [spaces.md](./spaces.md) — **BUILT + active (ADR-111):** Spaces operator guide —
  `?app=spaces` turns a real space into an explorable 3D Gaussian-splat scene. Capture paths
  (video→3DGS via Sim/Edge providers, GPU-free `.ply`/`.splat` import, sim drone scan),
  guided capture (deterministic plan + a live phone HUD with WALK/PAN arrows), and the
  Wi-Fi/RF coverage overlay — plus the honest deferred list. Installed as a swarm-app
  bundle (manifest + `spaces-operator` persona + registered bot), not standalone code.
- [payroll.md](./payroll.md) — **BUILT (ADR-123):** Payroll operator guide — `?app=payroll`
  runs payroll for one company: employees with 2020+ W-4 profiles, pay runs with a deterministic
  engine (no LLM computes a dollar), printable stubs, and quarterly-liability + W-2-preview
  reports. Covers the void-run correction model, the mid-year prior-YTD switch, the tax-year-2026
  OBBBA box-12 TT/TP reporting, and the honest state-coverage table — including which states
  deliberately are NOT shipped and why. Records payroll; moves no money and files nothing.
- [trading/](./trading/README.md) — the trading advisor / autopilot stack.
- [kalshi/](./kalshi/README.md) — the Kalshi prediction-markets edge engine (`?app=kalshi` +
  the Money-group cockpit tile). Includes the honest verdict on the calibration study.
- [little-monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters) — Little Monsters K-12 study app (carved out to the oshal-applications store, ADR-085).
- [portrait-studio](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/portrait-studio) — Portrait Studio (`?app=portrait-studio`, store package, ADR-085): photo → head crop → generated portrait. v1.3.0: 100 profiles × 100 backdrops (business, business casual, slice of life, work environments, history + fantasy, incl. character themes like a pet's face on a human-type body), with interchangeable clothing × hats × props × finishes × framings + grouped pickers; image engine = the media-generation kernel skill (`resolveStoryboardImageProvider`, image-to-image edit, fail-closed — needs the swarm's OpenAI credential or an explicit alternative provider).
- `docs/intelligent-career-automation/` — **not in this repo.** The apply-agent specs and the
  application-form playbook stayed in the private archive when career-hunter carved out (ADR-085 /
  ADR-115); `scripts/publish-gate.sh` refuses the path. The shipped career surfaces live in the
  [career-hunter store package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter).

## App specs & requirements

- [linkedin-ai-content-assistant-requirements.md](./linkedin-ai-content-assistant-requirements.md)
  — LinkedIn content assistant requirements (the full orchestrated flow behind `?app=social`).
- [unreal-mcp-worker-next-steps.md](./unreal-mcp-worker-next-steps.md) — Unreal Engine MCP
  worker (ADR-051) next steps.

## Native-migration plans (legacy standalone apps → native OSHAL)

- [ai-optimize-native-migration-plan.md](./ai-optimize-native-migration-plan.md) — ai-optimize
  (Token Chase race UI, :8799).
- [ai-plan-native-migration-plan.md](./ai-plan-native-migration-plan.md) — ai-plan (HITL project
  planner, :8060).
- [career-hunter-native-migration-plan.md](./career-hunter-native-migration-plan.md) —
  career-hunter (completed reference migration).
