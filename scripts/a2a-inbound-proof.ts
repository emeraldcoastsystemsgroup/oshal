/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Inbound A2A → COMPLETED-ticket proof harness (ADR-109 / Plan F residual). The 2026-07-18 gate only reached status=approved / tasks/get=submitted on a throwaway DB; this script proves the FULL lifecycle against a RUNNING api: operator PAT (from ~/.oshal/config.json, the swarm-cli login) mints a per-agent credential over /api/a2a/agents, then AS THE FOREIGN AGENT sends a real JSON-RPC message/send and polls tasks/get until the ticket reaches a TERMINAL spec state, asserting 'completed' + a non-empty artifact. Prints a structured proof summary (ticket id, states traversed, timing) for docs/evidence/a2a-inbound-completed-TEMPLATE.md and exits non-zero on any failure. --dry-run validates everything runnable while the gateway is still DISABLED (health, 404 posture, PAT, mint+revoke) without sending any task. This script never enables the gateway and never touches deployment state.
 */

import fs from 'node:fs';
import process from 'node:process';
import {
  httpJson as http,
  loadOperatorPat,
  mintA2aCredential,
  revokeA2aCredential,
  rpcEnvelope as rpc,
  type ProofHttpResult as HttpResult,
} from './lib/a2a-proof-utils';

/** Spec task states after which the swarm will do no further work on the ticket. */
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);
/** Exit codes: 0 pass, 1 proof failed, 2 environment/config not runnable. */
const EXIT_FAIL = 1;
const EXIT_ENV = 2;

/** @description Parsed CLI configuration for one proof run. */
interface ProofConfig {
  baseUrl: string;
  token: string | null;
  dryRun: boolean;
  timeoutMin: number;
  pollSeconds: number;
  keepCredential: boolean;
  jsonOut: string | null;
}

/** @description One observed ticket-state transition with its wall-clock timestamp. */
interface StateStep { state: string; at: string }

/**
 * @description Parses argv into the proof configuration. Unknown flags fail loudly so a
 * typo never silently runs the wrong mode.
 * @param argv - process.argv.slice(2).
 * @returns The parsed configuration.
 */
function parseArgs(argv: string[]): ProofConfig {
  const cfg: ProofConfig = {
    baseUrl: (process.env.OSHAL_API_URL ?? 'http://127.0.0.1:35457').replace(/\/+$/, ''),
    token: process.env.OSHAL_CLI_TOKEN?.trim() || null,
    dryRun: false,
    timeoutMin: 20,
    pollSeconds: 5,
    keepCredential: false,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else if (arg === '--dry-run') cfg.dryRun = true;
    else if (arg === '--keep-credential') cfg.keepCredential = true;
    else if (arg === '--url') cfg.baseUrl = String(argv[++i] ?? '').replace(/\/+$/, '');
    else if (arg === '--token') cfg.token = String(argv[++i] ?? '').trim() || null;
    else if (arg === '--timeout-min') cfg.timeoutMin = Number(argv[++i]);
    else if (arg === '--poll-seconds') cfg.pollSeconds = Number(argv[++i]);
    else if (arg === '--json-out') cfg.jsonOut = String(argv[++i] ?? '') || null;
    else { console.error(`Unknown argument: ${arg} (see --help)`); process.exit(EXIT_ENV); }
  }
  if (!cfg.baseUrl) { console.error('--url must not be empty'); process.exit(EXIT_ENV); }
  if (!Number.isFinite(cfg.timeoutMin) || cfg.timeoutMin <= 0) cfg.timeoutMin = 20;
  if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds <= 0) cfg.pollSeconds = 5;
  return cfg;
}

