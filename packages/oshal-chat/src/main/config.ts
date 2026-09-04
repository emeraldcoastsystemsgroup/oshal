/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added persisted config store (userData/config.json) for control-plane + headscale settings
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added workerEnabled (this node pulls + runs swarm tasks locally) + userEmail (verified-login display)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Seed connection settings from OSHAL_* env vars so the Windows installer can configure a node before its first launch (no settings-pane trip)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis mode settings: fullJarvisEnabled (open the swarm-hosted cockpit on launch) + cockpitPath, seedable via OSHAL_FULL_JARVIS / OSHAL_COCKPIT_PATH
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | cockpitBaseUrl (OSHAL_COCKPIT_BASE_URL): sign-in + cockpit must target the swarm's PUBLIC origin when OIDC lives behind a tunnel — the IdP sets the session cookie there, never on the LAN control-plane origin
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Version desktop settings and make the hosted Full-Jarvis surface the default for new/unset profiles without overriding an explicit orb-only choice.
 */

import { app } from 'electron';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * @description Persisted connection settings for the OSHAL chat client.
 */
export interface OshalChatConfig {
  /** Persisted schema/migration version for desktop settings. */
  configVersion: number;
  /** Base URL of the OSHAL control plane (a tailnet address when using headscale). */
  controlPlaneUrl: string;
  /** Shared secret sent in the auth header (REMOTE_CLIENT_SHARED_SECRET on the server). */
  sharedSecret: string;
  /** Header name the server expects the secret in. */
  authHeaderName: string;
  /** Stable identity for this client in the swarm registry. */
  clientId: string;
  /** Human-readable client name shown in the cockpit mesh view. */
  clientName: string;
  /** Optional target bot/agent id that answers chat turns (blank → server default chat agent). */
  targetAgentId: string;
  /** Optional OIDC sub to scope the bot's per-user connector tokens. */
  userSub: string;
  /** Optional tailnet hostname advertised at registration. */
  tailnetHostname: string;
  /** Optional headscale control-server URL for the built-in VPN connect helper. */
  headscaleLoginServer: string;
  /** Optional headscale pre-auth key for the VPN connect helper. */
  headscaleAuthKey: string;
  /** When true, this node pulls + runs swarm-dispatched tasks locally (it becomes a worker bot). */
  workerEnabled: boolean;
  /** Verified email captured from the swarm OIDC login (display only). */
  userEmail: string;
  /** When true, the swarm may control this machine: screenshot, shell, mouse/keyboard, launch apps. OFF by default. */
  allowSystemControl: boolean;
  /** When true, open the full swarm-hosted Jarvis cockpit window on launch (prompts OIDC sign-in when needed). */
  fullJarvisEnabled: boolean;
  /** Cockpit path the full-Jarvis window loads ('/cockpit/?app=jarvis' default; '/cockpit/' for the framework ribbon). */
  cockpitPath: string;
  /** Base URL for sign-in + the cockpit window (blank → controlPlaneUrl). Set to the swarm's public URL when OIDC runs behind a tunnel — the session cookie only ever lands on that origin. */
  cockpitBaseUrl: string;
  /** One-time enrollment token (`oshal_pat_…`) minted by POST /api/join/enroll for the user who is
   *  attaching this computer. Exchanged once at startup for that user's VERIFIED sub, then cleared —
   *  it is how the node learns who owns it without anyone handing out a swarm-wide secret. */
  enrollmentToken: string;
  /** Explicit opt-in for the desktop node's local background wake-word listener. */
  backgroundWakeEnabled: boolean;
  /** Configurable assistant name used to build the exact local grammar "Hey <name>". */
  wakeAssistantName: string;
  /** When true, this node advertises a print-to-rag printer on ITS OWN network segment while
   *  connected — anyone on that intranet can print into the swarm with no client software and
   *  no credential of their own. OFF by default: it is an outward-facing service. */
  printServiceEnabled: boolean;
  /** Spool folder the print service buffers documents in (blank → a folder beside the app). */
  printServiceSpoolDir: string;
}

export const CURRENT_CONFIG_VERSION = 2;

const DEFAULT_CONFIG: OshalChatConfig = {
  configVersion: CURRENT_CONFIG_VERSION,
  controlPlaneUrl: 'http://localhost:35457',
  sharedSecret: '',
  authHeaderName: 'x-remote-client-key',
  clientId: '',
  clientName: 'OSHAL Chat (desktop)',
  targetAgentId: '',
  userSub: '',
  tailnetHostname: '',
  headscaleLoginServer: '',
  headscaleAuthKey: '',
  workerEnabled: true,
  userEmail: '',
  allowSystemControl: false,
  fullJarvisEnabled: true,
  cockpitPath: '/cockpit/?app=jarvis',
  cockpitBaseUrl: '',
  enrollmentToken: '',
  backgroundWakeEnabled: false,
  wakeAssistantName: 'Jarvis',
  printServiceEnabled: false,
  printServiceSpoolDir: '',
};

/**
 * @description Upgrades persisted desktop settings without overriding choices made after the
 * migration. Version 2 makes the hosted Jarvis cockpit the primary surface because the local node
 * renderer is a text-only fallback and does not own the visual-response contract.
 */
export function migrateConfig(
  persisted: Partial<OshalChatConfig>,
  envSeed: Partial<OshalChatConfig> = {},
): OshalChatConfig {
  const persistedVersion = Number.isInteger(persisted.configVersion)
    ? Number(persisted.configVersion)
    : 0;
  const migrated: OshalChatConfig = { ...DEFAULT_CONFIG, ...persisted };

  if (
    persistedVersion < 2
    && envSeed.fullJarvisEnabled === undefined
    && !Object.prototype.hasOwnProperty.call(persisted, 'fullJarvisEnabled')
  ) migrated.fullJarvisEnabled = true;

  return {
    ...migrated,
    ...envSeed,
    configVersion: CURRENT_CONFIG_VERSION,
  };
}

