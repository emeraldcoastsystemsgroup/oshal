/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial UIProfileService — loads profile JSON from config-seed/profiles
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | De-brand (visible leak): dropped the orphaned legacy-brand key from the built-in fallback profile ribbon — no RibbonNav catalog entry backed it, so it rendered nothing; keeps the retired brand out of the default cockpit.
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { UIProfile } from '../types';

const logger = createChildLogger({ module: 'ui-profile-service' });

const DEFAULT_PROFILE_NAME = 'oshal-framework';
const PROFILE_DIR_CANDIDATES = [
  path.resolve(process.cwd(), 'config-seed/profiles'),
  path.resolve(process.cwd(), '../config-seed/profiles'),
];

/**
 * Resolves the profile directory that actually exists in this runtime. The
 * container and local-dev paths differ, so we probe a small candidate list
 * instead of hardcoding one.
 */
function resolveProfileDir(): string | null {
  for (const candidate of PROFILE_DIR_CANDIDATES) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Reads and validates a single profile file. Returns null on missing or
 * malformed input so callers can fall back to the default.
 */
function readProfileFile(dir: string, name: string): UIProfile | null {
  const filePath = path.join(dir, `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as UIProfile;
    if (!parsed.name || !parsed.ribbon || !Array.isArray(parsed.ribbon.items)) {
      logger.warn({ filePath }, 'Profile file missing required fields; ignoring');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to read profile file');
    return null;
  }
}

/**
 * @description Fluent accessor for UI profile config. Caches the on-disk
 * profiles after first read and exposes lookup + listing helpers for the
 * profile route.
 */
export class UIProfileService {
  private cache = new Map<string, UIProfile>();
  private dir: string | null;

  /**
   * @description Resolves the profile directory once at construction and logs
   * whether a directory was found, so lookups know up front whether they must
   * rely on the built-in fallback.
   */
  constructor() {
    this.dir = resolveProfileDir();
    if (!this.dir) {
      logger.warn({ candidates: PROFILE_DIR_CANDIDATES }, 'No profile directory found; profile lookups will fall back to built-in default');
    } else {
      logger.info({ dir: this.dir }, 'UIProfileService initialised');
    }
  }

  /** Name of the profile selected via env var, or the hardcoded default. */
  getEnvSelectedName(): string {
    return process.env.UI_PROFILE?.trim() || DEFAULT_PROFILE_NAME;
  }

  /**
   * @description Loads a profile by name, using a built-in fallback if the
   * on-disk file is missing (keeps the app running before first deploy).
   * @param name - profile name (file stem)
   * @returns the matching UIProfile
   */
  load(name: string): UIProfile {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const fromDisk = this.dir ? readProfileFile(this.dir, name) : null;
    const profile = fromDisk ?? this.builtInFallback(name);
    this.cache.set(name, profile);
    return profile;
  }

  /**
   * @description Lists names of all available profiles (for the settings
   * switcher). Falls back to just the default name when the directory is
   * missing.
   */
  list(): string[] {
    if (!this.dir) return [DEFAULT_PROFILE_NAME];
    try {
      return fs
        .readdirSync(this.dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
    } catch (err) {
      logger.error({ err, dir: this.dir }, 'Failed to list profiles');
      return [DEFAULT_PROFILE_NAME];
    }
  }

  /**
   * Built-in fallback — an all-visible framework profile, used when no
   * on-disk config exists. Keeps the cockpit fully operational out of the box.
   */
  private builtInFallback(name: string): UIProfile {
    logger.info({ name }, 'Using built-in fallback profile (on-disk file missing)');
    return {
      name,
      displayName: 'OSHAL Framework',
      description: 'Default full-operator profile (built-in fallback)',
      ribbon: {
        items: ['tickets', 'chat', 'calendar', 'addressbook', 'dashboard', 'logs', 'settings', 'operations'],
        dynamicTools: { allow: ['*'] },
      },
      defaultView: 'tickets',
    };
  }

  /**
   * Clears cache — useful for dev reloads after editing a profile JSON.
   */
  reload(): void {
    this.cache.clear();
    logger.info('UIProfileService cache cleared');
  }
}

/**
 * @description Public alias for the hardcoded default profile name, exposed so
 * other modules can reference the default without importing the internal const.
 */
export const DEFAULT_UI_PROFILE_NAME = DEFAULT_PROFILE_NAME;
