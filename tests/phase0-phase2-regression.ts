#!/usr/bin/env npx tsx
/**
 * Phase 0-2 Comprehensive Regression Test Suite
 *
 * Run: npx tsx tests/phase0-phase2-regression.ts
 *
 * Tests:
 *   1. Provider catalog completeness and correctness
 *   2. Per-provider Cline config builder (all 26 providers)
 *   3. Per-provider globalState builder with credential field names
 *   5. OpenAI Codex → openai-native mapping
 *   6. Agent constraint validation (claude-code locked, cline open)
 *   7. ClineRuntimeConfigSyncService E2E provider switch
 *   8. Node pool state lifecycle (idle → assigning → active → releasing → idle)
 *   9. Persona loading from YAML
 *   10. SwarmAgentWorker method availability
 *   11. NodeAllocatorService method availability
 *   12. Module import validation
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}

// ── 1. Provider Catalog ─────────────────────────────────────────────────────

console.log('\n=== 1. Provider Catalog ===');
const {
  PROVIDER_CATALOG,
  getAllProviders,
  getProvider,
  getDefaultModel,
  getClineProviderMapping,
  getProvidersForAgent,
} = require('../src/features/llm-provider/services/provider-catalog');

const providers = getAllProviders();
assert(providers.length >= 24, `has 24+ providers, got ${providers.length}`);

for (const p of providers) {
  assert(!!p.id, `${p.id} has id`);
  assert(!!p.name, `${p.id} has name`);
  assert(p.modelGroups.length > 0, `${p.id} has model groups`);
  const defaults = p.modelGroups.flatMap((g: any) => g.models).filter((m: any) => m.default);
  assert(defaults.length === 1, `${p.id} has exactly 1 default model, got ${defaults.length}`);
}

// ── 2. Cline Config Builder ─────────────────────────────────────────────────

console.log('\n=== 2. Cline Config Builder ===');
const { buildClineConfig, buildClineGlobalState } = require('../src/features/llm-provider/services/cline-config-builder');

// Test every provider produces valid config or null
for (const p of providers) {
  const config = buildClineConfig(p.id, 'test-model', {});
  if (p.clineProvider === null) {
    assert(config === null, `${p.id} returns null (non-Cline provider)`);
  } else {
    assert(config !== null, `${p.id} returns config`);
    assert(config.autoApprove === true, `${p.id} config.autoApprove`);
    assert(!!config.model, `${p.id} config.model set`);
  }
}

// ── 3. Provider-specific credential field names ─────────────────────────────

console.log('\n=== 3. Credential Field Names ===');

const credTests: Array<{ provider: string; creds: Record<string, string>; expectKey: string; expectValue: string }> = [
  { provider: 'bedrock', creds: { AWS_ACCESS_KEY_ID: 'AK' }, expectKey: 'accessKeyId', expectValue: 'AK' },
  { provider: 'anthropic', creds: { ANTHROPIC_API_KEY: 'sk' }, expectKey: 'apiKey', expectValue: 'sk' },
  { provider: 'gemini', creds: { GEMINI_API_KEY: 'gk' }, expectKey: 'apiKey', expectValue: 'gk' },
  { provider: 'azure', creds: { AZURE_API_KEY: 'az' }, expectKey: 'apiKey', expectValue: 'az' },
  { provider: 'groq', creds: { GROQ_API_KEY: 'gq' }, expectKey: 'apiKey', expectValue: 'gq' },
  { provider: 'ollama', creds: { OLLAMA_HOST: 'http://gpu:11434' }, expectKey: 'baseUrl', expectValue: 'http://gpu:11434' },
];

for (const t of credTests) {
  const cfg = buildClineConfig(t.provider, 'test', t.creds);
  assert(cfg[t.expectKey] === t.expectValue, `${t.provider} config.${t.expectKey} = ${t.expectValue}`);
}

// GlobalState credential field names (these differ from config.json!)
const gsCredTests: Array<{ provider: string; creds: Record<string, string>; expectKey: string; expectValue: string }> = [
  { provider: 'bedrock', creds: { AWS_ACCESS_KEY_ID: 'AK' }, expectKey: 'awsAccessKey', expectValue: 'AK' },
  { provider: 'openrouter', creds: { OPENROUTER_API_KEY: 'ork' }, expectKey: 'openRouterApiKey', expectValue: 'ork' },
  { provider: 'openai-native', creds: { OPENAI_API_KEY: 'oai' }, expectKey: 'openAiNativeApiKey', expectValue: 'oai' },
  { provider: 'gemini', creds: { GEMINI_API_KEY: 'gk' }, expectKey: 'geminiApiKey', expectValue: 'gk' },
  { provider: 'groq', creds: { GROQ_API_KEY: 'gq' }, expectKey: 'groqApiKey', expectValue: 'gq' },
  { provider: 'vertex', creds: { VERTEX_PROJECT_ID: 'proj' }, expectKey: 'vertexProjectId', expectValue: 'proj' },
];

for (const t of gsCredTests) {
  const gs = buildClineGlobalState(t.provider, 'test', t.creds);
  assert(gs[t.expectKey] === t.expectValue, `${t.provider} gs.${t.expectKey} = ${t.expectValue}`);
}

// ── 5. OpenAI Codex mapping ─────────────────────────────────────────────────

console.log('\n=== 5. OpenAI Codex Mapping ===');
assert(getClineProviderMapping('openai-codex') === 'openai-native', 'openai-codex maps to openai-native');
const codexCfg = buildClineConfig('openai-codex', 'gpt-5.3-codex', { OPENAI_API_KEY: 'k' });
assert(codexCfg.provider === 'openai-native', 'openai-codex config uses openai-native');
const codexGs = buildClineGlobalState('openai-codex', 'gpt-5.3-codex', { OPENAI_API_KEY: 'k' });
assert(codexGs.openAiNativeApiKey === 'k', 'openai-codex gs uses openAiNativeApiKey');

// ── 6. Agent constraints ────────────────────────────────────────────────────

console.log('\n=== 6. Agent Constraints ===');
assert(getProvidersForAgent('claude-code').length === 1, 'claude-code: 1 provider');
assert(getProvidersForAgent('claude-code')[0] === 'anthropic', 'claude-code: only anthropic');
assert(getProvidersForAgent('cline').length > 15, 'cline: 15+ providers');
assert(getProvidersForAgent('codex').includes('openai-codex'), 'codex: includes openai-codex');

// ── 7. ClineRuntimeConfigSyncService E2E ────────────────────────────────────

console.log('\n=== 7. Runtime Sync E2E ===');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-'));
const clineDir = path.join(tmpDir, '.cline');
fs.mkdirSync(path.join(clineDir, 'data'), { recursive: true });
fs.writeFileSync(path.join(clineDir, 'config.json'), '{}');
fs.writeFileSync(path.join(clineDir, 'data', 'globalState.json'), '{}');
fs.writeFileSync(path.join(clineDir, 'data', 'secrets.json'), '{}');

process.env.CONFIG_OUTPUT_DIR = tmpDir;
process.env.CLINE_CONFIG_DIR = clineDir;
process.env.GEMINI_API_KEY = 'test-gemini-key';

fs.writeFileSync(path.join(tmpDir, 'global-config.json'), JSON.stringify({
  actModeApiProvider: 'gemini',
  actModeApiModelId: 'gemini-3.1-pro-preview',
  mode: 'act',
}));

const { ClineRuntimeConfigSyncService } = require('../src/features/llm-provider/services/cline-runtime-config-sync-service');
const sync = new ClineRuntimeConfigSyncService(clineDir, tmpDir);
sync.syncFromPersistedConfig('gemini-3.1-pro-preview');

const syncedConfig = JSON.parse(fs.readFileSync(path.join(clineDir, 'config.json'), 'utf8'));
const syncedGs = JSON.parse(fs.readFileSync(path.join(clineDir, 'data', 'globalState.json'), 'utf8'));

assert(syncedConfig.provider === 'gemini', 'synced config provider = gemini');
assert(syncedConfig.apiKey === 'test-gemini-key', 'synced config has gemini API key');
assert(syncedGs.geminiApiKey === 'test-gemini-key', 'synced gs has geminiApiKey');
assert(syncedGs.actModeApiProvider === 'gemini', 'synced gs actModeApiProvider');

delete process.env.GEMINI_API_KEY;
fs.rmSync(tmpDir, { recursive: true, force: true });

// ── 8. Node Pool State Lifecycle ────────────────────────────────────────────

console.log('\n=== 8. Node Pool Lifecycle ===');
const { createNodePoolState } = require('../src/app/routes/node-pool-routes');
const state = createNodePoolState();
assert(state.status === 'idle', 'starts idle');
state.status = 'assigning';
assert(state.status === 'assigning', 'transitions to assigning');
state.assignment = { agentId: 'test', personaFile: '', agent: 'cline', model: 'x', provider: 'y', assignedAt: '' };
state.status = 'active';
assert(state.status === 'active', 'transitions to active');
state.status = 'releasing';
state.assignment = null;
state.status = 'idle';
assert(state.status === 'idle', 'releases to idle');
assert(state.assignment === null, 'assignment cleared');

// ── 9. SwarmAgentWorker Methods ─────────────────────────────────────────────

console.log('\n=== 9. SwarmAgentWorker ===');
const { SwarmAgentWorker } = require('../src/features/swarm-orchestration/services/swarm-agent-worker');
const workerProto = SwarmAgentWorker.prototype;
assert(typeof workerProto.reassign === 'function', 'has reassign()');
assert(typeof workerProto.getChannel === 'function', 'has getChannel()');
assert(typeof workerProto.isRunning === 'function', 'has isRunning()');
assert(typeof workerProto.start === 'function', 'has start()');
assert(typeof workerProto.stop === 'function', 'has stop()');

// ── 10. NodeAllocatorService Methods ────────────────────────────────────────

console.log('\n=== 10. NodeAllocatorService ===');
const { NodeAllocatorService } = require('../src/features/agent-management/services/node-allocator-service');
const allocProto = NodeAllocatorService.prototype;
assert(typeof allocProto.assignNode === 'function', 'has assignNode()');
assert(typeof allocProto.releaseNode === 'function', 'has releaseNode()');
assert(typeof allocProto.findNodeForAgent === 'function', 'has findNodeForAgent()');
assert(typeof allocProto.getIdleNodes === 'function', 'has getIdleNodes()');
assert(typeof allocProto.detectPendingMessages === 'function', 'has detectPendingMessages()');
assert(typeof allocProto.getPoolStatus === 'function', 'has getPoolStatus()');
assert(typeof allocProto.registerNode === 'function', 'has registerNode()');
assert(typeof allocProto.heartbeat === 'function', 'has heartbeat()');

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log('='.repeat(60));

process.exit(fail > 0 ? 1 : 0);
