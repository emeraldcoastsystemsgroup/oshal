/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the authenticated /api/harvest surface the
 *                     |                             | harvest console reads. Two endpoints only: the illustrative
 *                     |                             | site/soil catalogue, and one simulate call that adapts a posted
 *                     |                             | design onto the marine or ground slice through their barrels.
 *                     |                             | Every numeric input is bounded here rather than trusted,
 *                     |                             | because simulateEnergyBudget integrates ceil(duration/step)
 *                     |                             | timesteps SYNCHRONOUSLY on the controller's only thread — an
 *                     |                             | unbounded {durationHours, stepSeconds} pair is a one-request
 *                     |                             | denial of service against the whole swarm controller, not a
 *                     |                             | slow response. The step-count and retained-sample ceilings are
 *                     |                             | the load-bearing ones: bounding duration and step INDEPENDENTLY
 *                     |                             | still admits 20000 h at 1 s (72 million steps).
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  MODERATE_INLET_SITE,
  STRONG_CHANNEL_SITE,
  simulatePowerBudget,
  type MarineUnitConfig,
} from '@/features/marine';
import {
  DEFAULT_SOIL,
  DRY_SAND_SOIL,
  WET_CLAY_SOIL,
  simulateGroundBudget,
  type GroundUnitConfig,
} from '@/features/ground';
import {
  DEFAULT_DURATION_HOURS,
  type EnergyBudgetSample,
  type EnergyBudgetVerdict,
  type PowerLoad,
  type StorageConfig,
} from '@/shared/energy';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'harvest-routes' });

/** @description The two harvest domains this surface can simulate. */
export type HarvestDomain = 'marine' | 'ground';

/** @description Integration step, in seconds, when the caller does not name one. Mirrors the core. */
export const DEFAULT_STEP_SECONDS = 60;

/** @description Plot-sample spacing, in minutes, when the caller does not name one. Mirrors the core. */
export const DEFAULT_SAMPLE_EVERY_MINUTES = 30;

/**
 * @description Every bound this route enforces, in one exported table so the console can
 * pre-validate a form against the SAME numbers the server rejects on (GET /sites returns it) and
 * so a guard can assert the ceilings rather than re-deriving them. `maxIntegrationSteps` and
 * `maxRetainedSamples` are the real CPU/memory ceilings — the per-field bounds above them only
 * keep a single parameter sane, and a pair of individually-sane parameters can still ask for a
 * 72-million-step run.
 */
export const HARVEST_LIMITS = {
  /** Longest simulated span, hours (~2.3 years — far past any spring/neap or annual cycle). */
  maxDurationHours: 20_000,
  /** Shortest simulated span, hours. Below this a run cannot contain one tide cycle. */
  minDurationHours: 0.1,
  /** Finest integration step, seconds. */
  minStepSeconds: 1,
  /** Coarsest integration step, seconds (one day). */
  maxStepSeconds: 86_400,
  /** Finest plot-sample spacing, minutes. */
  minSampleEveryMinutes: 1,
  /** Coarsest plot-sample spacing, minutes (one week). */
  maxSampleEveryMinutes: 10_080,
  /** Hard ceiling on ceil(durationHours*3600/stepSeconds) — the synchronous integration loop. */
  maxIntegrationSteps: 2_000_000,
  /** Hard ceiling on the samples the simulation may retain in memory before downsampling. */
  maxRetainedSamples: 50_000,
  /** Samples actually returned; the retained series is strided down to this. */
  maxResponseSamples: 2_000,
  /** Longest load list accepted. */
  maxLoads: 64,
  /** Longest tidal constituent list accepted. */
  maxConstituents: 32,
  /** Longest thermoelectric junction-pair list accepted. */
  maxJunctionPairs: 32,
  /** Longest accepted name/label string. */
  maxNameLength: 120,
} as const;

/**
 * @description Raised by the validators below and turned into a 400 by {@link harvestRoute}.
 * A distinct class (rather than a sentinel return) is what lets a validator that is eight frames
 * deep reject with a field-accurate message without every caller in between forwarding a null.
 */
export class HarvestInputError extends Error {
  /**
   * @description Builds the rejection carrying the operator-facing reason.
   * @param message - Which field failed and what was expected; surfaced verbatim in the 400 body.
   */
  constructor(message: string) {
    super(message);
    this.name = 'HarvestInputError';
    Object.setPrototypeOf(this, HarvestInputError.prototype);
  }
}

/**
 * @description Reject the request with a field-accurate reason.
 * @param message - Which field failed and what was expected.
 * @returns Never — always throws {@link HarvestInputError}.
 */
