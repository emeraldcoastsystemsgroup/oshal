/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of structured JSON logger using Pino
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated logger naming from legacy namespace to OSHAL and normalized Change Log format
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added file transport — verbose debug logs to output/logs/OSHAL.log (user requested readable log file)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Redaction hardening: OAuth credential keys (accessToken/access_token/refreshToken/refresh_token/bearer + one-level wildcard variants) were missing from the redact list and could reach logs verbatim. Extracted the list as the exported LOG_REDACT_OPTIONS (same object the singleton uses) so tests/unit/logger-redaction.spec.ts asserts the exact shipped config; public API otherwise unchanged.
 */

import pino from 'pino';
import path from 'path';
import fs from 'fs';

/**
 * @description The platform-wide pino redaction config — the SINGLE list of secret-bearing
 * field paths censored out of every log line (top-level keys, one-level `*.` wildcards, and
 * nested request-header paths). Exported so the redaction regression spec exercises the exact
 * object the production logger ships with, not a copy that can drift.
 */
export const LOG_REDACT_OPTIONS: { paths: string[]; censor: string } = {
  paths: [
    'anthropicApiKey',
    'openRouterApiKey',
    'bedrockAccessKey',
    'bedrockSecretKey',
    'openAiApiKey',
    'geminiApiKey',
    'openAiNativeApiKey',
    'deepSeekApiKey',
    'mistralApiKey',
    'clineApiKey',
    'clineAccountId',
    'password',
    'token',
    'secret',
    'authorization',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'bearer',
    'req.headers.authorization',
    'req.headers.cookie',
    '*.apiKey',
    '*.secretKey',
    '*.accessKey',
    '*.password',
    '*.token',
    '*.accessToken',
    '*.access_token',
    '*.refreshToken',
    '*.refresh_token',
    '*.bearer',
  ],
  censor: '[REDACTED]',
};

/**
 * @description Default Pino logger configuration for the OSHAL platform.
 * Produces structured JSON logs with field-level redaction of sensitive data.
 * All public methods, API routes, and catch blocks must use this logger
 * per .clinerules/logging.md ("Flight Recorder" mandate).
 *
 * @returns Configured Pino logger instance
 */
function createLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  // Check if pino-pretty is available (may be missing in production Docker builds)
  let usePretty = false;
  if (isDev) {
    try {
      require.resolve('pino-pretty');
      usePretty = true;
    } catch {
      // pino-pretty not available, fall back to JSON logging
      usePretty = false;
    }
  }

  return pino({
    level,
    name: process.env.SERVICE_NAME || 'OSHAL',

    // Redact sensitive fields from logs (API keys, passwords, tokens)
    redact: LOG_REDACT_OPTIONS,

    // File + console transport: always write debug-level JSON to output/logs/OSHAL.log
    // plus human-readable console output in development
    transport: (() => {
      const logDir = path.resolve(process.cwd(), 'output', 'logs');
      try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
      const logFile = path.join(logDir, `${process.env.SERVICE_NAME || 'OSHAL'}.log`);

      const targets: pino.TransportTargetOptions[] = [
        // Always write debug-level JSON logs to file
        {
          target: 'pino/file',
          options: { destination: logFile, mkdir: true },
          level: 'debug',
        },
        // Always write JSON to stdout (visible via `docker logs`)
        {
          target: 'pino/file',
          options: { destination: 1 },
          level: level as string,
        },
      ];

      // Add pretty console output in dev if available (replaces raw JSON stdout)
      if (usePretty) {
        targets.pop(); // remove raw JSON stdout
        targets.push({
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
          level: level as string,
        });
      }

      return { targets };
    })(),

    // Base context added to every log line
    base: {
      service: process.env.SERVICE_NAME ? `${process.env.SERVICE_NAME}-control-plane` : 'OSHAL-control-plane',
      env: process.env.NODE_ENV || 'development',
    },

    // Timestamp format
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * @description Singleton logger instance for the application.
 * Import this from '@/shared/logger' in all modules.
 */
export const logger = createLogger();

/**
 * @description Creates a child logger with additional context.
 * Use for module-specific logging that carries context automatically.
 *
 * @param bindings - Key-value pairs to attach to every log from this child
 * @returns Child logger instance with inherited config + additional bindings
 */
export function createChildLogger(
  bindings: Record<string, unknown>,
): pino.Logger {
  return logger.child(bindings);
}
