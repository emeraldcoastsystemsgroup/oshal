/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | GET /api/readiness (INSTALLER-GAPS G9 + G7): per-capability readiness, because /api/health is a liveness probe that reports {"status":"ok"} on a box with no engine, no voice and a missing bot. Legs: llm (active/forced provider vs the explicit OSHAL_NO_AI declaration — G2's "noop must never be silent"), bots (routing-critical heartbeats, scoped to the ACTIVE registry so a kernel-bundle box is not failed for bots it deliberately does not run), credentials (each critical bot's harness has a credential behind it — the G7 "starts, heartbeats, fails on first use" trap), voice tts/stt (configured, or explicitly not declared), db. Public like /api/health; coarse states only (ok|off|fail + a short detail), no secrets. Consumed by scripts/oshal-verify.sh; returns HTTP 503 when not ready so runbooks can curl it directly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the `catalogs` leg (BACKLOG "The api can boot healthy with ZERO connector tools"). Live 2026-08-01: the api booted with `ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'`, registered ZERO connector tools, and BOTH /api/health and this endpoint said ready — the exact "liveness read as readiness" failure G9 exists to end, one layer up. A subsystem that reads a catalog at boot now records what it loaded (@/shared/observability catalog-load registry) and this leg FAILS when any catalog's source was unreadable or offered entries and produced none. An absent source stays `off`: a box that ships no connectors is a deployment shape, not a defect.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express, Request, Response } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import {
  getSTTProviderRegistry,
  getTTSProviderRegistry,
  loadSwarmVoiceConfig,
  resolveGlobalConfigPath,
} from '@/features/voice-providers';
import { degradedCatalogs, listCatalogLoads, type CatalogLoadRecord } from '@/shared/observability';
import { createChildLogger } from '@/shared/logger';
import { listConfiguredProviders } from './provider-routes';

const logger = createChildLogger({ module: 'readiness-routes' });

/** One capability leg: ok = works, off = deliberately/harmlessly absent, fail = advertised but broken. */
export type ReadinessState = 'ok' | 'off' | 'fail';

/** @description A single capability leg of the readiness report. */
export interface ReadinessLeg {
  state: ReadinessState;
  detail: string;
}

/** @description The full per-capability readiness report served at GET /api/readiness. */
export interface ReadinessReport {
  ready: boolean;
  /** One grep-able line, e.g. "llm=ok bots=fail credentials=ok voice.tts=off voice.stt=off db=ok". */
  summary: string;
  /** Human-readable problem lines for every failing leg (empty when ready). */
  problems: string[];
  legs: {
    llm: ReadinessLeg;
    bots: ReadinessLeg;
    credentials: ReadinessLeg;
    catalogs: ReadinessLeg;
    voiceTts: ReadinessLeg;
    voiceStt: ReadinessLeg;
    db: ReadinessLeg;
  };
  generatedAt: string;
}

/** @description A routing-critical bot resolved against the active registry. */
export interface CriticalBot {
  agentId: string;
  name: string;
  /** Explicit harness pin from the registry; null = process-level default. */
  harnessType: string | null;
}

/** @description Voice-side status snapshot for one of tts/stt. */
export interface VoiceSideStatus {
  providerId: string;
  configured: boolean;
  /** True when the operator's global config explicitly declares this side. */
  declared: boolean;
  /** Browser providers run client-side and have no server dependency. */
  browser: boolean;
}

/**
 * @description The data sources buildReadinessReport draws from — injected so the
 * report logic is unit-testable without a running stack (guard-per-fix, 2026-07-19).
 */
export interface ReadinessDeps {
  activeProvider(): string | null;
  forcedProvider(): string | null;
  noAiDeclared(): boolean;
  /** null = the critical-bot list is not present in this build. */
  criticalBots(): CriticalBot[] | null;
  /** null = the runtime registry (redis) is unavailable. */
  onlineAgentIds(): Promise<string[] | null>;
  /** true/false = credential present/absent; null = not verifiable here (e.g. cline per-provider keys). */
  credentialPresent(harness: string): boolean | null;
  /** Harness family used by bots without an explicit pin (from FORCE_LLM_PROVIDER). */
  defaultHarness(): string;
  voiceStatus(kind: 'tts' | 'stt'): Promise<VoiceSideStatus | null>;
  dbOk(): Promise<boolean>;
  /** Every catalog-load outcome recorded at boot (@/shared/observability). */
  catalogLoads(): CatalogLoadRecord[];
  /** The subset that loaded nothing it was supposed to load. */
  degradedCatalogLoads(): CatalogLoadRecord[];
}

