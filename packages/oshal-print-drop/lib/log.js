/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — minimal structured JSON-line logger for this standalone package (mirrors the core repo's Pino shape — ts/level/module/msg + fields — without dragging Pino into a client utility's dependency tree). One line per event on stdout so a service wrapper can redirect to a file.
 */
'use strict';

/**
 * @description Emit one JSON log line.
 * @param {string} level The severity (info|warn|error).
 * @param {string} moduleName The emitting module.
 * @param {string} msg The event message.
 * @param {object} [fields] Extra structured fields.
 * @returns {void}
 */
function emit(level, moduleName, msg, fields) {
  const line = { ts: new Date().toISOString(), level, module: moduleName, msg, ...(fields || {}) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * @description Create a child logger bound to a module name.
 * @param {string} moduleName The module label for every line.
 * @returns {{info:Function,warn:Function,error:Function}} The logger.
 */
function createLogger(moduleName) {
  return {
    info: (msg, fields) => emit('info', moduleName, msg, fields),
    warn: (msg, fields) => emit('warn', moduleName, msg, fields),
    error: (msg, fields) => emit('error', moduleName, msg, fields),
  };
}

module.exports = { createLogger };
