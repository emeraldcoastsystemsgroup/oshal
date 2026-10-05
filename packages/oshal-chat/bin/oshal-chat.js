#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added npx launcher that boots the Electron app from the package root
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drop ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE before launching Electron (as scripts/start-electron.js does). Installed from a VS Code terminal, the node inherited them and exited instead of opening its window (DGX Spark, 2026-10-05).
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Resolve the electron binary shipped with this package and launch the app
// rooted at the package directory so `npx @oshal/chat` opens the desktop window.
const electron = require('electron');
const appRoot = path.resolve(__dirname, '..');

// A terminal inside VS Code (itself an Electron app) exports ELECTRON_RUN_AS_NODE=1. Inherited,
// it makes Electron run main.js as plain Node, so the app exits instead of opening a window.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electron, [appRoot, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
