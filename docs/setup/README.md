# Setup Guides

This folder holds local setup guides for bots and runtime surfaces.

These are the docs that should be linked from agent metadata and shown in config/admin flows.

## Current Guides

- [google-bot-runtime-setup.md](./google-bot-runtime-setup.md)
  - Google Workspace CLI runtime, OAuth flow, required APIs, and smoke tests
- [swarm-agent-connector-onboarding.md](./swarm-agent-connector-onboarding.md)
  - reusable process for creating provider OAuth apps, wiring OSHAL connectors, and attaching swarm agents to connected accounts
- [agent-factory-runtime-setup.md](./agent-factory-runtime-setup.md)
  - how agent-factory should create deployable agents, register them, and attach setup guides
- [core-setup.md](./core-setup.md)
  - core local stack setup
- [mac-install.md](./mac-install.md)
  - macOS install path
- [factory-config-guide-smoke-bot-setup.md](./factory-config-guide-smoke-bot-setup.md)
  - the configGuide smoke-bot: proves a factory-created agent surfaces its setup guide
- [operator-connector-action-list.md](./operator-connector-action-list.md)
  - dated operator action list for connector credentials (point-in-time; archive when done)

## Standard

For any tool-backed or externally-configured agent, add:

1. a local guide in `docs/setup/`
2. a `configGuide` entry in the factory spec or `config_guide` entry in persona YAML
3. smoke-test commands
4. explicit runtime/config/auth expectations
