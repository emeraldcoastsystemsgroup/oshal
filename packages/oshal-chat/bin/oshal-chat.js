#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added npx launcher that boots the Electron app from the package root
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Resolve the electron binary shipped with this package and launch the app
// rooted at the package directory so `npx @oshal/chat` opens the desktop window.
const electron = require('electron');
const appRoot = path.resolve(__dirname, '..');

const child = spawn(electron, [appRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
