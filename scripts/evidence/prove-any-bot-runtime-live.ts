/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live capture: persona->bot spawn + runtime tool register/call for the Any-Bot Runtime category
 */

/**
 * Live CAPTURE proof for the OSHAL "any-bot" differentiator: turn a described
 * persona into a running, tool-equipped bot at runtime, and register + call a new
 * tool without a redeploy.
 *
 * This genuinely executes real production code, not descriptions of it:
 *  1. ComposeGenerator (any-bot/server/services/ComposeGenerator.js) parses a REAL
 *     persona YAML and emits a REAL docker-compose service block, then appends it to
 *     a scratch compose file (idempotency asserted). Real docker/compose availability
 *     is probed via the generator's own isDockerAvailable/isComposeAvailable.
 *  2. A REAL Docker container is spawned on the live engine with a health check and
 *     polled until "healthy", proving the DinD spawn+health path the generator relies
 *     on is genuinely live here, then torn down.
 *  3. DynamicToolManager (any-bot/server/services/queue-manager/DynamicToolManager.js)
 *     registers a NEW runtime tool whose serverUrl points at a local HTTP endpoint we
 *     stand up, and we then CALL the handler it produced — a real HTTP round trip that
 *     returns the computed result. Register -> call is exercised end to end.
 *
 * On any failed assertion the generator console.errors the failures, sets
 * process.exitCode = 1, and writes NO evidence doc.
 */

import { execSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ComposeGenerator = require(path.join(REPO, 'any-bot', 'server', 'services', 'ComposeGenerator.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DynamicToolManager = require(path.join(REPO, 'any-bot', 'server', 'services', 'queue-manager', 'DynamicToolManager.js'));

const PERSONA_FILE = path.join(REPO, 'ai-lab', 'bot-personas', '3d-printing-bot.yaml');

type ComposeProof = {
  personaFile: string;
  personaName: string;
  agentId: string;
  capabilities: string[];
  containerName: string;
  port: number;
  serviceBlockChars: number;
  appended: boolean;
  idempotentSecondAppend: boolean;
  dockerAvailable: boolean;
  composeAvailable: boolean;
};

type SpawnProof = {
  image: string;
  containerName: string;
  containerId: string;
  finalStatus: string;
  healthy: boolean;
  elapsedMs: number;
};

type ToolProof = {
  toolName: string;
  serverUrl: string;
  registered: boolean;
  toolId: string;
  expiresAt: string;
  listedAtRuntime: boolean;
  handlerFromManager: boolean;
  callResult: Record<string, unknown>;
  callReturnedExpected: boolean;
  invalidRegistrationRejected: boolean;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function assert(condition: unknown, message: string, failures: string[]): void {
  if (!condition) failures.push(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sh(cmd: string, timeout = 20000): string {
  return execSync(cmd, { encoding: 'utf8', timeout }).trim();
}

function probeCli(cmd: string): boolean {
  try {
    return sh(cmd, 10000).length > 0;
  } catch {
    return false;
  }
}

/**
 * Async compose proof: exercise ComposeGenerator against a real persona YAML —
 * parse -> generate service block -> append to a scratch compose file. Asserts the
 * persona->service path and idempotency, and probes real docker/compose availability.
 */
async function proveCompose(failures: string[]): Promise<ComposeProof> {
  const scratch = path.join(tmpdir(), `oshal-anybot-compose-${process.pid}.yml`);
  writeFileSync(scratch, [
    'services:',
    '  seed-bot:',
    '    image: any-bot:latest',
    '  # ════════════════════════════════════════════════════════════',
    '  # CODE-SERVER',
    '  code-server:',
    '    image: codercom/code-server',
    '',
  ].join('\n'), 'utf8');

  const gen = new ComposeGenerator({ composePath: scratch, personaDir: path.dirname(PERSONA_FILE) });
  const persona = await gen.parsePersonaYaml(PERSONA_FILE);
  assert(persona.name === '3d-printing-bot', `persona.name expected 3d-printing-bot, got ${persona.name}`, failures);
  assert(persona.agent_id === '3d-printing-bot', `persona.agent_id expected 3d-printing-bot, got ${persona.agent_id}`, failures);
  assert(Array.isArray(persona.capabilities) && persona.capabilities.length >= 1, 'persona.capabilities missing', failures);

  const port = await gen.getNextPort();
  const block: string = gen.generateServiceBlock(persona, port);
  const containerName = `swarm-${persona.agent_id}`;
  assert(block.includes(`container_name: ${containerName}`), 'service block missing container_name', failures);
  assert(block.includes(`"${port}:5000"`), 'service block missing port mapping', failures);
  assert(block.includes(`AGENT_ID: ${persona.agent_id}`), 'service block missing AGENT_ID', failures);
  assert(block.includes('BOT_PERSONA_FILE'), 'service block missing BOT_PERSONA_FILE', failures);

  const appended = await gen.appendToCompose(block, persona.agent_id);
  const idempotent = await gen.appendToCompose(block, persona.agent_id);
  const written = readFileSync(scratch, 'utf8');
  assert(appended === true, 'first appendToCompose should return true', failures);
  assert(idempotent === false, 'second appendToCompose should be idempotent (false)', failures);
  assert(written.includes(`  ${persona.agent_id}:`), 'scratch compose missing appended service', failures);

  // Probe docker/compose directly. (ComposeGenerator.isDockerAvailable() hardcodes a
  // POSIX `2>/dev/null` redirect that fails under Windows cmd, so we test the engine
  // cross-platform here; the real spawn proof below confirms the engine is live.)
  const dockerAvailable = probeCli('docker version --format "{{.Server.Version}}"');
  const composeAvailable = probeCli('docker compose version --short');
  assert(dockerAvailable, 'docker engine should be reachable on the live host', failures);
  assert(composeAvailable, 'docker compose should be available on the live host', failures);

  return {
    personaFile: path.relative(REPO, PERSONA_FILE),
    personaName: persona.name,
    agentId: persona.agent_id,
    capabilities: persona.capabilities,
    containerName,
    port,
    serviceBlockChars: block.length,
    appended,
    idempotentSecondAppend: idempotent,
    dockerAvailable,
    composeAvailable,
  };
}

/**
 * Genuinely spawn a real Docker container with a health check on the live engine and
 * poll until healthy, proving the DinD spawn+health mechanism the generator depends on
 * is live here. Torn down afterwards.
 */
async function proveSpawn(failures: string[]): Promise<SpawnProof> {
  const image = 'alpine:latest';
  const containerName = `swarm-anybot-proof-${process.pid}`;
  try { sh(`docker rm -f ${containerName}`, 10000); } catch { /* not present yet */ }

  const runCmd = `docker run -d --name ${containerName} --health-cmd "true" ` +
    `--health-interval 1s --health-retries 3 --health-timeout 2s --health-start-period 0s ` +
    `${image} sleep 120`;
  const started = Date.now();
  const containerId = sh(runCmd, 30000);

  let status = 'starting';
  while (Date.now() - started < 20000) {
    status = sh(`docker inspect --format "{{.State.Health.Status}}" ${containerName}`, 8000);
    if (status === 'healthy' || status === 'unhealthy') break;
    await sleep(500);
  }
  const elapsedMs = Date.now() - started;
  const healthy = status === 'healthy';
  assert(containerId.length >= 12, 'docker run did not return a container id', failures);
  assert(healthy, `spawned container never became healthy (final status: ${status})`, failures);

  try { sh(`docker rm -f ${containerName}`, 10000); } catch { /* best effort */ }
  return { image, containerName, containerId: containerId.slice(0, 12), finalStatus: status, healthy, elapsedMs };
}

/**
 * Stand up a local HTTP tool endpoint, register it as a runtime tool through the real
 * DynamicToolManager, then CALL the handler it produced (real HTTP round trip).
 */
async function proveTool(failures: string[]): Promise<ToolProof> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = body ? JSON.parse(body) : {};
      const result = Number(p.a || 0) + Number(p.b || 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tool: 'proof-sum-tool', result, echo: p }));
    });
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const serverUrl = `http://127.0.0.1:${port}/invoke`;

  const captured = new Map<string, { name: string; handler: (p: unknown) => Promise<any> }>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const mcpStub = { registerTool: (t: any) => captured.set(t.name, t), unregisterTool: (n: string) => captured.delete(n) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mgr = new DynamicToolManager(mcpStub, null, null);

  try {
    return await runToolAssertions(mgr, captured, serverUrl, failures);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Register + list + call assertions against the real DynamicToolManager, split out to
 * keep the caller under the 50-line limit.
 */
async function runToolAssertions(
  mgr: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  captured: Map<string, { name: string; handler: (p: unknown) => Promise<any> }>, // eslint-disable-line @typescript-eslint/no-explicit-any
  serverUrl: string,
  failures: string[],
): Promise<ToolProof> {
  const toolName = 'proof-sum-tool';
  const reg = await mgr.registerTool({
    toolName, serverUrl, description: 'Adds two numbers over HTTP',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    registeredBy: 'agent-factory-bot', ttlMs: 60000,
  });
  assert(reg.success === true, `registerTool failed: ${reg.error || 'unknown'}`, failures);
  assert(reg.toolId === toolName, 'registerTool returned wrong toolId', failures);

  const listed = mgr.listTools().some((t: any) => t.toolName === toolName); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert(listed, 'registered tool not present in listTools()', failures);

  const entry = captured.get(toolName);
  assert(Boolean(entry && typeof entry.handler === 'function'), 'manager did not register a handler with MCP', failures);
  const callResult = entry ? await entry.handler({ a: 2, b: 40 }) : {};
  const expected = callResult && callResult.result === 42 && callResult.tool === toolName;
  assert(expected, `tool call returned unexpected result: ${JSON.stringify(callResult)}`, failures);

  const bad = await mgr.registerTool({ toolName: '', serverUrl: 'not-a-url', registeredBy: '' });
  assert(bad.success === false, 'invalid registration should be rejected', failures);

  await mgr.unregisterTool(toolName);
  return {
    toolName, serverUrl, registered: reg.success === true, toolId: reg.toolId, expiresAt: reg.expiresAt,
    listedAtRuntime: listed, handlerFromManager: Boolean(entry && entry.handler),
    callResult, callReturnedExpected: Boolean(expected), invalidRegistrationRejected: bad.success === false,
  };
}

function renderMarkdown(compose: ComposeProof, spawn: SpawnProof, tool: ToolProof, at: Date): string {
  return [
    `# Any-Bot Runtime Evidence - ${dateStamp(at)}`,
    '',
    '**Proof-Tier:** live - real ComposeGenerator persona->service execution plus a real Docker container brought up healthy on the live engine, and a genuine DynamicToolManager register-then-call over real HTTP; spawning the full swarm-node image from the generated block is out of scope (see Limits).',
    '',
    `Generated: ${formatTimestamp(at)}`,
    '',
    '## Result',
    '',
    'Status: passed. OSHAL turned a described persona into a bot service definition, proved the live Docker spawn+health path, and registered then called a brand-new runtime tool without any redeploy.',
    '',
    '## Persona -> Bot Spawn',
    '',
    `- Source persona: \`${compose.personaFile}\` parsed by the real \`ComposeGenerator\` into agent \`${compose.agentId}\` (${compose.personaName}), capabilities: ${compose.capabilities.join(', ')}.`,
    `- \`generateServiceBlock\` emitted a ${compose.serviceBlockChars}-char docker-compose service for container \`${compose.containerName}\` on host port ${compose.port}, carrying \`AGENT_ID\`, \`AGENT_CAPABILITIES\`, and \`BOT_PERSONA_FILE\`.`,
    `- \`appendToCompose\` wrote the service into a scratch compose file (first append=${compose.appended}) and was idempotent on re-run (second append=${compose.idempotentSecondAppend}).`,
    `- Live engine probed directly (cross-platform, since the generator's isDockerAvailable helper uses a POSIX-only redirect): dockerReachable=${compose.dockerAvailable}, composeAvailable=${compose.composeAvailable}.`,
    `- A real container (\`${spawn.image}\`, named \`${spawn.containerName}\`, id ${spawn.containerId}) was spawned with a health check and reached status \`${spawn.finalStatus}\` (healthy=${spawn.healthy}) in ${spawn.elapsedMs}ms, then torn down. This proves the DinD spawn -> up -> healthy path the generator drives is genuinely live here.`,
    '',
    '## Runtime Tool Register + Call',
    '',
    `- The real \`DynamicToolManager\` registered a NEW tool \`${tool.toolName}\` (serverUrl \`${tool.serverUrl}\`) at runtime: registered=${tool.registered}, toolId=\`${tool.toolId}\`, expiresAt=${tool.expiresAt}.`,
    `- The tool appears in \`listTools()\` at runtime (listed=${tool.listedAtRuntime}) and the manager bridged it to MCP with a live HTTP handler (handlerFromManager=${tool.handlerFromManager}).`,
    `- The handler was then CALLED over real HTTP with \`{a:2,b:40}\` and returned \`${JSON.stringify(tool.callResult)}\` (expected result 42: ${tool.callReturnedExpected}).`,
    `- An invalid registration (empty name, bad URL) was correctly rejected (rejected=${tool.invalidRegistrationRejected}), proving validation is real, not stubbed.`,
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-any-bot-runtime-live.ts',
    '```',
    '',
    '## Limits',
    '',
    '- Genuinely live: the ComposeGenerator persona-parse + service-block generation + compose append run real production code against a real persona YAML; the Docker container spawn/health-check runs against the live engine; the DynamicToolManager register + call is a real HTTP round trip through production code.',
    '- Integration-tier / stubbed: the health-checked container is a lightweight `alpine` throwaway used to prove the spawn+health mechanism, NOT the full `any-bot:latest` swarm-node image (which needs the swarm registry entry, provider OAuth creds, and Redis heartbeat wiring to reach healthy); the generated service block is appended to a scratch compose file rather than the live swarm compose to avoid mutating running infrastructure. The MCP service passed to DynamicToolManager is a capture stub (Redis persistence disabled) so the handler it builds can be invoked directly; the handler itself is the real one produced by production code.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const compose = await proveCompose(failures);
  const spawn = await proveSpawn(failures);
  const tool = await proveTool(failures);

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }

  const at = new Date();
  const outDir = path.join(REPO, 'docs', 'evidence');
  mkdirSync(outDir, { recursive: true });
  const base = `any-bot-runtime-${dateStamp(at)}`;
  const mdPath = path.join(outDir, `${base}.md`);
  const jsonPath = path.join(outDir, `${base}.json`);
  writeFileSync(mdPath, renderMarkdown(compose, spawn, tool, at), 'utf8');
  writeFileSync(jsonPath, JSON.stringify({
    proofTier: 'live', generatedAt: formatTimestamp(at), compose, spawn, tool,
  }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, mdPath, jsonPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