function bad(message: string): never {
  throw new HarvestInputError(message);
}

/**
 * @description Narrow an unknown to a plain object. Arrays are rejected explicitly: `typeof []`
 * is 'object', so without this an array would flow into the field readers and every lookup would
 * silently yield undefined instead of a named rejection.
 * @param value - The candidate.
 * @param label - Dotted path used in the rejection message.
 * @returns The value as a record.
 */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * @description Read a required, finite, in-range number. `Number.isFinite` is the load-bearing
 * check: JSON.parse turns `1e999` into Infinity, and Infinity passes every `<`/`>` comparison a
 * range check can make while making the integration loop produce NaN forever.
 * @param src - Object being validated.
 * @param key - Field name.
 * @param label - Dotted path of `src` for the message.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @returns The validated number.
 */
function num(src: Record<string, unknown>, key: string, label: string, min: number, max: number): number {
  const raw = src[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) bad(`${label}.${key} must be a finite number`);
  const value = raw as number;
  if (value < min || value > max) bad(`${label}.${key} must be between ${min} and ${max}`);
  return value;
}

/**
 * @description Read an optional number. Absent stays absent — it is NOT coerced to zero, so a
 * slice's own documented default (a geothermal gradient, a phase lag) still applies.
 * @param src - Object being validated.
 * @param key - Field name.
 * @param label - Dotted path of `src` for the message.
 * @param min - Inclusive lower bound when present.
 * @param max - Inclusive upper bound when present.
 * @returns The validated number, or undefined when the field was omitted or null.
 */
function optNum(src: Record<string, unknown>, key: string, label: string, min: number, max: number): number | undefined {
  const raw = src[key];
  if (raw === undefined || raw === null) return undefined;
  return num(src, key, label, min, max);
}

/**
 * @description Read a required, length-bounded, non-blank string. Labels are echoed back in the
 * verdict, so an unbounded one is a payload amplifier.
 * @param src - Object being validated.
 * @param key - Field name.
 * @param label - Dotted path of `src` for the message.
 * @returns The trimmed string.
 */
function text(src: Record<string, unknown>, key: string, label: string): string {
  const raw = src[key];
  if (typeof raw !== 'string' || !raw.trim()) bad(`${label}.${key} must be a non-empty string`);
  const value = (raw as string).trim();
  if (value.length > HARVEST_LIMITS.maxNameLength) {
    bad(`${label}.${key} must be at most ${HARVEST_LIMITS.maxNameLength} characters`);
  }
  return value;
}

/**
 * @description Read a required, non-empty, length-bounded array. The cap matters because each
 * entry is evaluated once per timestep: 5000 loads over a 43200-step run is 216 million
 * multiply-adds from a 100 kB request body.
 * @param src - Object being validated.
 * @param key - Field name.
 * @param label - Dotted path of `src` for the message.
 * @param max - Longest accepted array.
 * @returns The array.
 */
function list(src: Record<string, unknown>, key: string, label: string, max: number): unknown[] {
  const raw = src[key];
  if (!Array.isArray(raw)) bad(`${label}.${key} must be an array`);
  const values = raw as unknown[];
  if (values.length === 0) bad(`${label}.${key} must not be empty`);
  if (values.length > max) bad(`${label}.${key} must hold at most ${max} entries`);
  return values;
}

/**
 * @description Validate the load set shared by both domains.
 * @param src - The posted config object.
 * @param label - Dotted path of `src` for messages.
 * @returns Validated loads.
 */
function parseLoads(src: Record<string, unknown>, label: string): PowerLoad[] {
  return list(src, 'loads', label, HARVEST_LIMITS.maxLoads).map((raw, i) => {
    const at = `${label}.loads[${i}]`;
    const load = asRecord(raw, at);
    return {
      name: text(load, 'name', at),
      watts: num(load, 'watts', at, 0, 1e6),
      dutyCycle: num(load, 'dutyCycle', at, 0, 1),
    };
  });
}

/**
 * @description Validate the energy store shared by both domains. capacityWh has a positive floor
 * because it is the denominator of every SoC fraction in the verdict — a zero capacity reports
 * NaN perpetuality rather than failing.
 * @param src - The posted config object.
 * @param label - Dotted path of `src` for messages.
 * @returns Validated store.
 */
function parseStorage(src: Record<string, unknown>, label: string): StorageConfig {
  const at = `${label}.storage`;
  const storage = asRecord(src.storage, at);
  return {
    capacityWh: num(storage, 'capacityWh', at, 0.001, 1e9),
    initialSocFraction: num(storage, 'initialSocFraction', at, 0, 1),
    roundTripEfficiency: num(storage, 'roundTripEfficiency', at, 0.01, 1),
    usableDepthOfDischarge: num(storage, 'usableDepthOfDischarge', at, 0.01, 1),
  };
}

