/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for hardening.md #15/#16: the staged hardened Headscale ACL must stay APPLY-READY (real user agentmesh not the the operator@ placeholder, no :5000 placeholder ports, no allow-all src:["*"] rule) and must stay in lockstep with the ports the edge agent actually dials (start-local-agent.bat *_URL lines) — the 2026-07-24 diagnosis found the staged policy would have bricked the edge agent because policy and script contradicted each other. Also goes red if a plaintext hskey-auth pre-auth key is ever re-committed to start-local-agent.bat (the original #16 leak shape), and if the enrollment helper loses its ephemeral/tagged/single-use key properties.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const POLICY_PATH = join(REPO_ROOT, 'infra/headscale/config/policy.hardened.hujson');
const EDGE_AGENT_PATH = join(REPO_ROOT, 'scripts/start-local-agent.bat');
const ENROLL_HELPER_PATH = join(REPO_ROOT, 'scripts/headscale-enroll-worker.sh');

/** Shape of the parsed hardened ACL policy (the subset this guard inspects). */
interface HeadscalePolicy {
  tagOwners: Record<string, string[]>;
  acls: Array<{ action: string; src: string[]; dst: string[] }>;
  ssh: unknown[];
}

/**
 * @description Parse the HuJSON policy file: strip // line comments and trailing
 * commas (both legal in HuJSON, both fatal to JSON.parse), then parse strictly.
 * @returns The parsed policy object.
 */
function loadPolicy(): HeadscalePolicy {
  const raw = readFileSync(POLICY_PATH, 'utf8');
  const noComments = raw.replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(noTrailingCommas) as HeadscalePolicy;
}

/**
 * @description Extract every infra port the edge agent dials over the tailnet
 * from start-local-agent.bat's `set *_URL=...%SWARM_VPN_IP%:<port>...` lines.
 * @returns Distinct port numbers the hardened ACL must keep worker-reachable.
 */
function edgeAgentDialedPorts(): string[] {
  const bat = readFileSync(EDGE_AGENT_PATH, 'utf8');
  const ports = new Set<string>();
  for (const m of bat.matchAll(/^set\s+\w*_URL=\S*%SWARM_VPN_IP%:(\d+)/gim) as Iterable<RegExpMatchArray>) {
    ports.add(m[1]);
  }
  return [...ports];
}

describe('headscale hardened ACL stays apply-ready (hardening.md #15)', () => {
  it('parses as HuJSON and has the expected top-level shape', () => {
    const policy = loadPolicy();
    expect(policy.tagOwners).toBeDefined();
    expect(Array.isArray(policy.acls)).toBe(true);
    expect(policy.acls.length).toBeGreaterThan(0);
  });

  it('has no the operator@ placeholder tagOwner — the real mesh user is agentmesh', () => {
    const policy = loadPolicy();
    for (const [tag, owners] of Object.entries(policy.tagOwners)) {
      expect(owners, `tagOwner for ${tag}`).not.toContain('the operator@');
      expect(owners, `tagOwner for ${tag}`).toContain('agentmesh@');
    }
  });

  it('has no :5000 placeholder port in any dst (controller API publishes 35457 on the host)', () => {
    const policy = loadPolicy();
    for (const rule of policy.acls) {
      for (const dst of rule.dst) {
        expect(dst, `dst in rule src=${JSON.stringify(rule.src)}`).not.toMatch(/:5000$/);
      }
    }
  });

  it('contains no allow-all src:["*"] rule (deny-by-default means only tagged sources)', () => {
    const policy = loadPolicy();
    for (const rule of policy.acls) {
      expect(rule.src, `rule dst=${JSON.stringify(rule.dst)}`).not.toContain('*');
    }
  });

  it('workers can reach the controller API port 35457', () => {
    const policy = loadPolicy();
    const workerDsts = policy.acls
      .filter((r) => r.action === 'accept' && r.src.includes('tag:worker'))
      .flatMap((r) => r.dst);
    expect(workerDsts).toContain('tag:controller:35457');
  });

  it('every infra port the edge agent dials over the VPN is worker-reachable in the policy', () => {
    // Drift lock: if start-local-agent.bat starts dialing a new datastore port (or the
    // policy drops one it still dials), applying the policy bricks the edge agent.
    const policy = loadPolicy();
    const workerDsts = policy.acls
      .filter((r) => r.action === 'accept' && r.src.includes('tag:worker'))
      .flatMap((r) => r.dst);
    const dialed = edgeAgentDialedPorts();
    expect(dialed.length, 'edge agent *_URL port extraction must find the VPN-dialed ports').toBeGreaterThan(0);
    for (const port of dialed) {
      expect(workerDsts, `edge agent dials :${port} over the VPN`).toContain(`tag:controller:${port}`);
    }
  });

  it('does not reference the never-built /api/vpn/enroll route', () => {
    const raw = readFileSync(POLICY_PATH, 'utf8');
    expect(raw).not.toContain('/api/vpn/enroll');
  });
});

describe('pre-auth key hygiene (hardening.md #16)', () => {
  it('start-local-agent.bat contains no plaintext hskey-auth pre-auth key', () => {
    // The original leak shape: a live `hskey-auth-<base64ish>` literal committed to the
    // launcher. The docs example `hskey-auth-...` (literal dots) is fine; any real key
    // material after the prefix is not.
    const bat = readFileSync(EDGE_AGENT_PATH, 'utf8');
    expect(bat).not.toMatch(/hskey-auth-[A-Za-z0-9]/);
  });

  it('start-local-agent.bat reads the key from env or the user keyfile and points at the enrollment helper', () => {
    const bat = readFileSync(EDGE_AGENT_PATH, 'utf8');
    expect(bat).toContain('.oshal-headscale-authkey');
    expect(bat).toMatch(/if "%HEADSCALE_AUTHKEY%"==""/);
    expect(bat).toContain('headscale-enroll-worker.sh');
  });

  it('the enrollment helper mints single-use ephemeral keys pre-tagged tag:worker', () => {
    const sh = readFileSync(ENROLL_HELPER_PATH, 'utf8');
    expect(sh).toContain('--ephemeral');
    expect(sh).toMatch(/--tags\s+"\$WORKER_TAG"/);
    expect(sh).toContain('WORKER_TAG="tag:worker"');
    // Single-use: the helper must never mint a reusable worker key.
    expect(sh).not.toMatch(/^\s*--reusable/m);
  });
});
