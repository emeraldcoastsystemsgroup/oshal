/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added stdio JSON-RPC bridge for local MCP server processes
 */

import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'mcp-stdio-client' });

/**
 * @description Generic JSON-RPC request payload.
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/**
 * @description Generic JSON-RPC response payload.
 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

/**
 * @description Options used to launch the local MCP server process.
 */
export interface McpStdioClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * @description Minimal stdio MCP bridge that can initialize, list tools, and call tools.
 */
export class McpStdioClient {
  private readonly options: McpStdioClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private readonly notifications: string[] = [];
  private ready = false;

  constructor(options: McpStdioClientOptions) {
    this.options = {
      ...options,
      args: options.args ?? [],
    };
  }

  /**
   * @description Launches the local MCP process and wires JSON-RPC line parsing.
   */
  async connect(): Promise<void> {
    if (this.process) {
      return;
    }

    logger.info(
      { command: this.options.command, args: this.options.args, cwd: this.options.cwd },
      'Starting local MCP process',
    );

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: 'pipe',
      shell: false,
    });

    this.process = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line: string) => this.handleLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        logger.warn({ text }, 'Local MCP stderr');
      }
    });

    child.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'Local MCP process exited');
      this.failAllPending(new Error(`Local MCP process exited (${code ?? 'unknown'}:${signal ?? 'none'})`));
      this.process = null;
      this.ready = false;
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: {
        name: 'oshal-remote-client',
        version: '1.0.0',
      },
      capabilities: {},
    });

    this.notify('notifications/initialized', {});

    this.ready = true;
  }

  /**
   * @description Returns whether the MCP session is ready.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * @description Calls the MCP tools/list method.
   */
  async listTools(): Promise<unknown> {
    return this.request('tools/list', {});
  }

  /**
   * @description Calls an MCP tool by name.
   *
   * @param toolName - MCP tool name
   * @param args - Tool arguments
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', {
      name: toolName,
      arguments: args,
    });
  }

  /**
   * @description Sends a JSON-RPC request to the process and awaits the response.
   *
   * @param method - JSON-RPC method name
   * @param params - Optional JSON-RPC params
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error('MCP process is not connected');
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise as Promise<T>;
  }

  /**
   * @description Sends a JSON-RPC notification without awaiting a response.
   */
  notify(method: string, params?: unknown): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error('MCP process is not connected');
    }

    const payload = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };

    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * @description Gracefully shuts down the local MCP process.
   */
  async close(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      if (this.ready) {
        await this.request('shutdown', {});
      }
    } catch (error) {
      logger.warn({ err: error }, 'MCP shutdown request failed; terminating process');
    }

    this.process.stdin.end();
    this.process.kill('SIGTERM');
    this.process = null;
    this.ready = false;
  }

  /**
   * @description Returns any non-fatal notifications captured during the session.
   */
  getNotifications(): string[] {
    return [...this.notifications];
  }

  /**
   * @description Parses a single JSON-RPC line from stdout.
   */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    try {
      const message = JSON.parse(trimmed) as Partial<JsonRpcResponse> & { method?: string; params?: unknown };
      if (typeof message.id === 'number') {
        this.resolveResponse(message as JsonRpcResponse);
        return;
      }

      const notification = typeof message.method === 'string' ? message.method : 'notification';
      this.notifications.push(notification);
      logger.debug({ notification }, 'MCP notification received');
    } catch (error) {
      logger.warn({ err: error, line: trimmed.slice(0, 200) }, 'Failed to parse MCP line');
    }
  }

  /**
   * @description Resolves an in-flight JSON-RPC response.
   */
  private resolveResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  /**
   * @description Rejects all in-flight requests.
   */
  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
