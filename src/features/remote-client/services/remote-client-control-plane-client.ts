/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added control-plane HTTP client for remote-client registration and polling
 */

import { createChildLogger } from '@/shared/logger';
import {
  A2ATaskResultSchema,
  RemoteClientHeartbeatSchema,
  RemoteClientRegistrationSchema,
  type A2ATaskResult,
  type RemoteClientHeartbeat,
  type RemoteClientRegistration,
} from '@/shared/types';
import {
  RemoteClientClaimResponseSchema,
  RemoteClientHeartbeatResponseSchema,
  RemoteClientRegistrationResponseSchema,
  RemoteClientSwarmSendRequestSchema,
  RemoteClientSwarmSendResponseSchema,
  type RemoteClientClaimResponse,
  type RemoteClientConfig,
  type RemoteClientHeartbeatResponse,
  type RemoteClientRegistrationResponse,
  type RemoteClientSwarmSendResponse,
  RemoteClientTaskCompletionSchema,
} from '../types';

const logger = createChildLogger({ module: 'remote-client-control-plane' });

/**
 * @description A non-OK response from the control plane, carrying the status for the caller.
 *
 * The previous bare `Error` discarded the status into a message string, so the daemon could not
 * distinguish "the control plane forgot my registration" (recoverable — re-register) from "the
 * control plane is broken" (retry later). That is why an orphaned client polled forever instead
 * of healing.
 */
export class ControlPlaneHttpError extends Error {
  /** HTTP status returned by the control plane. */
  readonly status: number;

  /** Machine-readable `code` from the error body, when the control plane supplied one. */
  readonly code: string | null;

  /**
   * @description Builds a control-plane HTTP error.
   * @param status - HTTP status code.
   * @param code - Machine-readable code from the response body, if present.
   * @param body - Truncated response body for diagnostics.
   */
  constructor(status: number, code: string | null, body: string) {
    super(`Control-plane request failed: ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ControlPlaneHttpError';
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** Truncated response body, kept for diagnostics. */
  readonly body: string;

  /**
   * @description Whether this response means the control plane has no registration for us.
   *
   * Keyed on the explicit code first and the bare 404 second, so a control plane predating the
   * code still heals — an old server is exactly the case where the daemon must not wedge.
   *
   * @returns True when re-registering is the correct response.
   */
  get isUnregistered(): boolean {
    return this.code === 'remote_client_unregistered' || this.status === 404;
  }
}

/**
 * @description HTTP client that talks to OSHAL's remote-client registry API.
 */
export class RemoteClientControlPlaneClient {
  private readonly config: RemoteClientConfig;

  constructor(config: RemoteClientConfig) {
    this.config = config;
  }

  /**
   * @description Registers this remote client with OSHAL.
   */
  async register(registration: RemoteClientRegistration): Promise<RemoteClientRegistrationResponse> {
    const payload = RemoteClientRegistrationSchema.parse(registration);
    const response = await fetch(this.url('/api/remote-clients/register'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    return this.parseResponse(response, RemoteClientRegistrationResponseSchema);
  }

  /**
   * @description Sends a heartbeat to OSHAL.
   */
  async heartbeat(heartbeat: RemoteClientHeartbeat): Promise<RemoteClientHeartbeatResponse> {
    const payload = RemoteClientHeartbeatSchema.parse(heartbeat);
    const response = await fetch(this.url(`/api/remote-clients/${encodeURIComponent(this.config.clientId)}/heartbeat`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    return this.parseResponse(response, RemoteClientHeartbeatResponseSchema);
  }

  /**
   * @description Claims the next task for this remote client.
   */
  async claimNextTask(): Promise<RemoteClientClaimResponse> {
    const response = await fetch(this.url(`/api/remote-clients/${encodeURIComponent(this.config.clientId)}/tasks/next`), {
      method: 'GET',
      headers: this.headers(),
    });

    if (response.status === 204) {
      return { claimed: false, task: null };
    }

    return this.parseResponse(response, RemoteClientClaimResponseSchema);
  }

  /**
   * @description Posts a completed task result.
   */
  async completeTask(result: unknown): Promise<A2ATaskResult> {
    const payload = RemoteClientTaskCompletionSchema.parse(result);
    const response = await fetch(
      this.url(`/api/remote-clients/${encodeURIComponent(this.config.clientId)}/tasks/${encodeURIComponent(payload.taskId)}/complete`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
    return this.parseResponse(response, A2ATaskResultSchema);
  }

  /**
   * @description Posts a failed task result.
   */
  async failTask(result: unknown): Promise<A2ATaskResult> {
    const payload = RemoteClientTaskCompletionSchema.parse(result);
    const response = await fetch(
      this.url(`/api/remote-clients/${encodeURIComponent(this.config.clientId)}/tasks/${encodeURIComponent(payload.taskId)}/fail`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
    return this.parseResponse(response, A2ATaskResultSchema);
  }

  /**
   * @description Publishes one remote-client initiated message into swarm mesh routing.
   */
  async sendSwarmMessage(message: unknown): Promise<RemoteClientSwarmSendResponse> {
    const payload = RemoteClientSwarmSendRequestSchema.parse(message);
    const response = await fetch(
      this.url(`/api/remote-clients/${encodeURIComponent(this.config.clientId)}/swarm/send`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
    return this.parseResponse(response, RemoteClientSwarmSendResponseSchema);
  }

  /**
   * @description Builds a fully qualified control-plane URL.
   */
  private url(path: string): string {
    return `${this.config.controlPlaneUrl.replace(/\/$/, '')}${path}`;
  }

  /**
   * @description Builds request headers for control-plane calls.
   */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.config.controlPlaneToken) {
      headers[this.config.authHeaderName] = this.config.controlPlaneToken;
      headers.authorization = `Bearer ${this.config.controlPlaneToken}`;
    }

    return headers;
  }

  /**
   * @description Parses a JSON response into a typed schema.
   */
  private async parseResponse<T>(response: Response, schema: { parse: (value: unknown) => T }): Promise<T> {
    const raw = await response.text();
    if (!response.ok) {
      const code = this.readErrorCode(raw);
      // An unregistered client is a routine post-restart condition the caller heals from, so it
      // logs at WARN — logging it at ERROR on every poll is what buried real faults before.
      const detail = { status: response.status, code, body: raw.slice(0, 500) };
      if (code === 'remote_client_unregistered' || response.status === 404) {
        logger.warn(detail, 'Control plane has no registration for this client — re-registration required');
      } else {
        logger.error(detail, 'Control-plane request failed');
      }
      throw new ControlPlaneHttpError(response.status, code, raw.slice(0, 500));
    }

    const parsed = raw.length > 0 ? JSON.parse(raw) as unknown : {};
    return schema.parse(parsed);
  }

  /**
   * @description Extracts a machine-readable `code` from an error response body.
   *
   * Tolerates a non-JSON body (a proxy's HTML error page is a realistic response on this path)
   * by returning null rather than throwing — a parse failure here must not mask the HTTP status,
   * which is the part the caller actually needs.
   *
   * @param raw - Raw response body.
   * @returns The `code` field, or null when absent or unparseable.
   */
  private readErrorCode(raw: string): string | null {
    if (raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as { code?: unknown };
      return typeof parsed.code === 'string' && parsed.code.length > 0 ? parsed.code : null;
    } catch {
      return null;
    }
  }
}
