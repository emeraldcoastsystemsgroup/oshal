#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added npm-exposed CLI wrapper for the any-bot Kubernetes setup helper
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized npm exec argument forwarding so local no-registry installs can invoke the wrapper consistently
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** Forward CLI arguments to the bash-based Kubernetes setup helper. */
function main() {
  const scriptPath = path.resolve(__dirname, 'setup-any-bot-k8s.sh');
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const result = spawnSync('/bin/bash', [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

main();