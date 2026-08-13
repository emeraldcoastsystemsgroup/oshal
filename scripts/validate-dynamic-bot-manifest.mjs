/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-129 amendment 2) — real-boundary check for the dynamic bot launcher. The unit spec asserts the manifest SHAPE, which is not closure for "the Kubernetes API accepts this": a mock cannot reject an invalid field, a bad probe, or a malformed selector. This renders the exact manifest the launcher POSTs and pushes it through `kubectl apply --dry-run` — server-side when a cluster is reachable (the API server itself validates and admits, creating nothing), client-side otherwise. Run it against any cluster; it never creates a resource.
 *
 * Usage: npx tsx scripts/validate-dynamic-bot-manifest.mjs [--namespace oshal] [--context ctx]
 *        (tsx, not bare node: the launcher uses parameter properties, which Node's
 *         native type-stripping rejects with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const namespace = flag('--namespace', 'oshal');
const context = flag('--context', '');

const { buildBotDeployment, buildBotService } = await import(
  pathToFileURL(path.resolve('src/features/agent-management/services/kubernetes-bot-launcher.ts')).href
);

const kubectl = (a, input) => spawnSync('kubectl', [...(context ? ['--context', context] : []), ...a], { input, encoding: 'utf8' });
const reachable = kubectl(['cluster-info']).status === 0;
// A server dry-run is admitted INTO a namespace, so it needs one that exists.
// Admission of this manifest is namespace-independent, so fall back to `default`
// rather than creating a namespace just to validate.
let target = namespace;
if (reachable && kubectl(['get', 'namespace', namespace]).status !== 0) {
  target = 'default';
  console.log(`namespace "${namespace}" not present on this cluster — validating in "default" instead (nothing is created)`);
}

const spec = {
  agentName: 'validate-dynamic-bot',
  agentId: 'a0000000-0000-0000-0000-0000000000ff',
  capabilities: 'validation',
  personaFile: '/app/workspace-shared/deployed-apps/example/personas/validate-dynamic-bot.yaml',
};
const image = process.env.OSHAL_BOT_IMAGE ?? 'ghcr.io/emeraldcoastsystemsgroup/oshal-bot:latest';
const manifests = [
  buildBotDeployment(spec, target, image),
  buildBotService(spec.agentName, target),
];
const doc = manifests.map((m) => JSON.stringify(m)).join('\n---\n');

const mode = reachable ? 'server' : 'client';
const res = kubectl(['apply', '-f', '-', '-n', target, `--dry-run=${mode}`], doc);
const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
console.log(`dry-run mode: ${mode}${reachable ? ' (validated by the real API server; nothing created)' : ' (no cluster reachable — schema only)'}`);
console.log(out);

if (res.status !== 0) {
  console.error('\nFAILED: the Kubernetes API rejected the manifest the launcher would POST.');
  process.exit(1);
}
if (mode === 'client') {
  console.warn('\nWARNING: client-side only. Re-run against a cluster for real admission validation.');
}
console.log('\nOK: the dynamic bot manifest is accepted by kubectl apply --dry-run.');