/**
 * @description Collects connection settings supplied through the environment.
 *
 * The Windows installer (installer/lib/install-node.ps1) launches this app once with the
 * decoded join code in the environment, so a node arrives already pointed at its swarm and
 * the user never opens the settings pane. Only variables that are actually set are returned,
 * so an ordinary launch — the Desktop shortcut carries no environment — leaves the persisted
 * config, and therefore anything the user edited in the UI, untouched.
 *
 * @returns The subset of config supplied by OSHAL_* environment variables.
 */
function readEnvSeed(): Partial<OshalChatConfig> {
  const seed: Partial<OshalChatConfig> = {};
  const {
    OSHAL_CONTROL_PLANE_URL, OSHAL_SHARED_SECRET, OSHAL_AUTH_HEADER, OSHAL_CLIENT_NAME,
    OSHAL_WORKER_ENABLED, OSHAL_FULL_JARVIS, OSHAL_COCKPIT_PATH, OSHAL_COCKPIT_BASE_URL,
    OSHAL_WAKE_NAME, OSHAL_ENROLLMENT_TOKEN, OSHAL_CLIENT_ID,
    OSHAL_PRINT_SERVICE, OSHAL_PRINT_SERVICE_DIR,
  } = process.env;

  // A DEVICE-BOUND token names the device it may register as, so when the swarm mints the
  // credential first -- which is exactly what the cockpit's one-click installer does -- the
  // node has to adopt that id rather than inventing its own. Without this the node minted
  // `oshal-chat-<uuid>` on first run and the control plane refused it: "node-bound token
  // named a different device". Seeded like every other value here, so a later launch reads
  // the persisted id and the settings pane stays authoritative.
  if (OSHAL_CLIENT_ID) {
    seed.clientId = OSHAL_CLIENT_ID;
  }

  if (OSHAL_ENROLLMENT_TOKEN) {
    seed.enrollmentToken = OSHAL_ENROLLMENT_TOKEN;
  }

  if (OSHAL_CONTROL_PLANE_URL) {
    seed.controlPlaneUrl = OSHAL_CONTROL_PLANE_URL.replace(/\/+$/, '');
  }
  if (OSHAL_SHARED_SECRET) {
    seed.sharedSecret = OSHAL_SHARED_SECRET;
  }
  if (OSHAL_AUTH_HEADER) {
    seed.authHeaderName = OSHAL_AUTH_HEADER;
  }
  if (OSHAL_CLIENT_NAME) {
    seed.clientName = OSHAL_CLIENT_NAME;
  }
  if (OSHAL_WORKER_ENABLED) {
    seed.workerEnabled = OSHAL_WORKER_ENABLED !== 'false';
  }
  if (OSHAL_FULL_JARVIS) {
    seed.fullJarvisEnabled = OSHAL_FULL_JARVIS !== 'false';
  }
  if (OSHAL_COCKPIT_PATH) {
    seed.cockpitPath = OSHAL_COCKPIT_PATH;
  }
  if (OSHAL_COCKPIT_BASE_URL) {
    seed.cockpitBaseUrl = OSHAL_COCKPIT_BASE_URL.replace(/\/+$/, '');
  }
  if (OSHAL_WAKE_NAME) {
    seed.wakeAssistantName = OSHAL_WAKE_NAME;
  }
  // Opt-in only: an installer that wants this node to serve its site's intranet sets it
  // explicitly, exactly like worker mode. An ordinary launch leaves the printer off.
  if (OSHAL_PRINT_SERVICE) {
    seed.printServiceEnabled = OSHAL_PRINT_SERVICE !== 'false';
  }
  if (OSHAL_PRINT_SERVICE_DIR) {
    seed.printServiceSpoolDir = OSHAL_PRINT_SERVICE_DIR;
  }
  return seed;
}

/**
 * @description Reads and writes the chat client config as JSON under the Electron
 * userData directory, filling defaults and minting a stable clientId on first run.
 */
export class ConfigStore {
  private readonly filePath: string;
  private cache: OshalChatConfig | null = null;

  constructor() {
    this.filePath = join(app.getPath('userData'), 'config.json');
  }

  /**
   * @description Returns the current config, loading from disk and seeding a clientId once.
   */
  load(): OshalChatConfig {
    if (this.cache) {
      return this.cache;
    }

    let parsed: Partial<OshalChatConfig> = {};
    if (existsSync(this.filePath)) {
      try {
        parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<OshalChatConfig>;
      } catch (error) {
        console.error('[oshal-chat] failed to parse config, using defaults', error);
      }
    }

    // Env last: an explicit OSHAL_* variable is a deliberate act by the installer and
    // outranks both persisted values and versioned migrations.
    const merged = migrateConfig(parsed, readEnvSeed());
    if (!merged.clientId) {
      merged.clientId = `oshal-chat-${randomUUID()}`;
    }
    this.cache = merged;
    this.save(merged);
    return merged;
  }

  /**
   * @description Persists a full or partial config update and returns the merged result.
   */
  save(update: Partial<OshalChatConfig>): OshalChatConfig {
    const next: OshalChatConfig = {
      ...this.load(),
      ...update,
      configVersion: CURRENT_CONFIG_VERSION,
    };
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf-8');
    this.cache = next;
    return next;
  }
}
