/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial runtime config loader for RAG and Presentron service settings
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed PresentronRuntimeSettings + readPresentronRuntimeSettings: the only consumer was the retired Presentron HTTP sidecar proxy route. The presentronServiceConfig global-config key itself stays live — it still feeds the separate presentron-mcp MCP server derivation in cline-runtime-config-sync-service (read there directly, not via this loader).
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'runtime-config-loader' });

/**
 * @description Runtime configuration for RAG ingestion/search behavior.
 */
export interface RagRuntimeSettings {
  embeddingProviderId?: string;
  embeddingModelId?: string;
  endpoint?: string;
  defaultCollection?: string;
  chunking?: {
    strategy?: 'sentence' | 'tiered';
    chunkSize?: number;
    chunkOverlap?: number;
    tierSizes?: number[];
    tierOverlaps?: number[];
  };
}

/**
 * @description Runtime configuration for Google Search MCP integration.
 */
export interface GoogleSearchMcpRuntimeSettings {
  url?: string;
  healthcheckPath?: string;
}

/**
 * @description Reads merged runtime settings object from global settings storage.
 *
 * @returns Parsed global settings object or empty object when unavailable.
 */
export function readGlobalRuntimeSettings(): Record<string, unknown> {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = path.join(configDir, 'global-config.json');

  if (!fs.existsSync(settingsPath)) {
    logger.info({ settingsPath }, 'Global runtime settings file not found');
    return {};
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn({ settingsPath }, 'Global runtime settings file does not contain an object payload');
    return {};
  } catch (error) {
    logger.error({ err: error, settingsPath }, 'Failed to read global runtime settings file');
    return {};
  }
}

/**
 * @description Reads typed RAG runtime settings from global configuration.
 *
 * @returns RAG runtime settings with safe defaults.
 */
export function readRagRuntimeSettings(): RagRuntimeSettings {
  const settings = readGlobalRuntimeSettings();
  const raw = settings.ragServiceConfig;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const config = raw as Record<string, unknown>;
  const chunking = readChunkingConfig(config.chunking);

  return {
    embeddingProviderId: readOptionalString(config.embeddingProviderId),
    embeddingModelId: readOptionalString(config.embeddingModelId),
    endpoint: readOptionalString(config.endpoint),
    defaultCollection: readOptionalString(config.defaultCollection),
    chunking,
  };
}

/**
 * @description Reads typed Google Search MCP runtime settings from global configuration.
 *
 * @returns Google Search MCP runtime settings with safe defaults.
 */
export function readGoogleSearchMcpRuntimeSettings(): GoogleSearchMcpRuntimeSettings {
  const settings = readGlobalRuntimeSettings();
  const raw = settings.googleSearchMcpConfig;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const config = raw as Record<string, unknown>;
  return {
    url: readOptionalString(config.url),
    healthcheckPath: readOptionalString(config.healthcheckPath),
  };
}

/**
 * @description Reads validated chunking configuration object.
 *
 * @param value - Raw chunking config payload.
 * @returns Normalized chunking configuration or undefined.
 */
function readChunkingConfig(value: unknown): RagRuntimeSettings['chunking'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const chunking = value as Record<string, unknown>;
  const strategy = readOptionalString(chunking.strategy);

  return {
    strategy: strategy === 'tiered' ? 'tiered' : 'sentence',
    chunkSize: readOptionalNumber(chunking.chunkSize),
    chunkOverlap: readOptionalNumber(chunking.chunkOverlap),
    tierSizes: readOptionalNumberArray(chunking.tierSizes),
    tierOverlaps: readOptionalNumberArray(chunking.tierOverlaps),
  };
}

/**
 * @description Reads a non-empty string from unknown input.
 *
 * @param value - Raw input value.
 * @returns Trimmed string when valid.
 */
function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Reads a positive numeric value from unknown input.
 *
 * @param value - Raw input value.
 * @returns Positive number when valid.
 */
function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * @description Reads an array of positive numeric values from unknown input.
 *
 * @param value - Raw input value.
 * @returns Normalized array of positive numbers.
 */
function readOptionalNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((item) => readOptionalNumber(item))
    .filter((item): item is number => typeof item === 'number');

  return normalized.length > 0 ? normalized : undefined;
}