/**
 * @description Validate a tidal site: its harmonic constituents plus any steady residual flow.
 * @param raw - The posted `config.site`.
 * @returns Validated site.
 */
function parseTidalSite(raw: unknown): MarineUnitConfig['site'] {
  const site = asRecord(raw, 'config.site');
  const constituents = list(site, 'constituents', 'config.site', HARVEST_LIMITS.maxConstituents).map((entry, i) => {
    const at = `config.site.constituents[${i}]`;
    const c = asRecord(entry, at);
    return {
      name: text(c, 'name', at),
      periodHours: num(c, 'periodHours', at, 0.01, 2_000),
      amplitudeMs: num(c, 'amplitudeMs', at, 0, 50),
      phaseDeg: optNum(c, 'phaseDeg', at, -3_600, 3_600) ?? 0,
    };
  });
  return {
    name: text(site, 'name', 'config.site'),
    constituents,
    residualMs: optNum(site, 'residualMs', 'config.site', -50, 50),
  };
}

/**
 * @description Validate a full marine design. `powerCoefficient` is allowed up to 1 rather than
 * clamped at Betz (16/27): the console exists to let an operator see that an above-Betz rotor is
 * what made a design "work", which a silent clamp would hide.
 * @param raw - The posted `config`.
 * @returns Validated marine unit config.
 */
function parseMarineConfig(raw: unknown): MarineUnitConfig {
  const config = asRecord(raw, 'config');
  const at = 'config.turbine';
  const turbine = asRecord(config.turbine, at);
  return {
    site: parseTidalSite(config.site),
    turbine: {
      sweptAreaM2: num(turbine, 'sweptAreaM2', at, 0, 1e6),
      powerCoefficient: num(turbine, 'powerCoefficient', at, 0, 1),
      drivetrainEfficiency: num(turbine, 'drivetrainEfficiency', at, 0, 1),
      cutInSpeedMs: num(turbine, 'cutInSpeedMs', at, 0, 50),
      ratedPowerW: num(turbine, 'ratedPowerW', at, 0, 1e9),
    },
    loads: parseLoads(config, 'config'),
    storage: parseStorage(config, 'config'),
  };
}

/**
 * @description Validate a soil profile. The diffusivity window spans every real soil, rock and
 * saturated clay (1e-9 .. 1e-3 m²/s) — outside it the damping depth degenerates and the
 * temperature model stops meaning anything.
 * @param raw - The posted `config.soil`.
 * @returns Validated soil profile.
 */
function parseSoil(raw: unknown): GroundUnitConfig['soil'] {
  const at = 'config.soil';
  const soil = asRecord(raw, at);
  return {
    name: text(soil, 'name', at),
    thermalDiffusivityM2S: num(soil, 'thermalDiffusivityM2S', at, 1e-9, 1e-3),
    thermalConductivityWmK: num(soil, 'thermalConductivityWmK', at, 0.001, 1_000),
    meanTempC: num(soil, 'meanTempC', at, -100, 100),
    annualAmplitudeC: num(soil, 'annualAmplitudeC', at, 0, 100),
    diurnalAmplitudeC: num(soil, 'diurnalAmplitudeC', at, 0, 100),
    geothermalGradientKM: optNum(soil, 'geothermalGradientKM', at, 0, 10),
    annualPhaseDeg: optNum(soil, 'annualPhaseDeg', at, -3_600, 3_600),
    diurnalPhaseDeg: optNum(soil, 'diurnalPhaseDeg', at, -3_600, 3_600),
  };
}

/**
 * @description Validate one thermoelectric junction pair and its module.
 * @param raw - The posted pair.
 * @param at - Dotted path for messages.
 * @returns Validated junction pair.
 */
function parseJunctionPair(raw: unknown, at: string): GroundUnitConfig['pairs'][number] {
  const pair = asRecord(raw, at);
  const modAt = `${at}.module`;
  const mod = asRecord(pair.module, modAt);
  return {
    name: text(pair, 'name', at),
    hotDepthM: num(pair, 'hotDepthM', at, 0, 1_000),
    coldDepthM: num(pair, 'coldDepthM', at, 0, 1_000),
    module: {
      collectorAreaM2: num(mod, 'collectorAreaM2', modAt, 0, 1e6),
      moduleResistanceKW: num(mod, 'moduleResistanceKW', modAt, 1e-6, 1e6),
      ztBar: num(mod, 'ztBar', modAt, 0, 10),
      ratedPowerW: num(mod, 'ratedPowerW', modAt, 0, 1e9),
      cutInPowerW: num(mod, 'cutInPowerW', modAt, 0, 1e9),
    },
  };
}

