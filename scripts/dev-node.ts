/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Host Dev-Node (ADR-077 Phase 2, Option B): a small HTTP server that runs the self-edit engine ON THE HOST (native git + host docker, real repo). The cockpit api proxies super-admin session requests here over host.docker.internal. Auth = a shared secret ONLY the api knows.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Routes moved to the testable createDevNodeApp factory (src/features/dev-console/services/dev-node-app.ts) so the JSON-only contract is guarded by tests/unit/dev-node-json-only.spec.ts. This script is now the thin host entrypoint: env parsing, the >=32-char secret refusal, manager wiring, listen. Behavior change ships with the factory: unmatched paths and body-parser errors answer JSON envelopes instead of Express's HTML "<!DOCTYPE" pages (which the api proxy forwarded verbatim into the cockpit dev pane as `SyntaxError: Unexpected token '<'`).
 */

/**
 * OSHAL Dev-Node — the "muscle" for browser-driven self-editing.
 *
 * The cockpit api is the auth boundary (OIDC super-admin gate); it PROXIES the session routes to
 * this process, which runs where the repo + docker live so worktrees + sandbox volumes work
 * natively (no `.git`-in-container, no docker-in-docker path translation). This process holds NO
 * OIDC — it trusts only the api's shared secret and the caller sub the api forwards. It binds to a
 * host port; keep it behind the shared secret (and, ideally, a firewall rule to the Docker subnet).
 *
 * Run: OSHAL_DEV_NODE_SECRET=<strong> npm run dev:node   (from the repo root)
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import {
  createDevNodeApp,
  DevSessionEngine,
  DevSessionManager,
  DevSessionOrchestrator,
  SandboxedAgentRunner,
} from '@/features/dev-console';

const logger = createChildLogger({ module: 'dev-node' });
const repoRoot = path.resolve(process.env.OSHAL_REPO_ROOT || process.cwd());
const port = Number.parseInt(process.env.OSHAL_DEV_NODE_PORT || '35460', 10);
const secret = (process.env.OSHAL_DEV_NODE_SECRET || '').trim();

if (secret.length < 32) {
  logger.error('OSHAL_DEV_NODE_SECRET must be set (>=32 chars, high-entropy) — refusing to start a network-exposed code-edit endpoint');
  process.exit(1);
}

const manager = new DevSessionManager(
  new DevSessionEngine({ repoRoot }),
  new DevSessionOrchestrator(new DevSessionEngine({ repoRoot }), new SandboxedAgentRunner(), path.join(repoRoot, '..', 'oshal-dev-scratch')),
);

const app = createDevNodeApp({ secret, manager });

// Bind host: defaults to 0.0.0.0 because the api container reaches us via host.docker.internal
// (host-gateway), which is not loopback. This exposes the port on the LAN — the shared secret is
// the gate; firewall the port to the Docker subnet in production. Set OSHAL_DEV_NODE_HOST to a
// specific interface to narrow it.
const host = (process.env.OSHAL_DEV_NODE_HOST || '0.0.0.0').trim();
app.listen(port, host, () => logger.info({ port, host, instanceId: randomUUID().slice(0, 8) }, 'OSHAL dev-node listening (self-edit muscle) — secure the port with a firewall'));