/** Prints CLI usage. */
function printUsage(): void {
  console.log([
    'Usage: npx tsx scripts/a2a-inbound-proof.ts [options]',
    '',
    'Proves the inbound A2A gateway end-to-end: mint credential -> message/send -> poll',
    'tasks/get to a TERMINAL state -> assert completed + artifact. Exits non-zero on failure.',
    '',
    'Options:',
    '  --url <base>         API base URL (default http://127.0.0.1:35457, env OSHAL_API_URL)',
    '  --token <pat>        Operator PAT (default: env OSHAL_CLI_TOKEN, then',
    '                       ~/.oshal/config.json contexts[currentContext].token)',
    '  --dry-run            Validate against a DISABLED gateway: health, 404 posture,',
    '                       PAT load, credential mint+revoke. Sends no task.',
    '  --timeout-min <n>    Terminal-state deadline in minutes (default 20)',
    '  --poll-seconds <n>   tasks/get poll interval in seconds (default 5)',
    '  --keep-credential    Skip the post-run credential revoke (default: revoke)',
    '  --json-out <file>    Also write the proof summary JSON to this file',
  ].join('\n'));
}

/** @description Fails the run with a message and exit code. */
function fail(code: number, message: string): never {
  console.error(`\nPROOF FAILED: ${message}`);
  process.exit(code);
}

/** @description Asserts a condition, failing the proof (exit 1) when false. */
function assertProof(condition: boolean, message: string): void {
  if (!condition) fail(EXIT_FAIL, message);
}

/**
 * @description Mints one per-agent credential through the operator management API,
 * mapping authz rejections to the environment exit code.
 * @param cfg - Run config.
 * @param pat - Operator PAT.
 * @param name - Credential display name.
 * @returns The minted agent {id, token, scopes}.
 */
async function mintCredential(
  cfg: ProofConfig, pat: string, name: string,
): Promise<{ id: string; token: string; scopes: string[] }> {
  const res = await mintA2aCredential(cfg.baseUrl, pat, name);
  if (res.status === 401 || res.status === 403) {
    fail(EXIT_ENV, `credential mint rejected (HTTP ${res.status}) — the PAT must belong to an OPERATOR (OSHAL_OPERATOR_EMAILS/SUBS). Body: ${res.text.slice(0, 200)}`);
  }
  if (res.status !== 201) fail(EXIT_FAIL, `credential mint expected 201, got ${res.status}: ${res.text.slice(0, 300)}`);
  assertProof(res.agent !== null, 'mint response missing agent.id/agent.token');
  assertProof(res.agent!.token.startsWith('oshal_a2a_'), `minted token has wrong prefix: ${res.agent!.token.slice(0, 12)}...`);
  console.log(`[mint] credential ${res.agent!.id} (${name}) minted, scopes: ${res.agent!.scopes.join(', ')}`);
  return res.agent!;
}

/**
 * @description Revokes a minted credential (best-effort cleanup; a failed revoke is
 * reported but never converts a passed proof into a failure).
 * @param cfg - Run config.
 * @param pat - Operator PAT.
 * @param agentId - Credential id to revoke.
 * @returns True when the API confirmed the revoke.
 */
async function revokeCredential(cfg: ProofConfig, pat: string, agentId: string): Promise<boolean> {
  const revoked = await revokeA2aCredential(cfg.baseUrl, pat, agentId);
  console.log(`[cleanup] credential ${agentId} revoke: ${revoked ? 'ok' : 'NOT confirmed'}`);
  return revoked;
}

/**
 * @description Polls tasks/get until the ticket reaches a terminal spec state or the
 * deadline passes, recording every observed state transition. Tolerates up to three
 * consecutive transport errors before failing.
 * @param cfg - Run config.
 * @param agentToken - The foreign agent's bearer token.
 * @param ticketId - The task/ticket id returned by message/send.
 * @param firstState - The state message/send reported (seed of the trace).
 * @returns The state trace, final task object, and poll count.
 */
