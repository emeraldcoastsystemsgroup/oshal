# docs/k8

This directory contains Kubernetes-focused operating documentation for the OSHAL project.

## Available Documents

- `any-bot-kubernetes-setup.md` — detailed setup guide for the `any-bot-k8s` workspace, including the new setup script flow, required secrets, render/apply steps, and validation commands.
- `HANDOVER.md` — current handoff state for the Kubernetes documentation module.

## Recommended Starting Point

If you want to deploy the new any-bot stack, start here:

1. Read `any-bot-kubernetes-setup.md`
2. Copy `any-bot-k8s/setup.env.example` to your own env file
3. Run `npm run k8:install:any-bot -- --env-file any-bot-k8s/setup.env`

The script renders a ready-to-apply manifest bundle under `output/k8/any-bot/`, can optionally apply it when your `kubectl` context is connected to a real cluster, and targets the converted OSHAL root runtime built from the repository-root `Dockerfile`.

If you want to hand the installer to another computer **without publishing anywhere**, build a local tarball with:

```bash
npm run k8:pack:any-bot
```

If you prefer a Docker-based installer instead of npm install, build a local installer image with:

```bash
npm run k8:docker:installer:build
```