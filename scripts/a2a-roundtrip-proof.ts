/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | First-party A2A round-trip proof (ADR-109 / Plan F residual 4). Leg 1 (always, no api / no vendor needed): spawns the standalone tools/a2a-sample-agent (node directly, never npx — the orphaned-grandchild landmine) and drives the REAL outbound A2AHarnessAdapter against it, asserting the computed artifact (sha256, sorted unique tokens containing the injected marker, sorted JSON keys) and the recordCost event built from the agent's own usage numbers — the vendorless outbound smoke path. Leg 2 (--with-inbound, needs a RUNNING api with A2A_GATEWAY_ENABLED=true + an operator PAT): points the SAME outbound adapter at OSHAL's OWN inbound gateway with a freshly minted per-agent credential — message/send files a real ticket, the swarm executes it, tasks/get polls to completed, and the artifact returns through the adapter. Outbound harness and inbound gateway proving each other = the full first-party round trip. Exits non-zero on any failure; never enables the gateway itself.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  A2AHarnessAdapter,
  type A2ACostEvent,
} from '@/features/llm-provider/services/a2a-harness-adapter';
import {
  httpJson,
  loadOperatorPat,
  mintA2aCredential,
  revokeA2aCredential,
} from './lib/a2a-proof-utils';

const EXIT_FAIL = 1;
const EXIT_ENV = 2;

/** @description Parsed CLI configuration for one round-trip run. */
interface RoundtripConfig {
  baseUrl: string;
  token: string | null;
  withInbound: boolean;
  samplePort: number;
  timeoutMin: number;
  jsonOut: string | null;
}

/**
 * @description Parses argv; unknown flags fail loudly.
 * @param argv - process.argv.slice(2).
 * @returns The parsed configuration.
 */
function parseArgs(argv: string[]): RoundtripConfig {
  const cfg: RoundtripConfig = {
    baseUrl: (process.env.OSHAL_API_URL ?? 'http://127.0.0.1:35457').replace(/\/+$/, ''),
    token: null,
    withInbound: false,
    samplePort: 41300 + Math.floor(Math.random() * 500),
    timeoutMin: 20,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else if (arg === '--with-inbound') cfg.withInbound = true;
    else if (arg === '--url') cfg.baseUrl = String(argv[++i] ?? '').replace(/\/+$/, '');
    else if (arg === '--token') cfg.token = String(argv[++i] ?? '').trim() || null;
    else if (arg === '--sample-port') cfg.samplePort = Number(argv[++i]);
    else if (arg === '--timeout-min') cfg.timeoutMin = Number(argv[++i]);
    else if (arg === '--json-out') cfg.jsonOut = String(argv[++i] ?? '') || null;
    else { console.error(`Unknown argument: ${arg} (see --help)`); process.exit(EXIT_ENV); }
  }
  if (!Number.isFinite(cfg.samplePort) || cfg.samplePort <= 0) cfg.samplePort = 41300;
  if (!Number.isFinite(cfg.timeoutMin) || cfg.timeoutMin <= 0) cfg.timeoutMin = 20;
  return cfg;
}

/** Prints CLI usage. */
function printUsage(): void {
  console.log([
    'Usage: npx tsx scripts/a2a-roundtrip-proof.ts [options]',
    '',
    'Leg 1 (always): outbound A2AHarnessAdapter -> spawned tools/a2a-sample-agent — the',
    'vendorless outbound smoke. Leg 2 (--with-inbound): the SAME adapter -> OSHAL\'s own',
    'inbound gateway (mint credential, real ticket, poll to completed) — the full',
    'first-party round trip. Exits non-zero on failure.',
    '',
    'Options:',
    '  --with-inbound       Also run leg 2 (needs running api + A2A_GATEWAY_ENABLED=true + operator PAT)',
    '  --url <base>         API base URL for leg 2 (default http://127.0.0.1:35457, env OSHAL_API_URL)',
    '  --token <pat>        Operator PAT (default: env OSHAL_CLI_TOKEN, then ~/.oshal/config.json)',
    '  --sample-port <n>    Port for the spawned sample agent (default: random 41300-41799)',
    '  --timeout-min <n>    Leg-2 terminal-state deadline in minutes (default 20)',
    '  --json-out <file>    Also write the proof summary JSON to this file',
  ].join('\n'));
}

