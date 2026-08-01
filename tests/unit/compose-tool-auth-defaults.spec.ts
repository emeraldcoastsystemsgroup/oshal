/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K8 guard (BACKLOG kernel audit 2026-07-29): the swarm-wide tool-auth posture is OFF (cliTools.js also defaults off), but the compose shared bot env defaulted TOOL_AUTH_GOOGLE_SEARCH to auto — the one externally-reaching tool lane open by default: a prompt-to-external-vendor path with no approval gate, and a third LLM vendor in a customer's DPA inventory. This spec pins every externally-reaching lane to -off} in x-bot-env, pins the two deliberate auto exceptions (plane/chroma — in-stack services, no external vendor), and asserts the ONLY hard per-service escalation in the whole compose file is self-healing-bot's TOOL_AUTH_DOCKER_SOCKET (matched to its mounted socket) inside a profile-gated service that a default bring-up never starts.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');

/** The shared bot env anchor: from `x-bot-env:` to the first top-level `services:` key. */
function sharedBotEnv(): string {
  const start = compose.indexOf('x-bot-env:');
  const end = compose.indexOf('\nservices:');
  expect(start, 'x-bot-env anchor missing').toBeGreaterThanOrEqual(0);
  return compose.slice(start, end === -1 ? undefined : end);
}

describe('K8: tool-auth defaults match the swarm-wide OFF posture', () => {
  it('every externally-reaching tool lane defaults OFF in the shared bot env', () => {
    const env = sharedBotEnv();
    for (const name of [
      'TOOL_AUTH_AWS_CLI', 'TOOL_AUTH_KUBECTL', 'TOOL_AUTH_GCLOUD',
      'TOOL_AUTH_DOCKER_SOCKET', 'TOOL_AUTH_GOOGLE_SEARCH',
    ]) {
      expect(env, `${name} must default off — it reaches outside the stack`).toMatch(
        new RegExp(`${name}: \\$\\{${name}:-off\\}`),
      );
    }
  });

  it('pins the two deliberate auto exceptions: plane + chroma resolve to IN-STACK services', () => {
    // Changing either to off (breaks in-stack tooling) or adding a third auto lane
    // (opens a new default path) must both be deliberate acts that update this spec.
    const env = sharedBotEnv();
    expect(env).toMatch(/TOOL_AUTH_PLANE_MCP: \$\{TOOL_AUTH_PLANE_MCP:-auto\}/);
    expect(env).toMatch(/TOOL_AUTH_CHROMA_MCP: \$\{TOOL_AUTH_CHROMA_MCP:-auto\}/);
    const autoDefaults = env.match(/TOOL_AUTH_[A-Z_]+: \$\{TOOL_AUTH_[A-Z_]+:-auto\}/g) ?? [];
    expect(autoDefaults.length, 'a NEW tool-auth lane defaults auto — the off posture is the rule (K8)').toBe(2);
  });

  it("the ONLY hard per-service escalation is self-healing-bot's docker-socket, inside a profile-gated service", () => {
    // Hard overrides are literal values (not ${...:-} interpolations). Exactly one may exist.
    const hard = compose.match(/TOOL_AUTH_[A-Z_]+: "(auto|ask)"/g) ?? [];
    expect(hard, 'unexpected hard tool-auth escalation — every new one is a new host/vendor reach').toEqual([
      'TOOL_AUTH_DOCKER_SOCKET: "auto"',
    ]);
    // And it lives in the self-healing-bot service, which is profile-gated (never in a
    // default `compose up`): the service block declares profiles before the override.
    const svcStart = compose.indexOf('\n  self-healing-bot:');
    expect(svcStart, 'self-healing-bot service missing').toBeGreaterThanOrEqual(0);
    const after = compose.slice(svcStart + 1);
    const next = after.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\r?\n/);
    const block = next === -1 ? after : after.slice(0, next + 1);
    expect(block).toMatch(/profiles:\s*\r?\n\s*- incident/);
    expect(block).toContain('TOOL_AUTH_DOCKER_SOCKET: "auto"');
  });
});
