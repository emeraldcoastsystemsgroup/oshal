/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-129 amendment 2) — the Kubernetes sibling of the compose bot spawner, so an app package that brings its own bot-node launches it on a cluster too. Talks to the in-cluster API directly over HTTPS with the pod's ServiceAccount token (no new dependency, and nothing to keep in sync with a client library); renders the SAME workload shape as the chart's bots.yaml so a dynamically-launched bot is indistinguishable from a chart-declared one (bot-entrypoint.sh command, oshal-shared-env + oshal-bot-env envFrom, workspace PVC, Service named for the bot because the controller dials http://<name>:5000). SECURITY: the image is ALWAYS the platform image from env and never caller-supplied — a caller-chosen image would turn agent creation into arbitrary container execution; the name is DNS-1123-validated before it reaches an API path; and RBAC is a namespace-scoped Role (never a ClusterRole), so the blast radius is the tenant's own namespace.
 */

import { readFileSync, existsSync } from 'fs';
import https from 'https';
import { createChildLogger } from '@/shared/logger';
import {
  BOT_NAME_PATTERN,
  type BotLaunchResult,
  type BotLaunchSpec,
  type BotRuntimeLauncher,
} from './bot-runtime-launcher';

const logger = createChildLogger({ module: 'kubernetes-bot-launcher' });

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** @description In-cluster ServiceAccount credentials + target namespace. */
interface ClusterAccess {
  host: string;
  port: string;
  token: string;
  ca?: Buffer;
  namespace: string;
}

/**
 * @description Read the pod's ServiceAccount credentials.
 * @param saDir override for tests
 * @returns cluster access, or null when not running in a pod
 */
export function readClusterAccess(saDir: string = SA_DIR): ClusterAccess | null {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) return null;
  try {
    const token = readFileSync(`${saDir}/token`, 'utf8').trim();
    const namespace =
      process.env.OSHAL_NAMESPACE ?? readFileSync(`${saDir}/namespace`, 'utf8').trim();
    const caPath = `${saDir}/ca.crt`;
    return { host, port, token, namespace, ca: existsSync(caPath) ? readFileSync(caPath) : undefined };
  } catch (err) {
    logger.error({ err }, 'ServiceAccount credentials unreadable — cannot launch bot runtimes');
    return null;
  }
}

/**
 * @description Minimal Kubernetes API call over the pod's ServiceAccount. Kept as
 * a raw request on purpose: the surface is three verbs on two resource types, and
 * a client library would be a large dependency for it.
 * @param access cluster credentials
 * @param method HTTP verb
 * @param path API path (already namespace-scoped)
 * @param body optional JSON payload
 * @param contentType override (server-side apply uses a patch content type)
 * @returns {Promise<{status: number, body: string}>}
 */
function apiRequest(
  access: ClusterAccess,
  method: string,
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<{ status: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: access.host,
        port: access.port,
        path,
        method,
        ca: access.ca,
        headers: {
          Authorization: `Bearer ${access.token}`,
          'Content-Type': contentType,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @description Build the Deployment for a dynamically-launched bot. Mirrors the
 * chart's bots.yaml so a runtime created here and one declared in values are the
 * same shape — same entrypoint, same shared env, same workspace volume.
 * @param spec bot identity + persona
 * @param namespace release namespace
 * @param image platform bot image (never caller-supplied)
 * @returns Deployment manifest
 */
export function buildBotDeployment(
  spec: BotLaunchSpec,
  namespace: string,
  image: string,
): Record<string, unknown> {
  const env: Array<{ name: string; value: string }> = [
    { name: 'BOT_RUNTIME', value: 'bot-node' },
    { name: 'BOT_NAME', value: spec.agentName },
    { name: 'AGENT_ID', value: spec.agentId },
    {
      name: 'BOT_PERSONA_FILE',
      value: spec.personaFile ?? `/app/ai-lab/bot-personas/${spec.agentName}.yaml`,
    },
  ];
  if (spec.capabilities) env.push({ name: 'AGENT_CAPABILITIES', value: spec.capabilities });
  // Bots connect as the least-privilege role (K5) — never the superuser DSN.
  if (process.env.BOT_DATABASE_URL) env.push({ name: 'DATABASE_URL', value: process.env.BOT_DATABASE_URL });
  for (const [name, value] of Object.entries(spec.extraEnv ?? {})) env.push({ name, value });

  const labels = {
    'app.kubernetes.io/name': spec.agentName,
    'app.kubernetes.io/part-of': 'oshal',
    'oshal.io/bot': 'true',
    // Marks this runtime as controller-created, so an operator can tell it from a
    // chart-declared bot and `helm upgrade` never adopts or deletes it.
    'oshal.io/dynamic': 'true',
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: spec.agentName, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': spec.agentName } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'bot',
              image,
              imagePullPolicy: process.env.OSHAL_IMAGE_PULL_POLICY ?? 'IfNotPresent',
              command: ['/bin/sh', '-c'],
              args: ['exec bash /app/scripts/bot-entrypoint.sh'],
              envFrom: [
                { configMapRef: { name: 'oshal-shared-env' } },
                { secretRef: { name: 'oshal-bot-env', optional: true } },
              ],
              env,
              ports: [{ containerPort: 5000 }],
              readinessProbe: {
                tcpSocket: { port: 5000 },
                initialDelaySeconds: 15,
                periodSeconds: 10,
                failureThreshold: 12,
              },
              volumeMounts: [
                { name: 'workspace', mountPath: '/app/workspace-shared' },
                { name: 'output', mountPath: '/app/output' },
              ],
            },
          ],
          volumes: [
            { name: 'workspace', persistentVolumeClaim: { claimName: 'oshal-workspace' } },
            { name: 'output', emptyDir: {} },
          ],
        },
      },
    },
  };
}

