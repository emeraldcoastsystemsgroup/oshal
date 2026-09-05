# User guides

**How to actually use the screens.** Every guide here is written for someone operating the product,
not building it — what the buttons do, what the columns mean, and what a screen is *not* doing when
it looks like nothing is happening.

These are **as-built**: they describe the software as it exists today. Where a feature is switched
off by default or needs an operator to enable it, the guide says so and names the switch. Design
rationale lives in the [ADRs](../adr/README.md); the builder-facing documentation starts at
[docs/README.md](../README.md).

## Start here

New to the cockpit? Open **`/cockpit/`**. The left ribbon is the app you are in; the icons are the
screens that app contributes. `/cockpit/?app=<name>` opens the cockpit focused on a single app, and
the URL is authoritative — bookmark it and you land in the same place every time.

## I want to…

| I want to… | Guide |
|---|---|
| Ask for something in plain language and let the swarm route it | [Jarvis](./jarvis.md) |
| Talk directly to a specific bot | [Swarm Messages](./swarm-messages.md) |
| Ask for work and follow it through to a result | [Tickets](./tickets.md) |
| Understand the alerts queue, and why rows sit there | [Intelligent Processing](./intelligent-processing.md) |
| Connect an account (Google, LinkedIn, a provider key) | [Cloud — connections and providers](./cloud-and-connections.md) |
| See every account I've connected, and fix an expired one | [Identity Hub](./identity-hub.md) |
| Find where my files live and where new ones get saved | [Files](./files.md) |
| See my schedule and the work planned against it | [Calendar](./calendar.md) |
| Spend less on model calls without losing quality | [Optimizer (Token Chase)](./optimizer.md) |
| Test how a bot behaves before trusting it | [AI Test Lab](./ai-test-lab.md) |
| Compare graded runs over time | [Eval Wall](./eval-wall.md) |
| Check the security posture of my install | [Security Center](./security-center.md) |
| Reach infrastructure and stored secrets (operator) | [DevOps + Vault](./devops-vault.md) |
| Change my theme, provider, model, or notifications | [Settings](./settings.md) |
| Search my data, trace a run's cost, set a budget, export or delete my data, or rescue a stuck ticket | [Platform tools](./platform-tools.md) |
| Put oshal on my desktop, phone, or TV | [Get oshal on your devices](./devices.md) |

## Guides that live with their app

Some screens ship as installable app packages and keep their guide beside the code:

- [Workflow Studio](../workflow-studio.md) — author a workflow on a canvas, then publish it as a real queue.
- [Spaces](../apps/spaces.md), [Sat Ops](../apps/sat-ops.md), [Camera Ops](../apps/camera-ops.md), [Payroll](../apps/payroll.md) — per-app operator guides.
- [Little Monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/little-monsters) — ships its own user guide, installation, and support docs in the package.

## Two things worth knowing before you start

**Nothing leaves the building without you.** Anything that posts, sends, pays, or changes a system
outside your install asks for an explicit confirmation first, and the automated versions of those
actions are off until an operator turns them on. Where a guide covers such a feature, it names the
switch that governs it.

**Your data is yours.** Reads are scoped to your own account. Where a screen looks empty, the usual
cause is that you have not connected the account it reads from — not that the feature is broken.
Each guide's *If something looks wrong* section covers the confusions specific to that screen.

## Writing a new guide

Follow [sat-ops.md](../apps/sat-ops.md) — how to reach it, then the panels in the order they appear,
then what the screen does *not* do, then the confusions a real user will hit. Read the implementation
before you write, name only controls that exist, and never hand-type a count that a generator owns.
