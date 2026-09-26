/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind the LinkedIn content queue to the existing owner-scoped assistant draft lifecycle. Queue work produces a graded pending-approval draft with bounded citations and ticket provenance; it never publishes.
 */

import type { Pool } from 'pg';
import type { TaskOrchestrator } from '@/features/chat-orchestration';
import { JudgeService, QUALITY_JUDGE_AGENT_ID } from '@/features/quality-judge';
import {
  ContentDraftStore,
  LINKEDIN_RUBRIC,
  type GradeResult,
} from '@/features/linkedin-assistant';
import type { BindManifestWorker } from '@/features/swarm-orchestration';

export const LINKEDIN_CONTENT_QUEUE_WORKFLOW = 'linkedin-content-post';
export const LINKEDIN_CONTENT_QUEUE_WORKER = 'social-writer';
export const LINKEDIN_CONTENT_QUEUE_AGENT_ID = 'a0000000-0000-0000-0000-000000000040';

interface QueueMetadata {
  source?: unknown;
  topic?: unknown;
  goal?: unknown;
  tone?: unknown;
  sourceUrl?: unknown;
  sourceCitations?: unknown;
}

function text(value: unknown, max = 1000): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function citations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 2000)).slice(0, 8);
}

function queuePrompt(ticket: { title: string; description: string }, meta: QueueMetadata, links: string[]): string {
  return [
    'Draft one LinkedIn post for the owner of this queue ticket.',
    'Output ONLY the post body. Do not publish, call tools, or claim that anything was posted.',
    'Use only facts in the request and the supplied source links. Keep the links available as citations; do not invent facts, metrics, quotes, or dates.',
    `Topic: ${text(meta.topic, 500) ?? ticket.title}`,
    text(meta.goal, 500) ? `Goal: ${text(meta.goal, 500)}` : '',
    text(meta.tone, 200) ? `Tone: ${text(meta.tone, 200)}` : '',
    links.length ? `Source citations: ${links.join(', ')}` : '',
    `Ticket context: ${ticket.description || '(none)'}`,
    'Follow a strong hook, 2-4 short paragraphs, a soft CTA, and 1-3 relevant hashtags.',
  ].filter(Boolean).join('\n');
}

/** @description Build the queue binding over the same judge lane used by the interactive assistant. */
export function bindLinkedInContentWorker(pool: Pool, orchestrator: TaskOrchestrator): BindManifestWorker {
  const store = new ContentDraftStore(pool);
  const makeJudge = (ownerSub: string): JudgeService => new JudgeService({
    invoker: async (taskId, prompt) => {
      const result = await orchestrator.processMessage(taskId, prompt, {
        agenticMode: true, autoApprove: false, source: 'quality-judge',
        agentId: QUALITY_JUDGE_AGENT_ID, userSub: ownerSub,
      } as never);
      if (!result.success) throw new Error(result.error || 'judge brain execution failed');
      return String(result.response ?? '');
    },
  });

  return async (ticket, workflow, agentId) => {
    if (ticket.ticketType !== LINKEDIN_CONTENT_QUEUE_WORKFLOW) return undefined;
    const meta = (ticket.metadata ?? {}) as QueueMetadata & Record<string, unknown>;
    if (!ticket.ownerSub || workflow.ticketType !== LINKEDIN_CONTENT_QUEUE_WORKFLOW
      || workflow.workerBot !== LINKEDIN_CONTENT_QUEUE_WORKER || workflow.pipeline !== 'manifest-worker'
      || agentId !== LINKEDIN_CONTENT_QUEUE_AGENT_ID || meta.source !== 'linkedin-content-queue'
      || Object.hasOwn(meta, 'providerIntent') || Object.hasOwn(meta, 'targetAgentId')) {
      throw new Error('Invalid bound LinkedIn content ticket');
    }
    const topic = text(meta.topic, 500) ?? ticket.title;
    const sourceUrl = text(meta.sourceUrl, 2000);
    const sourceCitations = citations(meta.sourceCitations);
    const links = [...new Set([...(sourceUrl ? [sourceUrl] : []), ...sourceCitations])].slice(0, 8);
    const existing = await store.getBySourceTicket(ticket.ownerSub, ticket.ticketId);
    if (existing) {
      return {
        prompt: '', reasonOnly: true, alreadyComplete: true,
        complete: async () => undefined, fail: async () => undefined,
      };
    }
    let createdId: number | null = null;
    const fail = async (): Promise<void> => undefined;
    const complete = async (response: string): Promise<void> => {
      if (createdId !== null) return;
      const body = response.trim();
      if (!body || body.length > 12000) throw new Error('LinkedIn queue worker returned an empty or oversized draft');
      let draft;
      try {
        draft = await store.insertDraft(ticket.ownerSub!, {
          topic, goal: text(meta.goal, 500) ?? null, tone: text(meta.tone, 200) ?? null,
          sourceUrl: sourceUrl ?? links[0] ?? null, sourceCitations: links,
          sourceTicketId: ticket.ticketId, body,
        });
      } catch (error) {
        // The unique owner/ticket index is the final race fence. A retry that lost that race
        // reuses the already persisted draft instead of escalating a successfully completed item.
        const duplicate = await store.getBySourceTicket(ticket.ownerSub!, ticket.ticketId);
        if (!duplicate) throw error;
        createdId = duplicate.id;
        return;
      }
      createdId = draft.id;
      const grade: GradeResult = await makeJudge(ticket.ownerSub!).grade({
        task: `Write a LinkedIn post about: ${topic}${text(meta.goal, 500) ? `\nGoal: ${text(meta.goal, 500)}` : ''}`,
        output: body, rubric: [...LINKEDIN_RUBRIC],
      });
      const updated = await store.applyGrade(ticket.ownerSub!, draft.id, {
        body, score: grade.score, dimensions: grade.dimensions, judgeMode: grade.mode,
        rationale: grade.rationale, refined: false,
      });
      if (!updated) throw new Error('LinkedIn queue draft was not available after grading');
    };
    return { prompt: queuePrompt(ticket, meta, links), reasonOnly: true, complete, fail };
  };
}
