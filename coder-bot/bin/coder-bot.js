#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Launcher for the standalone Coder Bot. It stays a three-line shim on purpose: `Start-Coder-Bot.bat` and `npm start` both come through here, so all defaulting (port, proactive monitoring, capture delay) lives in one place — src/server.js — and a double-clicked start and a CLI start cannot drift into two different configurations.
 */

'use strict';

const { start } = require('../src/server');

start();
