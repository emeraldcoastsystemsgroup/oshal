/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The `rating:` block validator (ADR-170 D2/D9/D10, plus the operator's 2026-09-29 ask for container memory low/high per application). VALUES fail the load exactly as `suite:` does, so a typo'd tier cannot invent a fifth one; PRESENCE is warn-only so installed pre-170 packages keep booting and the ledger lists them as unrated. Own file so the loader gains one call, not a block.
 */

import { createChildLogger } from '@/shared/logger';
import {
  APP_RATING_DEGRADES,
  APP_RATING_GENERATIONS,
  APP_RATING_MEMORY_BASES,
  APP_RATING_TIERS,
  isAppRatingDegrade,
  isAppRatingGeneration,
  isAppRatingMemoryBasis,
  isAppRatingTier,
  type AppRatingFeature,
  type AppRatingMemory,
  type SwarmAppManifest,
} from '../types';

const logger = createChildLogger({ module: 'swarm-app-rating' });

/** Upper bound on a declared container size in MiB (1 TiB): a figure typed in bytes must not pass as MiB. */
export const APP_RATING_MEMORY_MAX_MB = 1_048_576;

const RATING_KEYS: ReadonlySet<string> = new Set(['memoryMb', 'features']);
const MEMORY_KEYS: ReadonlySet<string> = new Set(['low', 'high', 'basis']);
const FEATURE_KEYS: ReadonlySet<string> = new Set([
  'id', 'unit', 'tier', 'generation', 'degrade', 'contextFloor', 'reducedEdition',
]);
const FEATURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(absPath: string, at: string, message: string): never {
  throw new Error(`Manifest ${absPath}: ${at} ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, absPath: string, at: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(absPath, at, `has unknown field(s): ${unknown.join(', ')}. Known: ${[...allowed].join(', ')}`);
  }
}

/**
 * @description Validate `rating.memoryMb`: positive integer MiB, low no greater than high, high
 * under the 1 TiB sanity cap, basis one of the closed set (default `declared`).
 * @param value - The raw `memoryMb` mapping from the manifest.
 * @param absPath - Manifest path, for the error message.
 * @returns The normalised memory declaration.
 */
function validateRatingMemory(value: unknown, absPath: string): AppRatingMemory {
  const at = 'rating.memoryMb';
  if (!isRecord(value)) fail(absPath, at, 'must be a mapping { low, high, basis? } in MiB');
  rejectUnknownKeys(value, MEMORY_KEYS, absPath, at);
  const { low, high } = value;
  if (!isPositiveInteger(low) || !isPositiveInteger(high)) {
    fail(absPath, at, 'low and high must be positive integers (MiB)');
  }
  if (low > high) fail(absPath, at, `low (${low}) must not exceed high (${high})`);
  if (high > APP_RATING_MEMORY_MAX_MB) {
    fail(absPath, at, `high (${high}) exceeds ${APP_RATING_MEMORY_MAX_MB} MiB; the unit is MiB, not bytes`);
  }
  const basis = value.basis === undefined ? 'declared' : value.basis;
  if (!isAppRatingMemoryBasis(basis)) {
    fail(absPath, at, `basis "${String(basis)}" is not one of ${APP_RATING_MEMORY_BASES.join(', ')}`);
  }
  return { low, high, basis };
}

/**
 * @description Validate one `rating.features[]` entry against the closed tier, generation and
 * degrade sets, require a unit and a unique kebab-case id, and require `reducedEdition` text
 * whenever the feature degrades to `reduced`.
 * @param value - The raw feature mapping.
 * @param index - Its position, for the error message.
 * @param seen - Ids already declared in this manifest.
 * @param absPath - Manifest path, for the error message.
 * @returns The normalised feature.
 */
function validateRatingFeature(value: unknown, index: number, seen: Set<string>, absPath: string): AppRatingFeature {
  const at = `rating.features[${index}]`;
  if (!isRecord(value)) fail(absPath, at, 'must be a mapping { id, unit, tier, generation, degrade }');
  rejectUnknownKeys(value, FEATURE_KEYS, absPath, at);
  const { id, unit, tier, generation, degrade, contextFloor, reducedEdition } = value;
  if (typeof id !== 'string' || !FEATURE_ID.test(id)) fail(absPath, at, 'id must be a kebab-case string');
  if (seen.has(id)) fail(absPath, at, `id "${id}" is declared twice`);
  seen.add(id);
  if (typeof unit !== 'string' || unit.trim() === '') {
    fail(absPath, at, 'unit must name the thing one transaction is (an email, a deck, a tutoring turn)');
  }
  if (!isAppRatingTier(tier)) {
    fail(absPath, at, `tier "${String(tier)}" is not one of ${APP_RATING_TIERS.join(', ')} (ADR-170 D1)`);
  }
  if (!isAppRatingGeneration(generation)) {
    fail(absPath, at, `generation "${String(generation)}" is not one of ${APP_RATING_GENERATIONS.join(', ')}`);
  }
  if (!isAppRatingDegrade(degrade)) {
    fail(absPath, at, `degrade "${String(degrade)}" is not one of ${APP_RATING_DEGRADES.join(', ')}`);
  }
  if (contextFloor !== undefined && !isPositiveInteger(contextFloor)) {
    fail(absPath, at, 'contextFloor must be a positive integer (tokens)');
  }
  if (reducedEdition !== undefined && (typeof reducedEdition !== 'string' || reducedEdition.trim() === '')) {
    fail(absPath, at, 'reducedEdition must be non-empty text saying what the reduced edition drops');
  }
  if (degrade === 'reduced' && reducedEdition === undefined) {
    fail(absPath, at, 'degrade: reduced requires reducedEdition to say what the reduced edition drops');
  }
  return {
    id,
    unit: unit.trim(),
    tier,
    generation,
    degrade,
    ...(contextFloor !== undefined ? { contextFloor } : {}),
    ...(reducedEdition !== undefined ? { reducedEdition: reducedEdition.trim() } : {}),
  };
}

/**
 * @description Validate a manifest's optional `rating:` block (ADR-170) and replace it with the
 * normalised form. A missing block warns and returns, so installed pre-170 packages keep booting
 * and the ledger lists them as unrated; any present but malformed value fails the load, because a
 * label the loader gates on (D4) must never carry a value the loader would not enforce.
 * @param manifest - The parsed manifest; `rating` is rewritten in place when present.
 * @param absPath - Manifest path, for messages.
 * @returns Nothing; throws on a malformed block.
 */
export function validateAppRating(manifest: SwarmAppManifest, absPath: string): void {
  const raw: unknown = (manifest as { rating?: unknown }).rating;
  if (raw === undefined) {
    logger.warn(
      { path: absPath, name: manifest.name },
      'Manifest declares no rating (ADR-170) — the ledger lists it as unrated until one is added',
    );
    return;
  }
  if (!isRecord(raw)) fail(absPath, 'rating', 'must be a mapping { memoryMb, features }');
  rejectUnknownKeys(raw, RATING_KEYS, absPath, 'rating');
  const memoryMb = validateRatingMemory(raw.memoryMb, absPath);
  if (!Array.isArray(raw.features)) {
    fail(absPath, 'rating.features', 'must be a list; an empty list means no model-touching feature (T0)');
  }
  const seen = new Set<string>();
  const features = raw.features.map((feature, index) => validateRatingFeature(feature, index, seen, absPath));
  manifest.rating = { memoryMb, features };
}