/**
 * @description Validate a full ground design.
 * @param raw - The posted `config`.
 * @returns Validated ground unit config.
 */
function parseGroundConfig(raw: unknown): GroundUnitConfig {
  const config = asRecord(raw, 'config');
  const pairs = list(config, 'pairs', 'config', HARVEST_LIMITS.maxJunctionPairs).map((entry, i) =>
    parseJunctionPair(entry, `config.pairs[${i}]`),
  );
  return {
    soil: parseSoil(config.soil),
    pairs,
    loads: parseLoads(config, 'config'),
    storage: parseStorage(config, 'config'),
  };
}

/** @description Span/step/sampling for one run, every field resolved to a concrete number. */
export interface ResolvedHarvestOptions {
  /** Simulated span, hours. */
  durationHours: number;
  /** Integration step, seconds. */
  stepSeconds: number;
  /** Plot-sample spacing, minutes. */
  sampleEveryMinutes: number;
}

/**
 * @description Validate the run options and — the part that actually protects the controller —
 * reject the COMBINATIONS that are expensive even though each field is individually in range.
 * Two derived ceilings, mirroring exactly how simulateEnergyBudget spends time and memory:
 * ceil(duration*3600/step) synchronous timesteps, and steps/sampleEvery retained sample objects.
 * @param raw - The posted `options`, or undefined.
 * @returns Fully resolved options.
 */
export function parseHarvestOptions(raw: unknown): ResolvedHarvestOptions {
  const opts = raw === undefined || raw === null ? {} : asRecord(raw, 'options');
  const durationHours =
    optNum(opts, 'durationHours', 'options', HARVEST_LIMITS.minDurationHours, HARVEST_LIMITS.maxDurationHours) ??
    DEFAULT_DURATION_HOURS;
  const stepSeconds =
    optNum(opts, 'stepSeconds', 'options', HARVEST_LIMITS.minStepSeconds, HARVEST_LIMITS.maxStepSeconds) ??
    DEFAULT_STEP_SECONDS;
  const sampleEveryMinutes =
    optNum(opts, 'sampleEveryMinutes', 'options', HARVEST_LIMITS.minSampleEveryMinutes, HARVEST_LIMITS.maxSampleEveryMinutes) ??
    DEFAULT_SAMPLE_EVERY_MINUTES;

  const steps = Math.ceil((durationHours * 3600) / stepSeconds);
  if (steps > HARVEST_LIMITS.maxIntegrationSteps) {
    bad(
      `options.durationHours/stepSeconds ask for ${steps} integration steps; the cap is ` +
        `${HARVEST_LIMITS.maxIntegrationSteps} — raise stepSeconds or shorten durationHours`,
    );
  }
  // Mirrors the core's own stride derivation, so this ceiling counts the objects it really keeps.
  const stride = Math.max(1, Math.round((sampleEveryMinutes * 60) / stepSeconds));
  const retained = Math.ceil(steps / stride);
  if (retained > HARVEST_LIMITS.maxRetainedSamples) {
    bad(
      `options would retain ${retained} plot samples; the cap is ${HARVEST_LIMITS.maxRetainedSamples} — ` +
        `raise sampleEveryMinutes`,
    );
  }
  return { durationHours, stepSeconds, sampleEveryMinutes };
}

/**
 * @description Stride a retained series down to at most `max` points, always keeping the final
 * sample. The last point is what tells a reader whether the run CLOSED — dropping it because the
 * stride did not divide evenly would make the plot disagree with the verdict beside it. The
 * strided pass therefore stops one slot short and the tail is appended into it: appending
 * unconditionally after a full pass would return max+1 points and quietly break the cap this
 * function exists to enforce.
 * @param samples - The retained series.
 * @param max - Most points to return. Must be at least 1.
 * @returns The downsampled series (the input itself when already short enough).
 */
export function downsampleSamples<T>(samples: T[], max: number): T[] {
  if (samples.length <= max) return samples;
  const stride = Math.ceil(samples.length / max);
  const out: T[] = [];
  for (let i = 0; i < samples.length && out.length < max - 1; i += stride) out.push(samples[i]);
  out.push(samples[samples.length - 1]);
  return out;
}

/** @description What a simulate call produces, before the samples are strided for the wire. */
interface HarvestRunResult {
  verdict: EnergyBudgetVerdict;
  samples: EnergyBudgetSample[];
}

