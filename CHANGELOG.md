# Changelog

All notable changes to oshal are documented in this file, as sequential
releases. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Application authorization foundation: imported schemas, per-user/function policy, Access
  Administration, typed Jarvis tools, execution guards and proof-bound local administrator setup.
  Source checkpoint: `3f04ce73`; 178 tests in 15 AI Test Lab-registered suites passed locally.
- Installed application smoke registration, themed-domain connector callback handling and trusted
  multi-store installation controls. Deployment remains separate from source verification.

## 1

Initial public release: the swarm controller + bot-node runtime, the harness
framework (cline, codex-cli, claude-code, gemini-cli, a2a, noop), the cockpit,
the app-manifest framework, connectors, RAG, and the graph extension.
