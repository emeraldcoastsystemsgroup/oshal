/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for shared logger
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution/timestamps per governance rules
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Re-export LOG_REDACT_OPTIONS so the redaction regression spec (and any future consumer) reaches the shipped redact config through the barrel instead of deep-importing logger.ts
 */

/**
 * @description Barrel export for the structured logging module.
 * Import from '@/shared/logger' — never deep-import logger.ts directly.
 */
export { logger, createChildLogger, LOG_REDACT_OPTIONS } from './logger';
