/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added task workspace bootstrap service for git init, README seed, and optional remote binding
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from '@/shared/logger';

const execFileAsync = promisify(execFileCallback);
const logger = createChildLogger({ module: 'workspace-bootstrap-service' });

/**
 * @description Input describing the task whose workspace should be created and optionally bound to a git remote.
 */
export interface WorkspaceBootstrapInput {
  taskId: string;
  title?: string;
  provider?: 'gitlab' | 'github' | 'generic';
  repoUrl?: string;
  remoteName?: string;
  branch?: string;
}

/**
 * @description Reported state of a task workspace, including its path, existence, git initialization, branch, remotes, and README location.
 */
export interface WorkspaceBootstrapStatus {
  workspacePath: string;
  exists: boolean;
  gitInitialized: boolean;
  branch: string;
  remotes: Array<{ name: string; url: string }>;
  readmePath: string;
}

/**
 * @description Bootstraps task workspaces into usable git-backed directories.
 */
export class WorkspaceBootstrapService {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot && workspaceRoot.trim().length > 0
      ? path.resolve(workspaceRoot)
      : this.resolveWorkspaceRoot();
  }

  /**
   * @description Initializes a task workspace and optionally binds a git remote.
   */
  async bootstrapTaskWorkspace(input: WorkspaceBootstrapInput): Promise<WorkspaceBootstrapStatus> {
    const taskId = this.normalizeWorkspaceId(input.taskId);
    if (!taskId) {
      throw new Error('taskId is required for workspace bootstrap');
    }

    const workspacePath = this.ensureWorkspacePath(taskId);
    const branch = input.branch?.trim() || 'main';
    if (!this.hasGitDirectory(workspacePath)) {
      await this.initializeGitRepository(workspacePath, branch);
      await this.configureGitIdentity(workspacePath);
    }

    await this.ensureReadme(workspacePath, {
      taskId,
      title: input.title?.trim() || taskId,
      provider: input.provider?.trim() || '',
      repoUrl: input.repoUrl?.trim() || '',
    });

    if (input.repoUrl?.trim()) {
      await this.upsertRemote(workspacePath, input.remoteName?.trim() || 'origin', input.repoUrl.trim());
    }

    const status = await this.getTaskWorkspaceStatus(taskId);
    logger.info({ taskId, workspacePath, repoUrl: input.repoUrl || null }, 'Workspace bootstrapped');
    return status;
  }

  /**
   * @description Returns current workspace and git status for one task.
   */
  async getTaskWorkspaceStatus(taskId: string): Promise<WorkspaceBootstrapStatus> {
    const normalizedTaskId = this.normalizeWorkspaceId(taskId);
    const workspacePath = path.join(this.workspaceRoot, normalizedTaskId);
    const exists = fs.existsSync(workspacePath);
    const gitInitialized = exists && this.hasGitDirectory(workspacePath);

    return {
      workspacePath,
      exists,
      gitInitialized,
      branch: gitInitialized ? await this.readCurrentBranch(workspacePath) : '',
      remotes: gitInitialized ? await this.readRemotes(workspacePath) : [],
      readmePath: path.join(workspacePath, 'README.md'),
    };
  }

  private resolveWorkspaceRoot(): string {
    const configuredRoot = process.env.CLINE_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
    if (configuredRoot && configuredRoot.trim().length > 0) {
      return path.resolve(configuredRoot);
    }
    return path.resolve(process.cwd(), 'workspace');
  }

  private normalizeWorkspaceId(taskId: string): string {
    return taskId.trim().replaceAll(/[^a-zA-Z0-9-_]/g, '_');
  }

  private ensureWorkspacePath(taskId: string): string {
    const workspacePath = path.join(this.workspaceRoot, taskId);
    fs.mkdirSync(workspacePath, { recursive: true });
    return workspacePath;
  }

  private hasGitDirectory(workspacePath: string): boolean {
    return fs.existsSync(path.join(workspacePath, '.git'));
  }

  private async initializeGitRepository(workspacePath: string, branch: string): Promise<void> {
    try {
      await execFileAsync('git', ['init', '-b', branch], { cwd: workspacePath, encoding: 'utf8' });
    } catch (_error) {
      await execFileAsync('git', ['init'], { cwd: workspacePath, encoding: 'utf8' });
      await execFileAsync('git', ['branch', '-M', branch], { cwd: workspacePath, encoding: 'utf8' });
    }
  }

  private async configureGitIdentity(workspacePath: string): Promise<void> {
    const userName = process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || 'OSHAL Workspace Bootstrap';
    const userEmail = process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || 'oshal@local.invalid';
    await execFileAsync('git', ['config', 'user.name', userName], { cwd: workspacePath, encoding: 'utf8' });
    await execFileAsync('git', ['config', 'user.email', userEmail], { cwd: workspacePath, encoding: 'utf8' });
  }

  private async ensureReadme(
    workspacePath: string,
    params: { taskId: string; title: string; provider: string; repoUrl: string },
  ): Promise<void> {
    const readmePath = path.join(workspacePath, 'README.md');
    if (fs.existsSync(readmePath)) {
      return;
    }

    const lines = [
      `# ${params.title}`,
      '',
      `Task ID: ${params.taskId}`,
      `Created: ${new Date().toISOString()}`,
    ];
    if (params.provider) {
      lines.push(`Provider: ${params.provider}`);
    }
    if (params.repoUrl) {
      lines.push(`Repository: ${params.repoUrl}`);
    }
    lines.push('', 'Bootstrap workspace for OSHAL task execution.');
    fs.writeFileSync(readmePath, `${lines.join('\n')}\n`, 'utf8');
  }

  private async upsertRemote(workspacePath: string, remoteName: string, repoUrl: string): Promise<void> {
    try {
      await execFileAsync('git', ['remote', 'get-url', remoteName], { cwd: workspacePath, encoding: 'utf8' });
      await execFileAsync('git', ['remote', 'set-url', remoteName, repoUrl], { cwd: workspacePath, encoding: 'utf8' });
    } catch (_error) {
      await execFileAsync('git', ['remote', 'add', remoteName, repoUrl], { cwd: workspacePath, encoding: 'utf8' });
    }
  }

  private async readCurrentBranch(workspacePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: workspacePath, encoding: 'utf8' });
      return stdout.trim();
    } catch (_error) {
      return '';
    }
  }

  private async readRemotes(workspacePath: string): Promise<Array<{ name: string; url: string }>> {
    try {
      const { stdout } = await execFileAsync('git', ['remote', '-v'], { cwd: workspacePath, encoding: 'utf8' });
      const seen = new Map<string, string>();
      stdout.split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (match && !seen.has(match[1])) {
          seen.set(match[1], match[2]);
        }
      });
      return Array.from(seen.entries()).map(([name, url]) => ({ name, url }));
    } catch (_error) {
      return [];
    }
  }
}
