/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GitHub ticket writeback adapter — posts swarm results as issue comments (M5)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Separated optional write credentials from read-only reconciliation and surfaced provider failures to the bounded retry policy
 */

import { createChildLogger } from '@/shared/logger';
import type { TicketWritebackAdapter, TicketWritebackUpdate } from '../services/ticket-writeback-adapter';

const logger = createChildLogger({ module: 'github-ticket-writeback-adapter' });

/**
 * @description GitHub writeback adapter — posts swarm lifecycle updates as issue comments.
 * Implements the same TicketWritebackAdapter contract as PlaneTicketWritebackAdapter,
 * proving the writeback architecture is provider-agnostic.
 */
export class GitHubTicketWritebackAdapter implements TicketWritebackAdapter {
  readonly provider = 'github' as const;

  private readonly token = process.env.GITHUB_TICKET_WRITEBACK_TOKEN?.trim()
    || process.env.GITHUB_TOKEN?.trim();

  /**
   * @description Post a lifecycle update as a GitHub issue comment.
   * @param update - Writeback update with cycle status and ticket details
   */
  async writeCycleUpdate(update: TicketWritebackUpdate): Promise<void> {
    if (!this.token) {
      logger.warn({ externalId: update.item.externalId }, 'GitHub writeback skipped — no token');
      return;
    }

    const parsed = parseExternalId(update.item.externalId);
    if (!parsed) {
      logger.warn({ externalId: update.item.externalId }, 'GitHub writeback skipped — cannot parse owner/repo#number');
      return;
    }

    const comment = formatComment(update);

    try {
      const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body: comment }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub comment post failed (${response.status}): ${text.slice(0, 200)}`);
      }

      logger.info(
        { externalId: update.item.externalId, cycle: update.cycle, status: update.status },
        'GitHub writeback comment posted',
      );
    } catch (err) {
      logger.error({ err, externalId: update.item.externalId }, 'GitHub writeback request failed');
      throw err;
    }
  }
}

/**
 * @description Parse owner/repo#number from external ID.
 */
function parseExternalId(externalId: string): { owner: string; repo: string; number: string } | null {
  const match = externalId.match(/^(.+?)\/(.+?)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

/**
 * @description Format a writeback update as a GitHub comment.
 */
function formatComment(update: TicketWritebackUpdate): string {
  const statusEmoji = update.status === 'completed' ? '✅' : update.status === 'failed' ? '❌' : '🔄';
  const lines = [
    `## ${statusEmoji} Swarm Update: ${update.cycle} — ${update.status}`,
    '',
    `**Run:** \`${update.runId}\``,
    `**Phase:** ${update.cycle}`,
    `**Status:** ${update.status}`,
  ];

  if (update.targetTicketState) {
    lines.push(`**Target State:** ${update.targetTicketState}`);
  }
  if (update.error) {
    lines.push('', `**Error:** ${update.error}`);
  }
  if (update.escalation) {
    lines.push('', `**Escalation:** ${update.escalation.target} — ${update.escalation.reason}`);
  }
  if (update.details) {
    lines.push('', '**Details:**', '```json', JSON.stringify(update.details, null, 2), '```');
  }

  lines.push('', `*Posted by OSHAL swarm orchestration*`);
  return lines.join('\n');
}
