/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added opaque per-repository GitHub cursor encoding so multiplexed feeds checkpoint without importing pre-cutover history
 */

import { z } from 'zod';
import type { GitHubTicketFeedConfig } from './github-ticket-provider-config';

const GitHubCursorPositionSchema = z.object({
  updatedAt: z.string().datetime({ offset: true }),
  number: z.number().int().nonnegative(),
});

const GitHubCursorStateSchema = z.object({
  version: z.literal(1),
  positions: z.record(z.string(), GitHubCursorPositionSchema),
});

/**
 * @description One repository's last emitted GitHub issue tuple.
 */
export type GitHubCursorPosition = z.infer<typeof GitHubCursorPositionSchema>;

/**
 * @description Composite checkpoint for every configured GitHub issue repository.
 */
export type GitHubCursorState = z.infer<typeof GitHubCursorStateSchema>;

const CURSOR_PREFIX = 'gh1.';
const OPEN_BACKLOG_START = '1970-01-01T00:00:00.000Z';

/**
 * @description Decodes a composite cursor or creates feed-safe bootstrap positions when none exists.
 * @param cursor - Stored opaque cursor, including the retired numeric cursor format
 * @param feeds - Trusted feed definitions used to seed missing positions
 * @returns Validated composite cursor state
 */
export function decodeGitHubCursor(
  cursor: string | undefined,
  feeds: GitHubTicketFeedConfig[],
): GitHubCursorState {
  if (!cursor || /^\d+$/.test(cursor)) {
    return buildBootstrapCursor(feeds);
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error('Unsupported GitHub intake cursor format');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid GitHub intake cursor: ${toErrorMessage(error)}`);
  }

  const state = GitHubCursorStateSchema.parse(decoded);
  return fillMissingPositions(state, feeds);
}

/**
 * @description Encodes a validated composite GitHub cursor as an opaque base64url value.
 * @param state - Composite cursor state
 * @returns Opaque cursor string safe for the shared cursor store
 */
export function encodeGitHubCursor(state: GitHubCursorState): string {
  const parsed = GitHubCursorStateSchema.parse(state);
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')}`;
}

/**
 * @description Tests whether an issue tuple is strictly newer than a stored repository checkpoint.
 * @param candidate - Candidate issue update tuple
 * @param position - Stored issue update tuple
 * @returns True when the candidate has not previously been emitted
 */
export function isGitHubIssueAfterPosition(
  candidate: GitHubCursorPosition,
  position: GitHubCursorPosition,
): boolean {
  const timeComparison = Date.parse(candidate.updatedAt) - Date.parse(position.updatedAt);
  return timeComparison > 0 || (timeComparison === 0 && candidate.number > position.number);
}

/**
 * @description Creates initial cursor positions from each feed's explicit history policy.
 * @param feeds - Trusted feed definitions
 * @returns Composite bootstrap cursor
 */
export function buildBootstrapCursor(feeds: GitHubTicketFeedConfig[]): GitHubCursorState {
  const positions: Record<string, GitHubCursorPosition> = {};
  for (const feed of feeds) {
    positions[repositoryKey(feed.issueRepository)] = {
      updatedAt: feed.bootstrap.mode === 'since' ? feed.bootstrap.at : OPEN_BACKLOG_START,
      number: 0,
    };
  }
  return { version: 1, positions };
}

/**
 * @description Normalizes a GitHub repository name for cursor and routing comparisons.
 * @param repository - Owner/repository identifier
 * @returns Lowercase repository key
 */
export function repositoryKey(repository: string): string {
  return repository.trim().toLowerCase();
}

function fillMissingPositions(
  state: GitHubCursorState,
  feeds: GitHubTicketFeedConfig[],
): GitHubCursorState {
  const bootstrap = buildBootstrapCursor(feeds);
  return {
    version: 1,
    positions: {
      ...bootstrap.positions,
      ...state.positions,
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
