/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for task workspace git bootstrap and remote binding
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { expect, test } from '@playwright/test';
import { WorkspaceBootstrapService } from '../src/features/workspace-bootstrap/services/workspace-bootstrap-service';

/**
 * @description Returns true when the host has git available for workspace bootstrap tests.
 * @returns Whether git can be executed.
 */
function hasGit(): boolean {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return (result.status ?? 1) === 0;
}

test.describe('Workspace Bootstrap Service', () => {
  test.skip(!hasGit(), 'git is required for workspace bootstrap coverage');

  test('bootstraps a task workspace into a git repository with README and remote metadata', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-workspace-bootstrap-'));
    const service = new WorkspaceBootstrapService(workspaceRoot);

    const status = await service.bootstrapTaskWorkspace({
      taskId: 'task:/workspace bootstrap',
      title: 'Workspace Bootstrap Task',
      provider: 'github',
      repoUrl: 'https://github.com/example/workspace-bootstrap.git',
      branch: 'main',
    });

    expect(status.exists).toBe(true);
    expect(status.gitInitialized).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.workspacePath).toContain('task__workspace_bootstrap');
    expect(status.remotes).toEqual([
      { name: 'origin', url: 'https://github.com/example/workspace-bootstrap.git' },
    ]);

    const readmePath = path.join(status.workspacePath, 'README.md');
    expect(fs.existsSync(path.join(status.workspacePath, '.git'))).toBe(true);
    expect(fs.existsSync(readmePath)).toBe(true);
    expect(fs.readFileSync(readmePath, 'utf8')).toContain('Workspace Bootstrap Task');
    expect(fs.readFileSync(readmePath, 'utf8')).toContain('Repository: https://github.com/example/workspace-bootstrap.git');

    const currentStatus = await service.getTaskWorkspaceStatus('task:/workspace bootstrap');
    expect(currentStatus.gitInitialized).toBe(true);
    expect(currentStatus.branch).toBe('main');
    expect(currentStatus.remotes).toEqual([
      { name: 'origin', url: 'https://github.com/example/workspace-bootstrap.git' },
    ]);
  });
});