/** @description Fails the run with a message and exit code. */
function fail(code: number, message: string): never {
  console.error(`\nROUNDTRIP FAILED: ${message}`);
  process.exit(code);
}

/** @description Asserts a condition, failing the proof (exit 1) when false. */
function assertProof(condition: boolean, message: string): void {
  if (!condition) fail(EXIT_FAIL, message);
}

/**
 * @description Spawns the standalone sample agent (node directly — an npx wrapper
 * would orphan the real node grandchild on kill) and waits for its card.
 * @param port - Port to bind.
 * @returns The child process, ready to serve.
 */
async function spawnSampleAgent(port: number): Promise<ChildProcess> {
  const serverPath = path.resolve(process.cwd(), 'tools/a2a-sample-agent/server.js');
  if (!fs.existsSync(serverPath)) fail(EXIT_ENV, `sample agent not found at ${serverPath} — run from the repo root`);
  const child = spawn(process.execPath, [serverPath, '--port', String(port)], { stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      if (res.ok) return child;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); fail(EXIT_ENV, 'sample agent did not become ready within 10s'); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * @description Leg 1 — outbound adapter against the spawned sample agent. Asserts the
 * computed (never echoed) artifact and the cost event built from the agent's own
 * reported usage.
 * @param port - The sample agent's port.
 * @returns The leg summary for the proof output.
 */
async function runOutboundLeg(port: number): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const costEvents: A2ACostEvent[] = [];
  const adapter = new A2AHarnessAdapter({
    endpointUrl: `http://127.0.0.1:${port}/a2a`,
    botKey: 'a2a-sample-agent',
    authToken: 'roundtrip-proof-bearer',
    remoteAgentLabel: 'sample',
    timeoutMs: 15_000,
    pollIntervalMs: 50,
    recordCost: async (event) => { costEvents.push(event); },
  });
  assertProof(await adapter.healthCheck(), 'sample agent healthCheck (well-known card) failed');

  const marker = `roundtrip${Date.now()}`;
  const result = await adapter.run({
    prompt: `Analyze this task and include the token ${marker}. {"beta":2,"alpha":1}`,
    taskId: `roundtrip-outbound-${Date.now()}`,
    agentId: 'a2a-sample-agent',
  });
  const analysis = JSON.parse(result.text) as {
    wordCount: number; uniqueWordCount: number; sha256: string;
    sortedUniqueWords: string[]; jsonTopLevelKeysSorted: string[] | null;
  };
  assertProof(result.model === 'a2a/sample', `unexpected model label: ${result.model}`);
  assertProof(/^[0-9a-f]{64}$/.test(analysis.sha256), 'artifact sha256 is not a 64-char hex digest');
  assertProof(analysis.sortedUniqueWords.includes(marker.toLowerCase()), 'marker did not travel through the remote tokenization');
  assertProof(JSON.stringify(analysis.jsonTopLevelKeysSorted) === '["alpha","beta"]', 'embedded JSON keys did not come back sorted');
  assertProof(costEvents.length === 1, `expected exactly 1 cost event, got ${costEvents.length}`);
  assertProof(costEvents[0].costUnknown === false && costEvents[0].inputTokens === analysis.wordCount
    && costEvents[0].outputTokens === analysis.uniqueWordCount, 'cost event does not match the agent\'s own reported usage');
  console.log(`[leg1] outbound adapter -> sample agent OK (${Date.now() - startMs}ms, sha256 ${analysis.sha256.slice(0, 12)}...)`);
  return {
    passed: true, durationMs: Date.now() - startMs, model: result.model,
    usage: result.usage, totalCostUsd: costEvents[0].totalCost, artifactChars: result.text.length,
  };
}

/**
 * @description Leg 2 — the SAME outbound adapter pointed at OSHAL's own inbound
 * gateway: mint a credential, message/send files a real ticket, the swarm executes,
 * tasks/get polls to completed, the artifact returns through the adapter.
 * @param cfg - Run config.
 * @param pat - Operator PAT.
 * @returns The leg summary for the proof output.
 */
async function runInboundLeg(cfg: RoundtripConfig, pat: string): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const card = await httpJson('GET', `${cfg.baseUrl}/.well-known/agent-card.json`);
  if (card.status === 404) {
    fail(EXIT_ENV, 'inbound gateway is DISABLED (card 404) — enable per docs/evidence/a2a-gateway-2026-07-18.md §6 first (role-gate fix 236589b8 required in the image)');
  }
  assertProof(card.status === 200, `agent card expected 200, got ${card.status}`);
  const minted = await mintA2aCredential(cfg.baseUrl, pat, `a2a-roundtrip-proof-${Date.now()}`);
  if (minted.status === 401 || minted.status === 403) {
    fail(EXIT_ENV, `credential mint rejected (HTTP ${minted.status}) — the PAT must belong to an operator`);
  }
  assertProof(minted.status === 201 && minted.agent !== null, `credential mint failed (HTTP ${minted.status}): ${minted.text.slice(0, 200)}`);

  const costEvents: A2ACostEvent[] = [];
  const adapter = new A2AHarnessAdapter({
    endpointUrl: `${cfg.baseUrl}/api/a2a`,
    authToken: minted.agent!.token,
    remoteAgentLabel: 'oshal-inbound',
    timeoutMs: cfg.timeoutMin * 60_000,
    pollIntervalMs: 3_000,
    maxPollIntervalMs: 10_000,
    recordCost: async (event) => { costEvents.push(event); },
  });
  assertProof(await adapter.healthCheck(), 'inbound gateway healthCheck (well-known card) failed');
  console.log(`[leg2] credential ${minted.agent!.id} minted; dispatching through the outbound adapter (deadline ${cfg.timeoutMin} min)...`);

  let result;
  try {
    const marker = `roundtrip-inbound-${Date.now()}`;
    result = await adapter.run({
      prompt: `In 3-5 plain-text sentences, explain what an A2A (agent-to-agent) gateway does for a multi-agent swarm. Include the token ${marker} verbatim. Reply with text only.`,
      taskId: `roundtrip-inbound-${Date.now()}`,
      agentId: 'a2a-roundtrip-proof',
    });
  } finally {
    const revoked = await revokeA2aCredential(cfg.baseUrl, pat, minted.agent!.id);
    console.log(`[cleanup] credential ${minted.agent!.id} revoke: ${revoked ? 'ok' : 'NOT confirmed'}`);
  }
  assertProof(result.text.trim().length > 0, 'inbound round trip completed but returned no artifact text');
  // OSHAL's tasks/get does not report remote usage metadata — the adapter records an
  // honest costUnknown event. State it rather than hiding it.
  console.log(`[leg2] completed in ${Date.now() - startMs}ms; artifact ${result.text.length} chars; costUnknown=${costEvents[0]?.costUnknown ?? 'n/a'}`);
  return {
    passed: true, durationMs: Date.now() - startMs, model: result.model,
    artifactChars: result.text.length, artifactPreview: result.text.slice(0, 200),
    costUnknown: costEvents[0]?.costUnknown ?? null,
  };
}

