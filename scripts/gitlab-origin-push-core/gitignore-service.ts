/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added standard .gitignore management for repository bootstrap workflows
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { STANDARD_GITIGNORE_ENTRIES } from './contracts';
import { createGitLabOriginPushLogger } from './logger';

interface GitignoreResult {
  changed: boolean;
  entriesAdded: string[];
  filePath: string;
}

/**
 * @description Service that creates or updates a standard `.gitignore` during
 * repository bootstrap.
 */
export class GitignoreService {
  private readonly logger = createGitLabOriginPushLogger({
    component: 'GitignoreService',
  });

  /**
   * @description Ensures that a repository contains a standard `.gitignore`
   * covering env files and common build outputs.
   *
   * @param repoPath - Absolute repository path
   * @param dryRun - When true, reports planned changes without writing to disk
   * @returns Result describing whether the file would change or was changed
   */
  public async ensureStandardGitignore(
    repoPath: string,
    dryRun: boolean,
  ): Promise<GitignoreResult> {
    const filePath = path.join(repoPath, '.gitignore');
    const existingContents = await this.readGitignore(filePath);
    const entriesAdded = this.collectMissingEntries(existingContents);

    if (entriesAdded.length === 0) {
      return { changed: false, entriesAdded: [], filePath };
    }

    if (!dryRun) {
      const nextContents = this.mergeGitignoreContents(existingContents, entriesAdded);
      await this.writeGitignore(filePath, nextContents);
    }

    this.logger.info(
      { dryRun, entriesAdded, filePath },
      'Ensured standard .gitignore entries',
    );

    return { changed: true, entriesAdded, filePath };
  }

  /**
   * @description Reads the current `.gitignore` contents when present.
   *
   * @param filePath - Absolute `.gitignore` path
   * @returns Existing file contents or an empty string when absent
   */
  private async readGitignore(filePath: string): Promise<string> {
    try {
      this.logger.info({ filePath, operation: 'readFile' }, 'Reading .gitignore');
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (this.isMissingFileError(error)) {
        this.logger.info({ filePath }, '.gitignore not present');
        return '';
      }

      this.logger.error({ err: error, filePath }, 'Failed to read .gitignore');
      throw error;
    }
  }

  /**
   * @description Determines which standard ignore entries are missing.
   *
   * @param existingContents - Existing `.gitignore` contents
   * @returns Ordered list of entries that should be appended
   */
  private collectMissingEntries(existingContents: string): string[] {
    const existingEntries = new Set(
      existingContents
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );

    return STANDARD_GITIGNORE_ENTRIES.filter((entry) => !existingEntries.has(entry));
  }

  /**
   * @description Merges missing entries into the current `.gitignore` contents.
   *
   * @param existingContents - Existing `.gitignore` contents
   * @param entriesAdded - Entries to append to the file
   * @returns Updated `.gitignore` contents
   */
  private mergeGitignoreContents(
    existingContents: string,
    entriesAdded: string[],
  ): string {
    const normalizedExistingContents = existingContents.trimEnd();
    const separator = normalizedExistingContents.length > 0 ? '\n\n' : '';

    return `${normalizedExistingContents}${separator}${entriesAdded.join('\n')}\n`;
  }

  /**
   * @description Writes updated `.gitignore` contents to disk.
   *
   * @param filePath - Absolute `.gitignore` path
   * @param contents - Updated file contents
   * @returns Promise resolved when the write completes
   */
  private async writeGitignore(filePath: string, contents: string): Promise<void> {
    this.logger.info({ filePath, operation: 'writeFile' }, 'Writing .gitignore');
    await fs.writeFile(filePath, contents, 'utf8');
  }

  /**
   * @description Determines whether a filesystem error indicates a missing file.
   *
   * @param error - Unknown filesystem error
   * @returns True when the error is `ENOENT`
   */
  private isMissingFileError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  }
}