/** Provider-id → harness family, mirroring the bot-node execution fallback. */
const PROVIDER_HARNESS: Record<string, string> = {
  'claude-code': 'claude-code',
  'openai-codex': 'codex-cli',
  'codex-cli': 'codex-cli',
  'gemini-cli': 'gemini-cli',
  gemini: 'gemini-cli',
  noop: 'noop',
};

/** Harness family → { env keys, credential file } that satisfy it (BYOK, ADR-033). */
const HARNESS_CREDENTIALS: Record<string, { envKeys: string[]; file: string }> = {
  'codex-cli': { envKeys: ['OPENAI_API_KEY'], file: '.codex/auth.json' },
  'claude-code': { envKeys: ['ANTHROPIC_API_KEY'], file: '.claude/.credentials.json' },
  'gemini-cli': { envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], file: '.gemini/oauth_creds.json' },
};

function buildLlmLeg(deps: ReadinessDeps): ReadinessLeg {
  const active = deps.activeProvider();
  const forced = deps.forcedProvider();
  const effectiveOff = forced === 'noop' || (!active && !forced);
  if (!effectiveOff && active && active !== 'noop') {
    return { state: 'ok', detail: `active provider: ${active}` };
  }
  if (!effectiveOff && forced) {
    return { state: 'ok', detail: `process default: ${forced} (no cockpit selection yet)` };
  }
  if (deps.noAiDeclared()) {
    return { state: 'off', detail: 'declared no-AI (OSHAL_NO_AI=true) — AI features intentionally disabled' };
  }
  return {
    state: 'fail',
    detail: forced === 'noop'
      ? 'FORCE_LLM_PROVIDER=noop without OSHAL_NO_AI=true — a silent stub engine (INSTALLER-GAPS G2). Connect a model, or declare --no-ai deliberately.'
      : 'no active LLM provider — connect a model at /welcome, or declare OSHAL_NO_AI=true for a deliberately model-less box',
  };
}

async function buildBotsLeg(deps: ReadinessDeps): Promise<{ leg: ReadinessLeg; expected: CriticalBot[] }> {
  const expected = deps.criticalBots();
  if (expected === null) {
    return { leg: { state: 'off', detail: 'routing-critical bot list not bundled in this build — heartbeat scope unknown' }, expected: [] };
  }
  if (expected.length === 0) {
    return { leg: { state: 'ok', detail: 'no routing-critical bots in the active registry scope' }, expected };
  }
  const online = await deps.onlineAgentIds();
  if (online === null) {
    return { leg: { state: 'fail', detail: 'runtime registry unavailable (redis down?) — heartbeats unreadable' }, expected };
  }
  const onlineSet = new Set(online);
  const missing = expected.filter((b) => !onlineSet.has(b.agentId));
  if (missing.length > 0) {
    return {
      leg: { state: 'fail', detail: `not heartbeating: ${missing.map((b) => b.name).join(', ')} (${missing.length}/${expected.length} routing-critical bots down)` },
      expected,
    };
  }
  return { leg: { state: 'ok', detail: `${expected.length}/${expected.length} routing-critical bots heartbeating online` }, expected };
}

function buildCredentialsLeg(deps: ReadinessDeps, expected: CriticalBot[]): ReadinessLeg {
  if (deps.noAiDeclared()) {
    return { state: 'off', detail: 'declared no-AI — harness credentials not required' };
  }
  const missing: string[] = [];
  const verified = new Set<string>();
  let verifiable = 0;
  for (const bot of expected) {
    const harness = bot.harnessType || deps.defaultHarness();
    if (harness === 'noop' || harness === 'a2a') continue;
    const present = deps.credentialPresent(harness);
    if (present === null) continue; // not verifiable here (e.g. cline provider-specific keys)
    verifiable += 1;
    if (present) {
      verified.add(harness);
    } else {
      const req = HARNESS_CREDENTIALS[harness];
      const how = req ? `~/${req.file} or ${req.envKeys.join('/')}` : harness;
      missing.push(`${bot.name} needs ${harness} credentials (${how}) — it starts and heartbeats but fails on first use`);
    }
  }
  if (missing.length > 0) return { state: 'fail', detail: missing.join('; ') };
  if (verifiable === 0) return { state: 'off', detail: 'no verifiable harness credentials in scope (provider-specific keys are checked at execution time)' };
  return { state: 'ok', detail: `credentials present for: ${Array.from(verified).join(', ')}` };
}

/**
 * @description The `catalogs` leg: a subsystem that reads a catalog of definitions at boot
 * and loaded NONE of it is advertised and dead, and must not pass readiness. Distinguishes
 * three shapes deliberately — nothing recorded at all is `off` (this build registers no
 * catalogs, or nothing has loaded yet), an absent source is fine (a box with no connector
 * directory), and unreadable/empty is `fail` with the reason on the line.
 * @param loads - Every recorded catalog-load outcome.
 * @param degraded - The outcomes that mean "loaded nothing it should have".
 * @returns The leg.
 */