async function pollToTerminal(
  cfg: ProofConfig, agentToken: string, ticketId: string, firstState: string,
): Promise<{ states: StateStep[]; finalTask: Record<string, unknown>; polls: number }> {
  const deadline = Date.now() + cfg.timeoutMin * 60_000;
  const states: StateStep[] = [{ state: firstState, at: new Date().toISOString() }];
  let consecutiveErrors = 0;
  let polls = 0;
  for (;;) {
    if (Date.now() > deadline) {
      fail(EXIT_FAIL, `ticket ${ticketId} did not reach a terminal state within ${cfg.timeoutMin} min — last state '${states[states.length - 1].state}' (trace: ${states.map((s) => s.state).join(' -> ')})`);
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollSeconds * 1000));
    polls += 1;
    let res: HttpResult;
    try {
      res = await http('POST', `${cfg.baseUrl}/api/a2a`, { Authorization: `Bearer ${agentToken}` }, rpc('tasks/get', { id: ticketId }, 100 + polls));
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) fail(EXIT_FAIL, `tasks/get failed 3x consecutively: ${(err as Error).message}`);
      continue;
    }
    assertProof(res.status === 200, `tasks/get expected HTTP 200, got ${res.status}: ${res.text.slice(0, 300)}`);
    const body = res.body as { result?: Record<string, unknown>; error?: { code: number; message: string } };
    if (body.error) fail(EXIT_FAIL, `tasks/get returned RPC error ${body.error.code}: ${body.error.message}`);
    const state = String((body.result?.status as { state?: string } | undefined)?.state ?? '');
    if (state && state !== states[states.length - 1].state) {
      states.push({ state, at: new Date().toISOString() });
      console.log(`[poll ${polls}] state -> ${state}`);
    }
    if (TERMINAL_STATES.has(state)) return { states, finalTask: body.result!, polls };
  }
}

/**
 * @description Dry-run against a DISABLED gateway: proves everything the full run
 * needs except the enabled surface — health, default-off 404 posture on card + RPC,
 * PAT loadability, and the credential mint+revoke path (available while disabled by
 * design). Sends no task and leaves no live credential behind.
 * @param cfg - Run config.
 * @param pat - Operator PAT.
 */
async function runDry(cfg: ProofConfig, pat: string): Promise<void> {
  const health = await http('GET', `${cfg.baseUrl}/api/health`);
  assertProof(health.status === 200, `/api/health expected 200, got ${health.status}`);
  const card = await http('GET', `${cfg.baseUrl}/.well-known/agent-card.json`);
  const enabled = card.status === 200;
  console.log(`[dry-run] health 200; agent card ${card.status} (gateway ${enabled ? 'ENABLED' : 'disabled — default-off posture intact'})`);
  if (!enabled) {
    const rpcProbe = await http('POST', `${cfg.baseUrl}/api/a2a`, { Authorization: 'Bearer oshal_a2a_bogus' }, rpc('tasks/get', { id: 'x' }, 1));
    assertProof(rpcProbe.status === 404, `disabled gateway must 404 the RPC endpoint, got ${rpcProbe.status}`);
  }
  const minted = await mintCredential(cfg, pat, `a2a-inbound-proof-dryrun-${Date.now()}`);
  const revoked = await revokeCredential(cfg, pat, minted.id);
  assertProof(revoked, 'dry-run credential revoke was not confirmed');
  const summary = {
    proof: 'a2a-inbound-dry-run', passed: true, baseUrl: cfg.baseUrl, gatewayEnabled: enabled,
    patSource: cfg.token ? 'flag/env' : '~/.oshal/config.json', mintPath: 'ok', revokePath: 'ok',
    at: new Date().toISOString(),
  };
  emitSummary(cfg, summary);
}

/**
 * @description The full proof: mint -> card -> message/send -> poll to terminal ->
 * assert completed + artifact -> summary. Exits non-zero on any failed assertion.
 * @param cfg - Run config.
 * @param pat - Operator PAT.
 */