/** Entry point. */
async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  console.log(`a2a-roundtrip-proof: leg 1 (outbound -> sample agent on :${cfg.samplePort})${cfg.withInbound ? ` + leg 2 (adapter -> OSHAL inbound at ${cfg.baseUrl})` : ''}`);
  let sample: ChildProcess | undefined;
  const summary: Record<string, unknown> = { proof: 'a2a-first-party-roundtrip', at: new Date().toISOString() };
  try {
    sample = await spawnSampleAgent(cfg.samplePort);
    summary.outboundLeg = await runOutboundLeg(cfg.samplePort);
  } finally {
    if (sample && !sample.killed) sample.kill();
  }
  if (cfg.withInbound) {
    const pat = loadOperatorPat(cfg.token);
    if (!pat) fail(EXIT_ENV, 'leg 2 needs an operator PAT — pass --token, set OSHAL_CLI_TOKEN, or log in with the swarm CLI');
    summary.inboundLeg = await runInboundLeg(cfg, pat);
  }
  summary.passed = true;
  console.log(`\nPROOF-SUMMARY ${JSON.stringify(summary)}`);
  if (cfg.jsonOut) fs.writeFileSync(cfg.jsonOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('\nPROOF PASSED');
}

main().catch((err: unknown) => {
  console.error(`\nROUNDTRIP FAILED (unhandled): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(EXIT_FAIL);
});