/**
 * @description Run the validated design on whichever slice owns the domain. This is the only
 * place the two domains meet, and they meet by shape alone — both slices return the shared
 * core's verdict, so nothing here knows about tides or boreholes.
 * @param domain - Which slice to run.
 * @param config - The posted, still-unvalidated config for that domain.
 * @param options - Resolved span/step/sampling.
 * @returns Verdict plus the retained series.
 */
function runSimulation(domain: HarvestDomain, config: unknown, options: ResolvedHarvestOptions): HarvestRunResult {
  return domain === 'marine'
    ? simulatePowerBudget(parseMarineConfig(config), options)
    : simulateGroundBudget(parseGroundConfig(config), options);
}

/**
 * @description Wrap a handler with entry/exit logging and the two failure postures: a rejected
 * input is a 400 that names the field (the console renders it beside the offending control), and
 * anything else is a 500 that logs the stack and tells the caller nothing about it.
 * @param operation - Route name for the logs.
 * @param handler - The synchronous handler.
 * @returns An Express handler.
 */
function harvestRoute(operation: string, handler: (req: Request, res: Response) => void): RequestHandler {
  return (req, res) => {
    const startedAt = Date.now();
    logger.info({ operation, method: req.method }, 'Harvest route entered');
    try {
      handler(req, res);
      logger.info({ operation, status: res.statusCode, durationMs: Date.now() - startedAt }, 'Harvest route completed');
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof HarvestInputError) {
        logger.warn({ operation, reason: error.message, durationMs }, 'Harvest route rejected invalid input');
        res.status(400).json({ error: 'invalid_harvest_request', message: error.message });
        return;
      }
      logger.error({ err: error, operation, durationMs }, 'Harvest route failed');
      res.status(500).json({ error: 'harvest_simulation_failed' });
    }
  };
}

/**
 * @description GET /sites — the illustrative catalogue the console's pickers are built from,
 * plus the exact bounds POST /simulate enforces, so the form rejects locally on the SAME numbers
 * the server rejects on instead of maintaining a second copy that drifts.
 * @param _req - Unused; the catalogue is identical for every caller.
 * @param res - Express response.
 * @returns Nothing; responds with the catalogue.
 */
function handleSites(_req: Request, res: Response): void {
  res.json({
    illustrative: true,
    note:
      'Plausible parameter sets, NOT survey data. Replace the tidal harmonic constants with the ' +
      'published constants for your station, and the soil properties with a site thermal survey, ' +
      'before treating any verdict as site-specific.',
    marine: [STRONG_CHANNEL_SITE, MODERATE_INLET_SITE],
    ground: [DEFAULT_SOIL, DRY_SAND_SOIL, WET_CLAY_SOIL],
    limits: HARVEST_LIMITS,
    defaults: {
      durationHours: DEFAULT_DURATION_HOURS,
      stepSeconds: DEFAULT_STEP_SECONDS,
      sampleEveryMinutes: DEFAULT_SAMPLE_EVERY_MINUTES,
    },
  });
}

/**
 * @description POST /simulate { domain, config, options } — one closed-loop run, answered as the
 * verdict plus a series strided down to the wire cap.
 * @param req - Express request carrying the posted design.
 * @param res - Express response.
 * @returns Nothing; responds with the verdict and series, or throws HarvestInputError.
 */
function handleSimulate(req: Request, res: Response): void {
  const body = asRecord(req.body, 'body');
  const domain = body.domain;
  if (domain !== 'marine' && domain !== 'ground') bad("body.domain must be 'marine' or 'ground'");
  // Options FIRST: the cost ceilings are what stop an expensive run, so they must be cleared
  // before a config large enough to be worth validating is walked.
  const options = parseHarvestOptions(body.options);
  const result = runSimulation(domain, body.config, options);
  res.json({
    domain,
    options,
    verdict: result.verdict,
    samples: downsampleSamples(result.samples, HARVEST_LIMITS.maxResponseSamples),
    retainedSampleCount: result.samples.length,
  });
}

/**
 * @description Builds the harvest console's API. `requiresAuth` is a PARAMETER, not an import:
 * express-openid-connect runs with authRequired:false, so an unwrapped route is anonymous — and
 * applying the guard per-route inside the factory means a future re-mount cannot accidentally
 * widen it, and a unit guard can prove the 401 without booting the whole server.
 * @param requiresAuth - The OIDC guard middleware from the server's oidc setup.
 * @returns Express router mounted at `/api/harvest`.
 */
export function createHarvestRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();
  router.get('/sites', requiresAuth, harvestRoute('sites', handleSites));
  router.post('/simulate', requiresAuth, harvestRoute('simulate', handleSimulate));
  return router;
}
