#!/usr/bin/env node
/**
 * LEGACY — DO NOT DEPLOY
 * Part of the quarantined pre-chart Kubernetes generation. This is the
 * `oshal-any-bot-k8s-setup` bin and the target of the k8:*:any-bot npm scripts. It
 * forwards to scripts/setup-any-bot-k8s.sh, which renders ops/any-bot-k8s with
 * oshal-api-server:latest (an image nothing in this repo builds). The current
 * Kubernetes path is the Helm chart at deploy/helm/oshal: read docs/k8/README.md and
 * docs/adr/129-codeless-k8s-install-path.md. The CLI refuses to run unless
 * OSHAL_ALLOW_LEGACY_K8S=1 is set, so nothing is lost while delete-vs-quarantine is
 * still open (docs/k8/remote-cluster-work-package.md, item 9).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added npm-exposed CLI wrapper for the any-bot Kubernetes setup helper
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized npm exec argument forwarding so local no-registry installs can invoke the wrapper consistently
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Quarantined as legacy (remote-cluster work package item 9): a LEGACY banner, and a refusal in the CLI's own name that runs before it spawns bash, unless OSHAL_ALLOW_LEGACY_K8S=1. The bin reaches anyone who installs the package, so the refusal lives here as well as in the shell script it wraps. Guard: tests/unit/k8s-legacy-quarantine.spec.ts.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** The env var that lets an operator run the quarantined legacy generation anyway. */
const LEGACY_OVERRIDE_ENV = 'OSHAL_ALLOW_LEGACY_K8S';

/**
 * Refuse to run the legacy installer unless the operator opted in explicitly.
 * It runs before any child process starts, so a refused call has no side effects.
 */
function refuseUnlessLegacyAllowed() {
  if (process.env[LEGACY_OVERRIDE_ENV] === '1') return;
  process.stderr.write([
    'REFUSED: scripts/setup-any-bot-k8s-cli.js (the oshal-any-bot-k8s-setup bin) is part of the quarantined legacy Kubernetes generation.',
    'It runs scripts/setup-any-bot-k8s.sh, which renders ops/any-bot-k8s (image oshal-api-server:latest, which nothing in this repo builds).',
    '',
    'The current Kubernetes path is the Helm chart at deploy/helm/oshal:',
    '  bash scripts/oshal-install.sh --mode 4 --admin-email you@example.com',
    'Read docs/k8/README.md and docs/adr/129-codeless-k8s-install-path.md.',
    '',
    `To run this legacy CLI anyway, set ${LEGACY_OVERRIDE_ENV}=1.`,
    '',
  ].join('\n'));
  process.exit(2);
}

/** Forward CLI arguments to the bash-based Kubernetes setup helper. */
function main() {
  refuseUnlessLegacyAllowed();
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
