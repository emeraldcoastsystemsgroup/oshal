/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial RCA analysis engine — stub implementations for all three methods
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | No-mock remediation: the three analyzers returned hardcoded "pending" placeholder RootCauses on a live auth-gated route (2026-07-18 loose-ends sweep finding). The engine now performs REAL analysis by dispatching a method-specific structured prompt to the rca-specialist bot through an injected executor (ADR-036: the bot owns the reasoning, cost lands in chat_tasks via the caller's executeBotOrInline closure), parses/validates the bot's strict-JSON verdict, and FAILS HONESTLY — RcaEngineUnavailableError (route → 503) when the bot is unreachable or returns an unparseable verdict, RcaEngineDisabledError (route → 501) under RCA_ENGINE_MODE=disabled. No code path can emit the old placeholder shape. The executor seam doubles as the future echo-engine integration point (integrate, don't reimplement).
 */

import { createChildLogger } from '@/shared/logger';
import type {
  RcaAnalysisRequest,
  RcaAnalysisResult,
  RootCause,
  Recommendation,
} from '@/shared/types';

const logger = createChildLogger({ module: 'rca-engine' });

/**
 * @description Thrown when the RCA engine is administratively disabled
 * (`RCA_ENGINE_MODE=disabled`). Routes map this to HTTP 501 so callers get an
 * explicit "not enabled here" instead of fabricated results.
 */
export class RcaEngineDisabledError extends Error {
  constructor() {
    super('RCA analysis engine is disabled (RCA_ENGINE_MODE=disabled)');
    this.name = 'RcaEngineDisabledError';
  }
}

/**
 * @description Thrown when the analysis bot is unreachable or returns a verdict
 * that cannot be parsed into a valid result. Routes map this to HTTP 503. The
 * engine NEVER degrades to placeholder output — an honest failure beats a
 * fake-looking analysis (repo no-mock rule).
 */
export class RcaEngineUnavailableError extends Error {
  constructor(detail: string) {
    super(`RCA analysis engine unavailable: ${detail}`);
    this.name = 'RcaEngineUnavailableError';
  }
}

/**
 * @description Runs one assembled RCA prompt on an accountable analysis bot and
 * returns the bot's raw text response. Injected by the route layer (which owns
 * BotNodeClient / executeBotOrInline per FSD direction — features must not
 * import app-layer plumbing). This seam is also where a future echo-engine
 * integration plugs in without touching the engine's contract.
 */
export type RcaExecutor = (prompt: string) => Promise<string>;

/** Method-specific analysis instructions, keyed by RcaMethod. */
const METHOD_INSTRUCTIONS: Record<RcaAnalysisRequest['method'], string> = {
  'five-whys': [
    'Perform a Five Whys root cause analysis. Starting from the incident symptom, ask "why" iteratively',
    '(typically five levels deep) until you reach process/systemic root causes rather than proximate technical ones.',
    'Report the causal chain in each root cause\'s evidence array (why-1 through why-N).',
  ].join(' '),
  fishbone: [
    'Perform a Fishbone (Ishikawa) analysis. Categorize candidate causes across the standard dimensions',
    '(People, Process, Technology/Equipment, Environment, Materials, Measurement) and identify which category',
    'contains the dominant root cause(s). Name the category in each root cause\'s category field.',
  ].join(' '),
  'fault-tree': [
    'Perform a Fault Tree analysis. Model the incident as the top event, decompose into intermediate failure',
    'events connected by AND/OR logic down to basic events, and estimate each root cause\'s likelihood from the',
    'tree structure. Describe the relevant tree path in each root cause\'s evidence array.',
  ].join(' '),
};

/**
 * @description Core RCA analysis engine. Dispatches a method-specific structured
 * prompt to the analysis bot via the injected executor, then parses and
 * validates the bot's strict-JSON verdict. Fails honestly (typed errors) —
 * never emits placeholder results.
 */
export class RcaEngine {
  private readonly executor?: RcaExecutor;

  constructor(executor?: RcaExecutor) {
    this.executor = executor;
  }

  /**
   * @description Main analysis entrypoint — builds the method prompt, runs it on
   * the analysis bot, and returns the parsed, validated result.
   * @param request - The RCA analysis request payload
   * @returns Analysis result with bot-derived root causes and recommendations
   * @throws RcaEngineDisabledError when RCA_ENGINE_MODE=disabled
   * @throws RcaEngineUnavailableError when no executor is wired, the bot call
   *   fails, or the bot's verdict cannot be parsed/validated
   */
  async analyze(request: RcaAnalysisRequest): Promise<RcaAnalysisResult> {
    logger.info({ incidentId: request.incidentId, method: request.method }, 'Starting RCA analysis');

    if ((process.env.RCA_ENGINE_MODE ?? '').trim().toLowerCase() === 'disabled') {
      throw new RcaEngineDisabledError();
    }
    if (!this.executor) {
      throw new RcaEngineUnavailableError('no analysis executor wired (engine constructed without a bot dispatch closure)');
    }
    if (!METHOD_INSTRUCTIONS[request.method]) {
      throw new Error(`Unsupported RCA method: ${request.method}`);
    }

    const prompt = this.buildPrompt(request);
    let raw: string;
    try {
      raw = await this.executor(prompt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, incidentId: request.incidentId }, 'RCA bot dispatch failed');
      throw new RcaEngineUnavailableError(`analysis bot dispatch failed — ${detail}`);
    }

    const result = this.parseVerdict(request, raw);
    logger.info(
      { incidentId: request.incidentId, rootCauseCount: result.rootCauses.length, confidence: result.confidence },
      'RCA analysis complete',
    );
    return result;
  }

  /**
   * @description Assembles the method-specific structured prompt. Demands a
   * strict JSON-only reply so the verdict parses deterministically.
   * @param request - Original analysis request
   * @returns The full prompt sent to the analysis bot
   */
  private buildPrompt(request: RcaAnalysisRequest): string {
    const payload = request.payload !== undefined && request.payload !== null
      ? `\n\nSupporting data (JSON):\n${JSON.stringify(request.payload).slice(0, 8000)}`
      : '';
    const severity = request.severity ? `\nSeverity: ${request.severity}` : '';
    return [
      `You are a root cause analysis specialist. Analyze this incident using the ${request.method} method.`,
      '',
      `Incident ID: ${request.incidentId}${severity}`,
      `Incident description: ${request.description}${payload}`,
      '',
      METHOD_INSTRUCTIONS[request.method],
      '',
      'Respond with ONLY a single JSON object (no prose, no markdown fences) in exactly this shape:',
      '{',
      '  "rootCauses": [ { "description": string, "category": string, "likelihood": number 0..1, "evidence": [string] } ],',
      '  "recommendations": [ { "action": string, "priority": "low"|"medium"|"high"|"critical", "estimatedEffort": string, "expectedImpact": string } ],',
      '  "confidence": number 0..1',
      '}',
      'Ground every root cause in the incident description/data — if the information is insufficient for a',
      'confident verdict, say so in the description and lower likelihood/confidence accordingly; never invent facts.',
    ].join('\n');
  }

  /**
   * @description Parses and validates the bot's verdict. Extracts the first JSON
   * object from the response (bots occasionally wrap JSON in prose), validates
   * the required shape, and clamps numeric fields to [0,1].
   * @param request - Original request for result context
   * @param raw - The bot's raw text response
   * @returns The validated analysis result
   * @throws RcaEngineUnavailableError when no valid verdict can be extracted
   */
  private parseVerdict(request: RcaAnalysisRequest, raw: string): RcaAnalysisResult {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      logger.error({ incidentId: request.incidentId, rawPreview: raw.slice(0, 300) }, 'RCA verdict contained no JSON object');
      throw new RcaEngineUnavailableError('analysis bot returned no JSON verdict');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      logger.error({ incidentId: request.incidentId, rawPreview: raw.slice(0, 300) }, 'RCA verdict JSON failed to parse');
      throw new RcaEngineUnavailableError('analysis bot verdict was not valid JSON');
    }

    const verdict = parsed as { rootCauses?: unknown; recommendations?: unknown; confidence?: unknown };
    const rootCauses = this.validateRootCauses(verdict.rootCauses);
    if (!rootCauses) {
      throw new RcaEngineUnavailableError('analysis bot verdict had no valid rootCauses array');
    }
    const recommendations = this.validateRecommendations(verdict.recommendations);
    const confidence = clamp01(typeof verdict.confidence === 'number' ? verdict.confidence : 0.5);

    return {
      incidentId: request.incidentId,
      method: request.method,
      rootCauses,
      recommendations,
      timestamp: new Date().toISOString(),
      confidence,
    };
  }

  /**
   * @description Validates the rootCauses array from the bot verdict.
   * @param value - Candidate rootCauses value
   * @returns Validated array, or null when the shape is unusable
   */
  private validateRootCauses(value: unknown): RootCause[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const causes: RootCause[] = [];
    for (const entry of value) {
      const c = entry as Partial<RootCause>;
      if (typeof c?.description !== 'string' || c.description.trim() === '') continue;
      causes.push({
        description: c.description.trim(),
        category: typeof c.category === 'string' && c.category.trim() !== '' ? c.category.trim() : 'uncategorized',
        likelihood: clamp01(typeof c.likelihood === 'number' ? c.likelihood : 0.5),
        evidence: Array.isArray(c.evidence) ? c.evidence.filter((e): e is string => typeof e === 'string') : [],
      });
    }
    return causes.length > 0 ? causes : null;
  }

  /**
   * @description Validates the recommendations array from the bot verdict.
   * Recommendations are advisory, so an unusable array degrades to empty rather
   * than failing the whole analysis.
   * @param value - Candidate recommendations value
   * @returns Validated array (possibly empty)
   */
  private validateRecommendations(value: unknown): Recommendation[] {
    if (!Array.isArray(value)) return [];
    const recs: Recommendation[] = [];
    for (const entry of value) {
      const r = entry as Partial<Recommendation>;
      if (typeof r?.action !== 'string' || r.action.trim() === '') continue;
      const priority = r.priority === 'low' || r.priority === 'medium' || r.priority === 'high' || r.priority === 'critical'
        ? r.priority
        : 'medium';
      recs.push({
        action: r.action.trim(),
        priority,
        estimatedEffort: typeof r.estimatedEffort === 'string' ? r.estimatedEffort : 'unknown',
        expectedImpact: typeof r.expectedImpact === 'string' ? r.expectedImpact : 'unknown',
      });
    }
    return recs;
  }
}

/** Clamps a number into [0, 1]; non-finite input clamps to 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
