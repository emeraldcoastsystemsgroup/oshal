/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial shared server logger.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Use the cross-runtime Pino contract on stdout while retaining message/metadata, child and Morgan APIs.
 */
'use strict';

const pino = require('pino');
const { format } = require('node:util');
const config = require('../../../src/shared/logger/pino-config.json');

const raw = pino({
  ...config,
  level: process.env.LOG_LEVEL || config.level,
  name: process.env.SERVICE_NAME || config.name,
  base: {
    ...config.base,
    module: 'any-bot',
    service: process.env.SERVICE_NAME ? `${process.env.SERVICE_NAME}-control-plane` : config.base.service,
    env: process.env.NODE_ENV || config.base.env,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: pino.stdSerializers.err },
}, process.stdout);

/** Normalize legacy metadata without flattening objects or losing Error's stack. */
function metadata(value) {
  if (value instanceof Error) return { err: value };
  if (!value || typeof value !== 'object') return {};
  const fields = { ...value };
  if (fields.error instanceof Error) {
    fields.err ??= fields.error;
    delete fields.error;
  }
  return fields;
}

/** Preserve message-first legacy calls and native object/Error-first Pino calls. */
function write(target, level, first, ...rest) {
  if (typeof first !== 'string') {
    target[level](first instanceof Error ? { err: first } : metadata(first), ...rest);
    return;
  }
  const fields = {};
  const values = [];
  for (const value of rest) {
    if (value && typeof value === 'object') Object.assign(fields, metadata(value));
    else values.push(value);
  }
  target[level](fields, values.length ? format(first, ...values) : first);
}

/**
 * @description Wrap the real Pino instance, retaining the existing server logging API.
 * @param target - Pino logger with shared redaction and serializers.
 * @returns Message-first adapter; structured child bindings are inherited.
 */
function adapt(target) {
  const log = {};
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    log[level] = (...args) => write(target, level, ...args);
  }
  log.child = (bindings) => adapt(target.child(bindings));
  log.log = (level, ...args) => {
    if (typeof level === 'object') {
      const { level: severity, message, ...fields } = level;
      write(target, severity, message, fields);
    } else write(target, level, ...args);
  };
  log.isLevelEnabled = (level) => target.isLevelEnabled(level);
  log.flush = (...args) => target.flush(...args);
  Object.defineProperty(log, 'level', {
    get: () => target.level,
    set: (value) => { target.level = value; },
  });
  log.stream = { write: (message) => log.info(message.trim()) };
  return log;
}

module.exports = adapt(raw);
