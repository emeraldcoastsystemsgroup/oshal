/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added missing governance header, JSDoc, and structured lifecycle action logging for swarm bot lifecycle service
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from '@/shared/logger';

const execFileAsync = promisify(execFileCallback);
const logger = createChildLogger({ module: 'swarm-bot-lifecycle-service' });

/**
 * @description Supported swarm bot lifecycle actions exposed through the compatibility API.
 */
export type SwarmBotLifecycleAction = 'status' | 'restart' | 'rebuild' | 'rollback';

/**
 * @description Result returned after executing one swarm bot lifecycle action.
 */
export interface SwarmBotLifecycleResult {
  success: boolean;
  action: SwarmBotLifecycleAction;
  service: string;
  stdout: string;
  stderr: string;
}

/**
 * @description Executes local Docker swarm lifecycle actions through the checked-in helper script.
 */
export class SwarmBotLifecycleService {
  private readonly scriptPath: string;

  /**
   * @description Creates the lifecycle service and resolves the checked-in helper script path.
   * @param scriptPath - Optional explicit lifecycle helper script path override
   */
  constructor(scriptPath?: string) {
    this.scriptPath = this.resolveScriptPath(scriptPath);
  }

  /**
   * @description Restarts one swarm bot container through the checked-in lifecycle helper.
   * @param target - Bot service or container identifier
   * @returns Lifecycle result payload from the helper script
   */
  async restart(target: string): Promise<SwarmBotLifecycleResult> {
    return this.executeAction('restart', target);
  }

  /**
   * @description Rebuilds one swarm bot container through the checked-in lifecycle helper.
   * @param target - Bot service or container identifier
   * @returns Lifecycle result payload from the helper script
   */
  async rebuild(target: string): Promise<SwarmBotLifecycleResult> {
    return this.executeAction('rebuild', target);
  }

  /**
   * @description Rolls one swarm bot container back through the checked-in lifecycle helper.
   * @param target - Bot service or container identifier
   * @returns Lifecycle result payload from the helper script
   */
  async rollback(target: string): Promise<SwarmBotLifecycleResult> {
    return this.executeAction('rollback', target);
  }

  /**
   * @description Retrieves status for one swarm bot container through the checked-in lifecycle helper.
   * @param target - Bot service or container identifier
   * @returns Lifecycle result payload from the helper script
   */
  async status(target: string): Promise<SwarmBotLifecycleResult> {
    return this.executeAction('status', target);
  }

  /**
   * @description Wraps one lifecycle action with entry/exit/error logging.
   * @param action - Lifecycle action to execute
   * @param target - Bot service or container identifier
   * @returns Lifecycle result payload from the helper script
   */
  private async executeAction(action: SwarmBotLifecycleAction, target: string): Promise<SwarmBotLifecycleResult> {
    const startedAt = Date.now();
    logger.info({ action, target }, 'Starting swarm bot lifecycle action');

    try {
      const result = await this.run(action, target);
      logger.info(
        { action, target, durationMs: Date.now() - startedAt, success: result.success },
        'Completed swarm bot lifecycle action',
      );
      return result;
    } catch (error) {
      logger.error(
        { err: error, action, target, durationMs: Date.now() - startedAt },
        'Swarm bot lifecycle action failed',
      );
      throw error;
    }
  }

  /**
   * @description Executes the helper script for one normalized lifecycle action and target.
   * @param action - Lifecycle action to execute
   * @param target - Bot service or container identifier
   * @returns Lifecycle result payload from the helper script
   */
  private async run(action: SwarmBotLifecycleAction, target: string): Promise<SwarmBotLifecycleResult> {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) {
      throw new Error('Bot target is required');
    }

    logger.info({ action, target: normalizedTarget, scriptPath: this.scriptPath }, 'Executing swarm bot lifecycle action');
    const { stdout, stderr } = await execFileAsync('bash', [this.scriptPath, action, normalizedTarget], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    return {
      success: true,
      action,
      service: normalizedTarget,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  }

  /**
   * @description Resolves the executable lifecycle helper script from explicit, environment, and repo-relative paths.
   * @param scriptPath - Optional explicit lifecycle helper script path override
   * @returns Executable helper script path
   */
  private resolveScriptPath(scriptPath?: string): string {
    const candidates = [
      scriptPath,
      process.env.OSHAL_SWARM_BOT_LIFECYCLE_SCRIPT,
      path.resolve(process.cwd(), 'scripts/swarm-bot-lifecycle.sh'),
      path.resolve(__dirname, '../../../../scripts/swarm-bot-lifecycle.sh'),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error(
      `Unable to locate executable swarm bot lifecycle script. Checked: ${candidates.join(', ') || '(no candidates)'}`,
    );
  }
}
