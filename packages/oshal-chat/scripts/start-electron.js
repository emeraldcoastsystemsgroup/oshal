#!/usr/bin/env node

const { spawn } = require('child_process');
const electron = require('electron');

const args = process.argv.slice(2);
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, args.length ? args : ['.'], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`${electron} exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