function buildCatalogsLeg(loads: CatalogLoadRecord[], degraded: CatalogLoadRecord[]): ReadinessLeg {
  if (loads.length === 0) {
    return { state: 'off', detail: 'no catalog-backed subsystem has reported a load' };
  }
  if (degraded.length > 0) {
    const lines = degraded.map((r) => (
      r.state === 'unreadable'
        ? `${r.catalog}: source unreadable after ${r.attempts} attempt(s) — ${r.detail ?? 'no detail'} (${r.source})`
        : `${r.catalog}: ${r.discovered} entries offered, 0 loaded (${r.source})`
    ));
    return { state: 'fail', detail: lines.join('; ') };
  }
  const present = loads.filter((r) => r.state !== 'absent');
  if (present.length === 0) {
    return { state: 'off', detail: `no catalog source present (${loads.length} declared, all absent)` };
  }
  const loaded = present.reduce((sum, r) => sum + r.loaded, 0);
  return { state: 'ok', detail: `${loaded} entries loaded across ${present.length} catalog source(s)` };
}

function buildVoiceLeg(kind: 'tts' | 'stt', status: VoiceSideStatus | null): ReadinessLeg {
  if (!status) return { state: 'off', detail: `${kind} provider unresolvable — voice off` };
  if (status.browser) return { state: 'off', detail: `${status.providerId} (client-side, no server dependency)` };
  if (status.configured) return { state: 'ok', detail: `${status.providerId} configured` };
  if (status.declared) {
    return { state: 'fail', detail: `${status.providerId} is declared in the global config but NOT configured — ${kind} is advertised and dead` };
  }
  return { state: 'off', detail: `default ${status.providerId} not configured — ${kind} off (never declared)` };
}

/**
 * @description Build the per-capability readiness report from injected deps.
 * Pure with respect to process state — everything env/fs/redis comes in via deps.
 *
 * @param deps - The injected data sources.
 * @returns The full readiness report; ready = no leg in state 'fail'.
 */
export async function buildReadinessReport(deps: ReadinessDeps): Promise<ReadinessReport> {
  const llm = buildLlmLeg(deps);
  const { leg: bots, expected } = await buildBotsLeg(deps);
  const credentials = buildCredentialsLeg(deps, expected);
  const catalogs = buildCatalogsLeg(deps.catalogLoads(), deps.degradedCatalogLoads());
  const [ttsStatus, sttStatus] = await Promise.all([deps.voiceStatus('tts'), deps.voiceStatus('stt')]);
  const voiceTts = buildVoiceLeg('tts', ttsStatus);
  const voiceStt = buildVoiceLeg('stt', sttStatus);
  const db = (await deps.dbOk())
    ? { state: 'ok' as const, detail: 'postgres reachable' }
    : { state: 'fail' as const, detail: 'postgres unreachable' };

  const legs = { llm, bots, credentials, catalogs, voiceTts, voiceStt, db };
  const summary = [
    `llm=${llm.state}`, `bots=${bots.state}`, `credentials=${credentials.state}`,
    `catalogs=${catalogs.state}`,
    `voice.tts=${voiceTts.state}`, `voice.stt=${voiceStt.state}`, `db=${db.state}`,
  ].join(' ');
  const problems = Object.entries(legs)
    .filter(([, leg]) => leg.state === 'fail')
    .map(([name, leg]) => `${name}: ${leg.detail}`);
  return { ready: problems.length === 0, summary, problems, legs, generatedAt: new Date().toISOString() };
}

/** Parse scripts/routability-critical-bots.txt (id|name|reach|breaks); null when absent. */
function readCriticalList(): Array<{ agentId: string; name: string }> | null {
  const candidates = [
    path.resolve(process.cwd(), 'scripts/routability-critical-bots.txt'),
    '/app/scripts/routability-critical-bots.txt',
  ];
  const file = candidates.find((c) => fs.existsSync(c));
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf-8').split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [id, name] = line.split('|').map((s) => s.trim());
        return { agentId: id, name: name || id };
      })
      .filter((entry) => !!entry.agentId);
  } catch (err) {
    logger.error({ err, file }, 'readiness: failed to parse the critical-bot list');
    return null;
  }
}

/** Does the operator's global config explicitly declare a voice side? */
function voiceSideDeclared(kind: 'tts' | 'stt'): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveGlobalConfigPath(), 'utf-8'));
    return !!parsed?.voice?.[kind];
  } catch {
    return false;
  }
}

