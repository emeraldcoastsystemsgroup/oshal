/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added fail-closed release-PR issue closure decisions using trusted feed routing and explicit GitHub labels
 */

import type { GitHubTicketFeedConfig } from './github-ticket-provider-config';

const ISSUE_REFERENCE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
const CLOSE_LABEL = 'code-write';
const VETO_LABELS = new Set(['bug', 'defect']);

/**
 * @description Explains why a requested GitHub issue may or may not receive release-proof closure.
 */
export type GitHubReleaseCloseReason =
  | 'eligible-code-write'
  | 'invalid-issue-reference'
  | 'unconfigured-issue-repository'
  | 'release-repository-mismatch'
  | 'manual-close-policy'
  | 'defect-veto'
  | 'missing-code-write-label';

/**
 * @description Inputs for a deterministic release-proof closure decision.
 */
export interface GitHubReleaseCloseInput {
  issueReference: string;
  labels: readonly string[];
  releaseRepository: string;
  feeds: readonly GitHubTicketFeedConfig[];
}

/**
 * @description Fail-closed result that exposes an exact GitHub PR closing directive only when every policy check passes.
 */
export interface GitHubReleaseCloseDecision {
  shouldClose: boolean;
  reason: GitHubReleaseCloseReason;
  directive?: string;
}

/**
 * @description Decides whether a release PR may close an issue without inferring intent from prose or work history.
 * @param input - Explicit issue, label, release-repository, and trusted feed configuration inputs
 * @returns A fail-closed decision and, only when eligible, the exact PR-body closing directive
 */
export function decideGitHubReleaseClosure(
  input: GitHubReleaseCloseInput,
): GitHubReleaseCloseDecision {
  const reference = ISSUE_REFERENCE.exec(input.issueReference.trim());
  if (!reference) {
    return denied('invalid-issue-reference');
  }

  const issueRepository = reference[1].toLowerCase();
  const feed = input.feeds.find(
    (candidate) => candidate.issueRepository.toLowerCase() === issueRepository,
  );
  if (!feed) {
    return denied('unconfigured-issue-repository');
  }
  if (feed.releaseRepository.toLowerCase() !== input.releaseRepository.trim().toLowerCase()) {
    return denied('release-repository-mismatch');
  }

  const labels = new Set(input.labels.map(normalizeLabel).filter(Boolean));
  if ([...VETO_LABELS].some((label) => labels.has(label))) {
    return denied('defect-veto');
  }
  if (feed.closePolicy !== 'release-proof') {
    return denied('manual-close-policy');
  }
  if (!labels.has(CLOSE_LABEL)) {
    return denied('missing-code-write-label');
  }

  return {
    shouldClose: true,
    reason: 'eligible-code-write',
    directive: `Closes ${feed.issueRepository}#${reference[2]}`,
  };
}

function denied(reason: Exclude<GitHubReleaseCloseReason, 'eligible-code-write'>): GitHubReleaseCloseDecision {
  return { shouldClose: false, reason };
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
