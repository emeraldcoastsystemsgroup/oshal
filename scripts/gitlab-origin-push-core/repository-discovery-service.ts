/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added repository discovery service for GitLab origin push helper
 */

import { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryCandidate } from './contracts';
import { SKIPPED_DIRECTORIES } from './contracts';
import { createGitLabOriginPushLogger } from './logger';

/**
 * @description Service that discovers Git repositories without traversing into
 * nested repositories once a `.git` boundary is found.
 */
export class RepositoryDiscoveryService {
  private readonly logger = createGitLabOriginPushLogger({
    component: 'RepositoryDiscoveryService',
  });

  /**
   * @description Scans a root directory up to the provided depth and returns
   * repository candidates ordered by relative path.
   *
   * @param rootDir - Root directory to scan
   * @param maxDepth - Maximum directory depth below the root to inspect
   * @returns Discovered repository candidates
   */
  public async discoverRepositories(
    rootDir: string,
    maxDepth: number,
  ): Promise<RepositoryCandidate[]> {
    const startedAt = Date.now();
    const stack = [{ depth: 0, dirPath: rootDir }];
    const repositories: RepositoryCandidate[] = [];

    this.logger.info({ maxDepth, rootDir }, 'Starting repository discovery');

    while (stack.length > 0) {
      const currentDirectory = stack.pop();

      if (!currentDirectory) {
        continue;
      }

      await this.processDirectory(rootDir, maxDepth, currentDirectory, repositories, stack);
    }

    const sortedRepositories = repositories.sort((left, right) => {
      return left.relativePath.localeCompare(right.relativePath);
    });

    this.logger.info(
      { count: sortedRepositories.length, durationMs: Date.now() - startedAt },
      'Repository discovery completed',
    );

    return sortedRepositories;
  }

  /**
   * @description Processes a single directory during traversal.
   *
   * @param rootDir - Root directory for relative path calculation
   * @param maxDepth - Maximum allowed traversal depth
   * @param currentDirectory - Directory being processed
   * @param repositories - Mutable repository collection
   * @param stack - Mutable traversal stack
   */
  private async processDirectory(
    rootDir: string,
    maxDepth: number,
    currentDirectory: { depth: number; dirPath: string },
    repositories: RepositoryCandidate[],
    stack: Array<{ depth: number; dirPath: string }>,
  ): Promise<void> {
    const entries = await this.readDirectoryEntries(currentDirectory.dirPath);

    if (this.containsGitEntry(entries)) {
      repositories.push(this.createRepositoryCandidate(rootDir, currentDirectory.dirPath));
      return;
    }

    if (currentDirectory.depth >= maxDepth) {
      return;
    }

    this.enqueueChildDirectories(
      currentDirectory.dirPath,
      currentDirectory.depth,
      entries,
      stack,
    );
  }

  /**
   * @description Reads directory entries with structured logging for traceability.
   *
   * @param directoryPath - Absolute directory path to read
   * @returns Directory entries for the provided path
   */
  private async readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
    this.logger.info({ directoryPath, operation: 'readdir' }, 'Reading directory entries');
    return fs.readdir(directoryPath, { withFileTypes: true });
  }

  /**
   * @description Determines whether the current directory contains Git metadata.
   *
   * @param entries - Directory entries for the current directory
   * @returns True when a `.git` entry is present
   */
  private containsGitEntry(entries: Dirent[]): boolean {
    return entries.some((entry) => entry.name === '.git');
  }

  /**
   * @description Creates a repository candidate using a stable relative path.
   *
   * @param rootDir - Scan root directory
   * @param repoPath - Absolute repository path
   * @returns Repository candidate metadata
   */
  private createRepositoryCandidate(
    rootDir: string,
    repoPath: string,
  ): RepositoryCandidate {
    return {
      relativePath: path.relative(rootDir, repoPath) || '.',
      repoPath,
    };
  }

  /**
   * @description Adds eligible child directories to the traversal stack.
   *
   * @param currentDir - Current directory path
   * @param currentDepth - Current traversal depth
   * @param entries - Directory entries under the current directory
   * @param stack - Mutable traversal stack
   */
  private enqueueChildDirectories(
    currentDir: string,
    currentDepth: number,
    entries: Dirent[],
    stack: Array<{ depth: number; dirPath: string }>,
  ): void {
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      stack.push({
        depth: currentDepth + 1,
        dirPath: path.join(currentDir, entry.name),
      });
    }
  }
}