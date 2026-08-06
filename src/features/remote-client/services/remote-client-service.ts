/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client runtime service for local MCP execution and control-plane sync
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Self-heal a lost registration instead of wedging. register() ran ONCE in start() and never again, while the control-plane registry is in-memory — so any api restart orphaned the node and every later poll/heartbeat failed forever until a human restarted the machine (the documented #1 failure of the remote-execution path; 188 errors from one client in 24h). Poll and heartbeat now re-register on an unregistered response and retry, sharing one in-flight attempt and floored to one per heartbeat interval so two timers cannot flood. Also fixed the heartbeat timer callbacks: `void p` does not handle a rejection, so a failing heartbeat became an unhandled rejection that Node terminates the process on by default.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Serialize overlapping poll ticks with one in-flight promise and refuse to claim while currentTaskId is set, preventing duplicate claim/execution when a slow task outlives the polling interval.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Deliver one-use browser-task callbacks from trusted daemon metadata after execution; capability, subject, URL, and operation never enter MCP arguments or model context.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Separate execution/result-parse failure from callback transport failure: validate before journal completion, retry the identical valid result, and never replace a completed result with a contradictory failed callback.
 */

import { createChildLogger } from '@/shared/logger';
import {
  A2ATaskResultSchema,
  type A2ATaskResult,
  RemoteClientHeartbeatSchema,
  RemoteClientRegistrationSchema,
} from '@/shared/types';
import { McpStdioClient } from './mcp-stdio-client';
import { ControlPlaneHttpError, RemoteClientControlPlaneClient } from './remote-client-control-plane-client';
import {
  deliverTaskCompletionCallback,
  parseBrowserTaskCallbackResult,
  type BrowserTaskCallbackResult,
} from './remote-task-completion-callback';
import {
  type RemoteClientConfig,
  type RemoteClientTask,
  RemoteClientTaskCompletionSchema,
  RemoteClientTaskSchema,
} from '../types';

const logger = createChildLogger({ module: 'remote-client-service' });

/**
 * @description Long-running service that keeps one remote endpoint client registered and synced.
 */
export class RemoteClientService {
  private readonly config: RemoteClientConfig;
  private readonly controlPlane: RemoteClientControlPlaneClient;
  private readonly mcpClient: McpStdioClient;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private running = false;
  private currentTaskId: string | null = null;
  /** One shared polling pass prevents interval overlap from claiming concurrent work. */
  private pollInFlight: Promise<void> | null = null;
  private lastKnownToolCount = 0;
  private registeredAgentId: string;
  /** In-flight re-registration, shared so concurrent 404s trigger one attempt, not several. */
  private reregistering: Promise<boolean> | null = null;
  /** Epoch ms of the last re-registration attempt, for the retry floor. */
  private lastReregisterAt = 0;

  constructor(config: RemoteClientConfig) {
    this.config = config;
    this.controlPlane = new RemoteClientControlPlaneClient(config);
    this.mcpClient = new McpStdioClient({
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: config.mcpCwd,
      env: process.env,
    });
    this.registeredAgentId = config.agentId ?? config.clientId;
  }

  /**
   * @description Starts the local MCP process and registers the remote client with OSHAL.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.mcpClient.connect();

    const tools = await this.safeListTools();
    this.lastKnownToolCount = this.extractToolNames(tools).length;

    await this.register(tools);
    await this.announcePresence('online');
    this.startHeartbeatLoop();
    if (!this.config.disablePolling) {
      this.startPollingLoop();
    }
    logger.info({ clientId: this.config.clientId, toolCount: this.lastKnownToolCount }, 'Remote client started');
  }

  /**
   * @description Stops the daemon and its child MCP process.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    try {
      if (this.config.controlPlaneToken) {
        await this.sendHeartbeat('offline', null);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to send offline heartbeat');
    }

    await this.announcePresence('offline');

    await this.mcpClient.close();
    logger.info({ clientId: this.config.clientId }, 'Remote client stopped');
  }

  /**
   * @description Executes one polling pass against the control plane.
   *
   * If the control plane reports it has no registration for us, re-register and retry the claim
   * in the same pass rather than waiting a full poll interval — the queued task is usually the
   * reason someone is watching.
   */
  async pollOnce(): Promise<void> {
    if (!this.running || this.config.disablePolling || this.currentTaskId) return;
    if (this.pollInFlight) return this.pollInFlight;
    const poll = this.pollOnceExclusive().finally(() => {
      if (this.pollInFlight === poll) this.pollInFlight = null;
    });
    this.pollInFlight = poll;
    return poll;
  }

  /** @description Performs the network claim inside the poll mutex. */
  private async pollOnceExclusive(): Promise<void> {
    let claim;
    try {
      claim = await this.controlPlane.claimNextTask();
    } catch (error) {
      if (!(await this.recoverIfUnregistered(error, 'claim-task'))) {
        throw error;
      }
      claim = await this.controlPlane.claimNextTask();
    }

    if (!claim.claimed || !claim.task) {
      return;
    }

    await this.executeTask(claim.task);
  }

  /**
   * @description Re-registers this client when the control plane has forgotten it.
   *
   * The registry on the control plane is in-memory, so an api restart or redeploy drops every
   * registration while this daemon keeps polling on its own timer. Without this, every subsequent
   * call failed forever and the node was wedged until a human restarted the machine — the single
   * most common failure of the remote-execution path.
   *
   * Re-entrancy matters: the heartbeat and poll timers fire independently and will both see the
   * failure, so attempts share one promise and are floored to one per heartbeat interval. A
   * re-registration that itself fails returns false and the caller rethrows, so a control plane
   * that is genuinely down still surfaces as an error instead of a silent spin.
   *
   * @param error - The error thrown by a control-plane call.
   * @param operation - Label of the call that failed, for logging.
   * @returns True when re-registration succeeded and the call is worth retrying.
   */
  private async recoverIfUnregistered(error: unknown, operation: string): Promise<boolean> {
    if (!(error instanceof ControlPlaneHttpError) || !error.isUnregistered) {
      return false;
    }

    if (this.reregistering) {
      return this.reregistering;
    }

    const sinceLast = Date.now() - this.lastReregisterAt;
    if (this.lastReregisterAt > 0 && sinceLast < this.config.heartbeatIntervalMs) {
      // Already tried recently and we are STILL being told we are unknown. Backing off keeps a
      // control plane that rejects us for some other reason from turning into a registration flood.
      logger.warn(
        { clientId: this.config.clientId, operation, sinceLastMs: sinceLast },
        'Still unregistered shortly after re-registering — backing off until the next interval',
      );
      return false;
    }

    this.reregistering = (async () => {
      this.lastReregisterAt = Date.now();
      try {
        logger.warn(
          { clientId: this.config.clientId, operation },
          'Control plane lost this registration — re-registering',
        );
        const tools = await this.safeListTools();
        this.lastKnownToolCount = this.extractToolNames(tools).length;
        await this.register(tools);
        logger.info(
          { clientId: this.config.clientId, toolCount: this.lastKnownToolCount },
          'Re-registered with the control plane after it lost this client',
        );
        return true;
      } catch (reregisterError) {
        logger.error({ err: reregisterError, clientId: this.config.clientId }, 'Re-registration failed');
        return false;
      } finally {
        this.reregistering = null;
      }
    })();

    return this.reregistering;
  }

  /**
   * @description Registers the client and publishes the discovered MCP tool surface.
   */
  private async register(tools: unknown): Promise<void> {
    const toolNames = this.extractToolNames(tools);
    const registration = RemoteClientRegistrationSchema.parse({
      clientId: this.config.clientId,
      agentId: this.registeredAgentId,
      name: this.config.clientName,
      description: `Remote endpoint client on ${this.config.platform}`,
      transport: this.config.transport,
      platform: this.config.platform,
      controlPlaneUrl: this.config.controlPlaneUrl,
      tailnetHostname: this.config.tailnetHostname,
      mcpServerCommand: this.config.mcpCommand,
      mcpServerName: 'local-mcp',
      capabilities: toolNames.length > 0 ? toolNames : ['mcp.list-tools', 'mcp.call-tool'],
      tags: ['remote-client', 'mcp', this.config.platform],
      mcp: {
        command: this.config.mcpCommand,
        args: this.config.mcpArgs,
        cwd: this.config.mcpCwd,
        env: {},
      },
    });

    const response = await this.controlPlane.register(registration);
    this.registeredAgentId = response.client.agentId ?? this.registeredAgentId;
  }

  /**
   * @description Starts the heartbeat interval.
   */
  private startHeartbeatLoop(): void {
    // `void promise` marks a rejection as intentionally unawaited — it does NOT handle it. These
    // are timer callbacks with no caller to catch them, so a failed heartbeat surfaced as an
    // unhandled rejection, which Node terminates the process on by default: a control plane
    // blipping could take the edge daemon down entirely. Handle explicitly; the next tick retries.
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat('online', this.currentTaskId).catch((error) => {
        logger.error({ err: error, clientId: this.config.clientId }, 'Heartbeat failed');
      });
    }, this.config.heartbeatIntervalMs);

    void this.sendHeartbeat('online', this.currentTaskId).catch((error) => {
      logger.error({ err: error, clientId: this.config.clientId }, 'Initial heartbeat failed');
    });
  }

  /**
   * @description Starts the polling interval for remote tasks.
   */
  private startPollingLoop(): void {
    this.pollingTimer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        logger.error({ err: error }, 'Remote client polling failed');
      });
    }, this.config.pollIntervalMs);

    void this.pollOnce().catch((error) => {
      logger.error({ err: error }, 'Initial remote client poll failed');
    });
  }

  /**
   * @description Sends one heartbeat to the control plane.
   */
  private async sendHeartbeat(status: 'online' | 'degraded' | 'offline', activeTaskId: string | null): Promise<void> {
    const heartbeat = RemoteClientHeartbeatSchema.parse({
      clientId: this.config.clientId,
      agentId: this.registeredAgentId,
      status,
      controlPlaneReachable: true,
      mcpReady: this.mcpClient.isReady(),
      activeTaskId: activeTaskId ?? undefined,
      toolCount: this.lastKnownToolCount,
      lastSeenAt: new Date().toISOString(),
      version: '1.0.0',
    });

    try {
      await this.controlPlane.heartbeat(heartbeat);
    } catch (error) {
      // The heartbeat is the most frequent call, so it is usually the first to notice the control
      // plane has forgotten us. Recovering here means the node is back in the fleet before the
      // next poll rather than after an unregistered round-trip. Re-registration already marks us
      // online, so there is nothing to resend on the success path.
      if (!(await this.recoverIfUnregistered(error, 'heartbeat'))) {
        throw error;
      }
    }
  }

  /**
   * @description Executes a single remote task.
   */
  private async executeTask(task: RemoteClientTask): Promise<void> {
    const parsedTask = RemoteClientTaskSchema.parse(task);
    this.currentTaskId = parsedTask.taskId;
    await this.sendHeartbeat('online', parsedTask.taskId);
    let result: A2ATaskResult;
    let callbackResult: BrowserTaskCallbackResult | undefined;
    try {
      result = await this.executeTaskIntent(parsedTask);
      callbackResult = this.validateCompletionCallback(parsedTask, result.output);
    } catch (error) {
      await this.failTask(parsedTask, error);
      return;
    }
    try {
      await this.controlPlane.completeTask(result);
    } catch (error) {
      logger.error({ err: error, taskId: parsedTask.taskId }, 'Remote task completion settlement failed');
      this.currentTaskId = null;
      await this.sendHeartbeat('degraded', null);
      return;
    }
    const delivered = await this.deliverCompletionCallback(parsedTask, callbackResult);
    this.currentTaskId = null;
    await this.sendHeartbeat(delivered ? 'online' : 'degraded', null);
  }

  /** @description Executes one validated task intent and returns its canonical terminal result. */
  private async executeTaskIntent(task: RemoteClientTask): Promise<A2ATaskResult> {
    if (task.intent === 'mcp.initialize') {
      return this.completedResult(task, { ready: this.mcpClient.isReady() });
    }
    if (task.intent === 'mcp.list-tools') {
      const tools = await this.mcpClient.listTools();
      this.lastKnownToolCount = this.extractToolNames(tools).length;
      return this.completedResult(task, tools);
    }
    if (task.intent === 'mcp.call-tool') {
      const toolName = this.readString(task.input.toolName) || this.readString(task.input.name);
      if (!toolName) throw new Error('Remote task missing toolName');
      const args = this.readRecord(task.input.arguments ?? task.input.params ?? task.input.input);
      return this.completedResult(task, await this.mcpClient.callTool(toolName, args));
    }
    if (task.intent === 'mcp.shutdown') {
      await this.stop();
      return this.completedResult(task, { stopped: true });
    }
    return this.completedResult(task, this.statusOutput());
  }

  /** @description Builds a canonical successful task result without duplicating wire fields. */
  private completedResult(task: RemoteClientTask, output: unknown): A2ATaskResult {
    return A2ATaskResultSchema.parse({
      taskId: task.taskId,
      correlationId: task.correlationId,
      clientId: this.config.clientId,
      status: 'completed',
      output,
      completedAt: new Date().toISOString(),
    });
  }

  /** @description Returns the status-sync payload for the local remote runtime. */
  private statusOutput(): Record<string, unknown> {
    return {
      clientId: this.config.clientId,
      platform: this.config.platform,
      toolCount: this.lastKnownToolCount,
      mcpReady: this.mcpClient.isReady(),
      controlPlaneUrl: this.config.controlPlaneUrl,
    };
  }

  /** @description Strictly parses model output before the generic task can be journal-completed. */
  private validateCompletionCallback(
    task: RemoteClientTask,
    output: unknown,
  ): BrowserTaskCallbackResult | undefined {
    return task.completionCallback ? parseBrowserTaskCallbackResult(output) : undefined;
  }

  /** @description Retries one immutable result and degrades without inventing a different outcome. */
  private async deliverCompletionCallback(
    task: RemoteClientTask,
    result: BrowserTaskCallbackResult | undefined,
  ): Promise<boolean> {
    if (!task.completionCallback || !result) return true;
    try {
      await deliverTaskCompletionCallback(
        task.completionCallback,
        task.taskId,
        result,
        this.config.controlPlaneUrl,
      );
      return true;
    } catch (error) {
      logger.error({ err: error, taskId: task.taskId }, 'Remote task completion callback exhausted retries');
      return false;
    }
  }

  /** @description Settles only execution/strict-parse failure and reports one consistent failure. */
  private async failTask(task: RemoteClientTask, error: unknown): Promise<void> {
    const completion = RemoteClientTaskCompletionSchema.parse({
      taskId: task.taskId,
      correlationId: task.correlationId,
      clientId: this.config.clientId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Remote task failed',
      completedAt: new Date().toISOString(),
    });
    try { await this.controlPlane.failTask(completion); }
    catch (settleError) {
      logger.error({ err: settleError, taskId: task.taskId }, 'Remote task failure settlement failed');
    }
    await this.deliverFailureCallback(task);
    this.currentTaskId = null;
    await this.sendHeartbeat('degraded', null);
    logger.error({ err: error, taskId: task.taskId }, 'Remote task execution failed');
  }

  /** @description Resolves a scoped browser plan as failed when execution cannot yield valid JSON. */
  private async deliverFailureCallback(task: RemoteClientTask): Promise<void> {
    if (!task.completionCallback) return;
    try {
      await deliverTaskCompletionCallback(task.completionCallback, task.taskId, {
        result: 'failed',
        note: 'Remote browser task failed before returning a valid result.',
      }, this.config.controlPlaneUrl);
    } catch (error) {
      logger.error({ err: error, taskId: task.taskId }, 'Remote task failure callback was not accepted');
    }
  }

  /**
   * @description Extracts tool names from an MCP list-tools response.
   */
  private extractToolNames(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const tools = (payload as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }

    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== 'object') {
        return [];
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === 'string' && name.length > 0 ? [name] : [];
    });
  }

  /**
   * @description Safely converts an unknown value into a string.
   */
  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  /**
   * @description Safely converts an unknown value into a record.
   */
  private readRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  /**
   * @description Attempts to list tools while tolerating MCP startup flakiness.
   */
  private async safeListTools(): Promise<unknown> {
    try {
      return await this.mcpClient.listTools();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to list MCP tools during startup');
      return [];
    }
  }

  /**
   * @description Announces remote-client presence into the swarm bridge.
   */
  private async announcePresence(status: 'online' | 'offline'): Promise<void> {
    try {
      await this.controlPlane.sendSwarmMessage({
        mode: 'broadcast',
        payload: {
          type: 'remote-client.presence',
          status,
          clientId: this.config.clientId,
          agentId: this.registeredAgentId,
          name: this.config.clientName,
          platform: this.config.platform,
          capabilityCount: this.lastKnownToolCount,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.warn({ err: error, clientId: this.config.clientId, status }, 'Failed to broadcast remote-client presence');
    }
  }
}