/**
 * @description Build the Service. The name IS the DNS the controller dials
 * (BotNodeClient → http://<name>:5000), which is why it must equal the bot name.
 * @param name bot slug
 * @param namespace release namespace
 * @returns Service manifest
 */
export function buildBotService(name: string, namespace: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/name': name, 'oshal.io/bot': 'true', 'oshal.io/dynamic': 'true' },
    },
    spec: {
      selector: { 'app.kubernetes.io/name': name },
      ports: [{ name: 'http', port: 5000, targetPort: 5000 }],
    },
  };
}

/**
 * @description Launches bot runtimes as Deployments in the controller's own
 * namespace, so an installed app's bots come up with the app on Kubernetes the
 * same way they do under compose.
 */
export class KubernetesBotRuntimeLauncher implements BotRuntimeLauncher {
  readonly runtime = 'kubernetes' as const;

  constructor(
    private readonly access: ClusterAccess,
    private readonly image: string = process.env.OSHAL_BOT_IMAGE ??
      process.env.BOT_IMAGE ??
      'ghcr.io/emeraldcoastsystemsgroup/oshal-bot:latest',
  ) {}

  /**
   * @description Build one from ambient pod credentials.
   * @returns launcher, or null when not in a cluster / no ServiceAccount
   */
  static fromEnvironment(): KubernetesBotRuntimeLauncher | null {
    const access = readClusterAccess();
    return access ? new KubernetesBotRuntimeLauncher(access) : null;
  }

  /**
   * @description Create-or-update the Deployment + Service for this bot.
   * @param spec bot identity + persona
   * @returns {Promise<BotLaunchResult>}
   */
  async launch(spec: BotLaunchSpec): Promise<BotLaunchResult> {
    if (!BOT_NAME_PATTERN.test(spec.agentName)) {
      return { success: false, runtime: this.runtime, error: `invalid bot name: ${spec.agentName}` };
    }
    const ns = this.access.namespace;
    const deployment = buildBotDeployment(spec, ns, this.image);
    const service = buildBotService(spec.agentName, ns);
    try {
      const dep = await this.upsert(
        `/apis/apps/v1/namespaces/${ns}/deployments`,
        `/apis/apps/v1/namespaces/${ns}/deployments/${spec.agentName}`,
        deployment,
      );
      if (!dep.ok) return { success: false, runtime: this.runtime, error: dep.error };
      const svc = await this.upsert(
        `/api/v1/namespaces/${ns}/services`,
        `/api/v1/namespaces/${ns}/services/${spec.agentName}`,
        service,
      );
      if (!svc.ok) return { success: false, runtime: this.runtime, error: svc.error };
      logger.info({ name: spec.agentName, agentId: spec.agentId, namespace: ns }, 'bot runtime launched (kubernetes)');
      return { success: true, runtime: this.runtime };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, name: spec.agentName }, 'kubernetes bot launch failed');
      return { success: false, runtime: this.runtime, error };
    }
  }

  /**
   * @description Delete the Deployment and Service for this bot.
   * @param agentName bot slug
   * @returns {Promise<BotLaunchResult>}
   */
  async remove(agentName: string): Promise<BotLaunchResult> {
    if (!BOT_NAME_PATTERN.test(agentName)) {
      return { success: false, runtime: this.runtime, error: `invalid bot name: ${agentName}` };
    }
    const ns = this.access.namespace;
    try {
      for (const path of [
        `/apis/apps/v1/namespaces/${ns}/deployments/${agentName}`,
        `/api/v1/namespaces/${ns}/services/${agentName}`,
      ]) {
        const res = await apiRequest(this.access, 'DELETE', path);
        // 404 is success for a remove — the runtime is gone either way.
        if (res.status >= 400 && res.status !== 404) {
          return { success: false, runtime: this.runtime, error: `${res.status}: ${res.body}` };
        }
      }
      return { success: true, runtime: this.runtime };
    } catch (err) {
      return { success: false, runtime: this.runtime, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * @description POST to create; on 409 (already exists) PUT to replace. Chosen
   * over server-side apply so the call works on older API servers too.
   * @param collectionPath resource collection
   * @param itemPath the named resource
   * @param manifest object to create/replace
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  private async upsert(
    collectionPath: string,
    itemPath: string,
    manifest: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const created = await apiRequest(this.access, 'POST', collectionPath, manifest);
    if (created.status < 300) return { ok: true };
    if (created.status !== 409) return { ok: false, error: `${created.status}: ${created.body}` };
    const replaced = await apiRequest(this.access, 'PUT', itemPath, manifest);
    if (replaced.status < 300) return { ok: true };
    return { ok: false, error: `${replaced.status}: ${replaced.body}` };
  }
}
