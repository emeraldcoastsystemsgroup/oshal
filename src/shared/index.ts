/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for shared layer
 */

/**
 * @description Barrel export for the shared layer.
 * Import from '@/shared' — never deep-import sub-modules directly.
 */
export * from './types';
export { logger, createChildLogger } from './logger';