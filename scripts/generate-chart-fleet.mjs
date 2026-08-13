/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-129) — the chart fleet lists are GENERATED, never hand-typed (anti-drift rule 2): parse docker-compose.oshal-local.yml, derive the k8s-eligible bot-node fleet (kernel + full presets), and write/verify the marker-fenced block in deploy/helm/oshal/values.yaml. Exclusions are LOGGED, not silent (no-silent-caps): docker-socket bots (self-healing has no docker daemon to heal on k8s) and compose-profile services (a `full` install never started them either). Guard: tests/unit/chart-fleet-parity.spec.ts runs check() and goes red on drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_PATH = path.join(ROOT, 'docker-compose.oshal-local.yml');
const VALUES_PATH = path.join(ROOT, 'deploy', 'helm', 'oshal', 'values.yaml');
const BEGIN = '# BEGIN GENERATED FLEET (scripts/generate-chart-fleet.mjs — do not hand-edit)';
const END = '# END GENERATED FLEET';

/**
 * @description The kernel fleet is the installer's KERNEL_SERVICES minus the
 * controller (oshal-api runs as the chart's api Deployment, not a bot). Keep in
 * lockstep with scripts/oshal-install.sh / oshal-install.ps1.
 */
export const KERNEL_BOTS = ['general-bot', 'jarvis-bot', 'oshal-developer'];

/**
 * @description Parse the compose file and derive the k8s-eligible bot fleet.
 * @param {string} composeText raw YAML text of docker-compose.oshal-local.yml
 * @returns {{bots: Array<object>, excluded: Array<{name: string, reason: string}>}}
 *   bots: chart-shaped entries (name/agentId/capabilities + optional botName/personaFile)
 *   excluded: every compose bot service NOT carried to k8s, with the reason why
 */
export function deriveFleet(composeText) {
  const doc = yaml.load(composeText);
  const services = doc?.services ?? {};
  const bots = [];
  const excluded = [];
  for (const [name, svc] of Object.entries(services)) {
    const env = svc?.environment ?? {};
    if (!env.AGENT_ID || !env.BOT_NAME) continue; // infra, not a bot
    if (name === 'oshal-api' || env.BOT_RUNTIME === 'swarm') continue; // the controller
    const volumes = (svc?.volumes ?? []).map(String);
    if (volumes.some((v) => v.includes('/var/run/docker.sock'))) {
      excluded.push({ name, reason: 'mounts the docker socket (no docker daemon on k8s)' });
      continue;
    }
    if (Array.isArray(svc?.profiles) && svc.profiles.length > 0) {
      excluded.push({ name, reason: `compose profile [${svc.profiles.join(',')}] — not part of a default \`up\`` });
      continue;
    }
    const entry = { name, agentId: String(env.AGENT_ID) };
    const botName = String(env.BOT_NAME);
    if (botName !== name) entry.botName = botName;
    const defaultPersona = `/app/ai-lab/bot-personas/${name}.yaml`;
    const persona = env.BOT_PERSONA_FILE ? String(env.BOT_PERSONA_FILE) : defaultPersona;
    if (persona !== defaultPersona) entry.personaFile = persona;
    if (env.AGENT_CAPABILITIES) entry.capabilities = String(env.AGENT_CAPABILITIES);
    bots.push(entry);
  }
  return { bots, excluded };
}

/**
 * @description Render the marker-fenced fleets block for values.yaml.
 * @param {Array<object>} bots full-fleet entries from deriveFleet()
 * @returns {string} YAML text from BEGIN to END marker inclusive
 */
export function renderBlock(bots) {
  const kernelSet = new Set(KERNEL_BOTS);
  const missing = KERNEL_BOTS.filter((k) => !bots.some((b) => b.name === k));
  if (missing.length) {
    throw new Error(`kernel bot(s) missing from the compose-derived fleet: ${missing.join(', ')}`);
  }
  const renderBot = (b) => {
    const lines = [`    - name: ${b.name}`, `      agentId: ${b.agentId}`];
    if (b.botName) lines.push(`      botName: ${b.botName}`);
    if (b.personaFile) lines.push(`      personaFile: ${b.personaFile}`);
    if (b.capabilities) lines.push(`      capabilities: "${b.capabilities}"`);
    return lines.join('\n');
  };
  const kernel = bots.filter((b) => kernelSet.has(b.name));
  const out = [BEGIN, 'fleets:', '  kernel:'];
  out.push(...kernel.map(renderBot));
  out.push('  full:');
  out.push(...bots.map(renderBot));
  out.push(END);
  return out.join('\n');
}

/**
 * @description Replace (or verify) the generated block inside values.yaml.
 * @param {'write'|'check'} mode write = rewrite the fence in place; check = compare only
 * @returns {{changed: boolean, block: string, excluded: Array<{name: string, reason: string}>}}
 */
export function run(mode) {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  const values = readFileSync(VALUES_PATH, 'utf8');
  const { bots, excluded } = deriveFleet(compose);
  const block = renderBlock(bots);
  const start = values.indexOf(BEGIN);
  const end = values.indexOf(END);
  if (start === -1 || end === -1) throw new Error(`fleet markers not found in ${VALUES_PATH}`);
  const current = values.slice(start, end + END.length);
  const changed = current !== block;
  if (mode === 'write' && changed) {
    writeFileSync(VALUES_PATH, values.slice(0, start) + block + values.slice(end + END.length));
  }
  return { changed, block, excluded };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const { changed, excluded, block } = run(mode);
  for (const e of excluded) console.log(`excluded from the k8s fleet: ${e.name} — ${e.reason}`);
  const count = (block.match(/- name: /g) ?? []).length;
  console.log(`fleet entries rendered (kernel + full): ${count}`);
  if (mode === 'check' && changed) {
    console.error('DRIFT: deploy/helm/oshal/values.yaml fleet block does not match docker-compose.oshal-local.yml.');
    console.error('Run: node scripts/generate-chart-fleet.mjs --write');
    process.exit(1);
  }
  console.log(mode === 'write' ? (changed ? 'values.yaml fleet block updated.' : 'values.yaml already current.') : 'fleet block matches compose.');
}