async function runFull(cfg: ProofConfig, pat: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const health = await http('GET', `${cfg.baseUrl}/api/health`);
  if (health.status !== 200) fail(EXIT_ENV, `/api/health expected 200, got ${health.status} — is the api up at ${cfg.baseUrl}?`);
  const card = await http('GET', `${cfg.baseUrl}/.well-known/agent-card.json`);
  if (card.status === 404) {
    fail(EXIT_ENV, 'gateway is DISABLED (card 404). Enable path: set A2A_GATEWAY_ENABLED=true for oshal-api and recreate it (docs/evidence/a2a-gateway-2026-07-18.md section 6) — but ONLY on an image containing the ADR-087 role-gate fix (236589b8).');
  }
  assertProof(card.status === 200, `agent card expected 200, got ${card.status}`);
  const cardBody = card.body as { protocolVersion?: string; skills?: unknown[] };

  const minted = await mintCredential(cfg, pat, `a2a-inbound-proof-${Date.now()}`);
  assertProof(!JSON.stringify(card.body).includes(minted.id), 'agent card leaks an internal credential id');

  const marker = `a2a-proof-${Date.now()}`;
  const sendRes = await http('POST', `${cfg.baseUrl}/api/a2a`, { Authorization: `Bearer ${minted.token}` }, rpc('message/send', {
    message: {
      role: 'user', messageId: marker,
      parts: [{ kind: 'text', text: `In 3-5 plain-text sentences, explain what an A2A (agent-to-agent) gateway does for a multi-agent swarm. Include the token ${marker} verbatim in your reply. Do not create files; reply with text only.` }],
    },
  }, 1));
  assertProof(sendRes.status === 200, `message/send expected HTTP 200, got ${sendRes.status}: ${sendRes.text.slice(0, 300)}`);
  const sendBody = sendRes.body as { result?: { id: string; status: { state: string } }; error?: { code: number; message: string } };
  if (sendBody.error) fail(EXIT_FAIL, `message/send returned RPC error ${sendBody.error.code}: ${sendBody.error.message}`);
  const ticketId = sendBody.result!.id;
  console.log(`[send] ticket ${ticketId} filed (state ${sendBody.result!.status.state}); polling every ${cfg.pollSeconds}s, deadline ${cfg.timeoutMin} min`);

  const { states, finalTask, polls } = await pollToTerminal(cfg, minted.token, ticketId, sendBody.result!.status.state);
  const finalState = states[states.length - 1].state;
  const artifacts = Array.isArray(finalTask.artifacts) ? (finalTask.artifacts as Array<{ parts?: Array<{ text?: string }> }>) : [];
  const artifactText = artifacts.flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('\n').trim();
  const credentialRevoked = cfg.keepCredential ? false : await revokeCredential(cfg, pat, minted.id);

  const summary = {
    proof: 'a2a-inbound-completed', passed: finalState === 'completed' && artifactText.length > 0,
    baseUrl: cfg.baseUrl, agentId: minted.id, ticketId, finalState,
    statesTraversed: states, polls,
    artifacts: { count: artifacts.length, chars: artifactText.length, markerFound: artifactText.includes(marker), preview: artifactText.slice(0, 200) },
    timing: { startedAt, terminalAt: states[states.length - 1].at, totalMs: Date.now() - startMs },
    card: { protocolVersion: cardBody.protocolVersion ?? null, skillCount: Array.isArray(cardBody.skills) ? cardBody.skills.length : 0 },
    credentialRevoked,
  };
  emitSummary(cfg, summary);
  assertProof(finalState === 'completed', `terminal state is '${finalState}', not 'completed' (trace: ${states.map((s) => s.state).join(' -> ')})`);
  assertProof(artifactText.length > 0, 'ticket completed but tasks/get returned no artifact text');
}

/** @description Prints the proof summary JSON (single line, greppable) and optionally writes it to --json-out. */
function emitSummary(cfg: ProofConfig, summary: Record<string, unknown>): void {
  const line = JSON.stringify(summary);
  console.log(`\nPROOF-SUMMARY ${line}`);
  if (cfg.jsonOut) {
    fs.writeFileSync(cfg.jsonOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(`summary written to ${cfg.jsonOut}`);
  }
}

/** Entry point. */
async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const pat = loadOperatorPat(cfg.token);
  if (!pat) {
    fail(EXIT_ENV, 'no operator PAT found — pass --token, set OSHAL_CLI_TOKEN, or log in once with the swarm CLI so ~/.oshal/config.json holds contexts[currentContext].token');
  }
  console.log(`a2a-inbound-proof: ${cfg.dryRun ? 'DRY-RUN (gateway may stay disabled)' : 'FULL RUN (gateway must be enabled)'} against ${cfg.baseUrl}`);
  if (cfg.dryRun) await runDry(cfg, pat);
  else await runFull(cfg, pat);
  console.log('\nPROOF PASSED');
}

main().catch((err: unknown) => {
  console.error(`\nPROOF FAILED (unhandled): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(EXIT_FAIL);
});