// Voice getStatus() can probe a cloud API — cache each side briefly so readiness
// polling (runbooks, watchdogs) does not turn into a probe storm.
const VOICE_CACHE_MS = 30_000;
const voiceCache: Partial<Record<'tts' | 'stt', { at: number; value: VoiceSideStatus | null }>> = {};

async function probeVoiceSide(kind: 'tts' | 'stt'): Promise<VoiceSideStatus | null> {
  const cached = voiceCache[kind];
  if (cached && Date.now() - cached.at < VOICE_CACHE_MS) return cached.value;
  let value: VoiceSideStatus | null = null;
  try {
    const cfg = loadSwarmVoiceConfig();
    const defaultId = kind === 'tts' ? cfg.tts.default : cfg.stt.default;
    const provider = kind === 'tts' ? getTTSProviderRegistry().get(defaultId) : getSTTProviderRegistry().get(defaultId);
    if (provider) {
      const browser = defaultId.startsWith('browser');
      let configured = false;
      try {
        configured = browser ? true : !!(await provider.getStatus()).configured;
      } catch (err) {
        logger.warn({ err, kind, defaultId }, 'readiness: voice status probe failed — treating as unconfigured');
      }
      value = { providerId: defaultId, configured, declared: voiceSideDeclared(kind), browser };
    }
  } catch (err) {
    logger.error({ err, kind }, 'readiness: voice config unresolvable');
  }
  voiceCache[kind] = { at: Date.now(), value };
  return value;
}

/**
 * @description Wire the real data sources for buildReadinessReport from the app
 * context + process env. Exported for the unit spec to cross-check wiring shape.
 *
 * @param ctx - The composed app context (pool + optional swarm extension).
 * @returns Deps backed by env, fs, the bot registry, redis heartbeats and postgres.
 */
export function createReadinessDeps(ctx: AppContext): ReadinessDeps {
  return {
    activeProvider: () => listConfiguredProviders().activeProvider,
    forcedProvider: () => process.env.FORCE_LLM_PROVIDER || null,
    noAiDeclared: () => process.env.OSHAL_NO_AI === 'true',
    criticalBots: () => {
      const list = readCriticalList();
      if (list === null) return null;
      const byId = new Map(getActiveRegistry().map((b) => [b.agentId, b]));
      return list
        .filter((entry) => byId.has(entry.agentId))
        // Inline (api-container) bots never heartbeat by design — exclude them here.
        .filter((entry) => byId.get(entry.agentId)?.container !== 'oshal-api')
        .map((entry) => ({ ...entry, harnessType: byId.get(entry.agentId)?.harnessType || null }));
    },
    onlineAgentIds: async () => {
      try {
        const ids = await (ctx as any).swarm?.runtimeRegistryService?.listOnlineAgentIds?.();
        return Array.isArray(ids) ? ids : null;
      } catch (err) {
        logger.error({ err }, 'readiness: heartbeat listing failed');
        return null;
      }
    },
    credentialPresent: (harness: string) => {
      const req = HARNESS_CREDENTIALS[harness];
      if (!req) return null;
      if (req.envKeys.some((k) => !!process.env[k])) return true;
      return fs.existsSync(path.join(os.homedir(), req.file));
    },
    defaultHarness: () => PROVIDER_HARNESS[process.env.FORCE_LLM_PROVIDER || 'openai-codex'] || 'cline',
    catalogLoads: listCatalogLoads,
    degradedCatalogLoads: degradedCatalogs,
    voiceStatus: probeVoiceSide,
    dbOk: async () => {
      try {
        await ctx.pool.query('SELECT 1');
        return true;
      } catch (err) {
        logger.error({ err }, 'readiness: db ping failed');
        return false;
      }
    },
  };
}

/**
 * @description Register GET /api/readiness. Public by design, like /api/health:
 * it reports coarse capability states (ok|off|fail + one-line details) and never
 * secrets. Returns 200 when ready, 503 when any leg fails — so runbooks and
 * scripts/oshal-verify.sh can gate on the status code alone.
 *
 * @param app - The Express app.
 * @param ctx - The composed app context.
 * @returns void
 */
export function registerReadinessRoutes(app: Express, ctx: AppContext): void {
  const deps = createReadinessDeps(ctx);
  app.get('/api/readiness', async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
      const report = await buildReadinessReport(deps);
      logger.info({ ready: report.ready, summary: report.summary, durationMs: Date.now() - started }, 'GET /api/readiness');
      res.status(report.ready ? 200 : 503).json(report);
    } catch (err) {
      logger.error({ err, durationMs: Date.now() - started }, 'GET /api/readiness failed');
      res.status(500).json({ ready: false, error: 'readiness computation failed' });
    }
  });
}
