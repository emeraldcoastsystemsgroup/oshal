/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-129 amendment 2) — real-boundary check for the dynamic bot launcher. The unit spec asserts the manifest SHAPE, which is not closure for "the Kubernetes API accepts this": a mock cannot reject an invalid field, a bad probe, or a malformed selector. This renders the exact manifest the launcher POSTs and pushes it through `kubectl apply --dry-run` — server-side when a cluster is reachable (the API server itself validates and admits, creating nothing), client-side otherwise. Run it against any cluster; it never creates a resource.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Also asks the live API server whether the enable/disable toggle target exists: the cockpit toggle scales a bot Deployment through the scale SUBRESOURCE, and a unit spec that captures the outgoing request cannot prove that path is real or that it accepts PATCH. kubectl get --raw /apis/apps/v1 is the API server own discovery document, naming deployments/scale and the verbs it accepts, and it creates nothing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | New --require-server mode, and the default mode's client-side result is labelled NOT A PROOF. This script is cited as the live-boundary closure for the k8s launcher (chart README, ADR-129, the real-boundary audit), yet with no reachable cluster it ran a client-side dry-run, printed a warning, skipped the deployments/scale discovery and EXITED 0 - a zero exit that proved nothing about any API server. Under --require-server an unreachable cluster (or a missing kubectl) exits 2 before any fallback, a dry-run whose output does not say "(server dry run)" for every object exits 1, and the discovery check can no longer be skipped. The default mode is kept for the offline shape check and has no automated caller; scripts/ci/check-cluster-gates.sh is the gate that runs --require-server, and tests/unit/validate-dynamic-bot-manifest-require-server.spec.ts holds both modes to this.
 *
 * Usage: npx tsx scripts/validate-dynamic-bot-manifest.mjs [--require-server] [--namespace oshal] [--context ctx]
 *        (tsx, not bare node: the launcher uses parameter properties, which Node's
 *         native type-stripping rejects with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.)
 *
 *   --require-server  the only mode that is evidence. It refuses (exit 2) when no API server
 *                     answers, fails (exit 1) unless the API server itself admitted every
 *                     object and exposes deployments/scale with PATCH, and never falls back
 *                     to a client-side dry-run.
 *   (default)         with a reachable cluster, the same server-side checks. With none, a
 *                     client-side dry-run labelled NOT A PROOF that still exits 0 - a shape
 *                     check for a box with no cluster, never closure evidence.
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
const requireServer = args.includes('--require-server');

const { buildBotDeployment, buildBotService } = await import(
  pathToFileURL(path.resolve('src/features/agent-management/services/kubernetes-bot-launcher.ts')).href
);

const kubectl = (a, input) => spawnSync('kubectl', [...(context ? ['--context', context] : []), ...a], { input, encoding: 'utf8' });
const probe = kubectl(['cluster-info']);
const reachable = probe.status === 0;
if (requireServer && !reachable) {
  const why = probe.error?.code === 'ENOENT'
    ? 'kubectl is not on PATH'
    : `kubectl cluster-info did not succeed: ${`${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim() || probe.error?.message || 'no output'}`;
  console.error(`FAILED (--require-server): no API server reachable${context ? ` at context "${context}"` : ''} - ${why}.`);
  console.error('A client-side dry-run proves nothing about an API server, so this mode does not fall back to one.');
  process.exit(2);
}
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
// kubectl marks every object a server-side dry-run admitted "(server dry run)". A zero exit whose
// output lacks that mark for any object is not evidence that an API server saw it.
const serverAdmitted = (out.match(/\(server dry run\)/g) ?? []).length;
if (requireServer && serverAdmitted < manifests.length) {
  console.error(`\nFAILED (--require-server): only ${serverAdmitted} of ${manifests.length} objects report "(server dry run)" - the API server did not admit them all.`);
  process.exit(1);
}
if (mode === 'client') {
  console.warn('\nWARNING: client-side only - NOT A PROOF. No API server saw this manifest; re-run with --require-server against a cluster for admission evidence.');
  console.log('\nOK (client-side shape check only): kubectl apply --dry-run=client accepted the dynamic bot manifest.');
} else {
  console.log('\nOK: the dynamic bot manifest is accepted by kubectl apply --dry-run=server.');
}

// The cockpit enable/disable toggle PATCHes
// /apis/apps/v1/namespaces/<ns>/deployments/<name>/scale. Ask the API server's own
// discovery document whether that subresource exists and accepts PATCH. Read-only —
// discovery creates and modifies nothing. --require-server exited above when unreachable,
// so in that mode this check always runs.
if (reachable) {
  const discovery = kubectl(['get', '--raw', '/apis/apps/v1']);
  if (discovery.status !== 0) {
    console.error('FAILED: could not read /apis/apps/v1 from the API server.');
    console.error(`${discovery.stdout ?? ''}${discovery.stderr ?? ''}`.trim());
    process.exit(1);
  }
  let resources;
  try {
    resources = JSON.parse(discovery.stdout).resources ?? [];
  } catch (err) {
    console.error(`FAILED: /apis/apps/v1 did not return JSON: ${err.message}`);
    process.exit(1);
  }
  const scale = resources.find((r) => r.name === 'deployments/scale');
  if (!scale) {
    console.error('FAILED: this API server does not expose deployments/scale — the toggle path does not exist here.');
    process.exit(1);
  }
  const verbs = scale.verbs ?? [];
  if (!verbs.includes('patch')) {
    console.error(`FAILED: deployments/scale does not accept patch here (verbs: ${verbs.join(', ')}).`);
    process.exit(1);
  }
  console.log(`OK: the API server exposes deployments/scale with verbs [${verbs.join(', ')}] — the enable/disable toggle PATCHes that path.`);
} else {
  console.warn('WARNING: no cluster reachable — deployments/scale was not confirmed against a real API server. NOT A PROOF.');
}
