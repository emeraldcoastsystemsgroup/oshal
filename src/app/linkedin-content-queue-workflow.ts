/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind the LinkedIn content queue to the existing owner-scoped assistant draft lifecycle. Queue work produces a graded pending-approval draft with bounded citations and ticket provenance; it never publishes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Write the draft id and its citations back onto the source ticket (fresh draft, lost insert race and retried dispatch alike), so a queue ticket names the draft it produced. The ticket-type constant moved to linkedin-content-ticket-provenance.ts (re-exported here); the bind closure was split into ticket validation and draft persistence helpers to stay under the function-size limit.
 */

import type { Pool } from 'pg';
import type { InternalTicket } from '@/entities/ticket';
import type { TaskOrchestrator } from '@/features/chat-orchestration';
import { JudgeService, QUALITY_JUDGE_AGENT_ID } from '@/features/quality-judge';
import {
  ContentDraftStore,
  LINKEDIN_RUBRIC,
  type GradeResult,
  type SocialContentDraft,
} from '@/features/linkedin-assistant';
import type { BindManifestWorker } from '@/features/swarm-orchestration';
import {
  LINKEDIN_CONTENT_QUEUE_WORKFLOW,
  recordQueueDraftOnTicket,
  type LinkedInTicketWriter,
} from './linkedin-content-ticket-provenance';

export { LINKEDIN_CONTENT_QUEUE_WORKFLOW };
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

/** The validated request a queue ticket carries into the draft. */
interface QueueRequest {
  ownerSub: string;
  meta: QueueMetadata;
  topic: string;
  sourceUrl?: string;
  links: string[];
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

/**
 * @description Refuse anything but an owner's queue ticket running on the registered Social
 * workflow and the social-writer identity. A forged provider intent or target is refused too.
 * @param ticket - The dispatched ticket.
 * @param workflow - The registered workflow it was routed with.
 * @param agentId - The resolved worker identity.
 * @returns The validated request.
 */
function admitQueueTicket(ticket: InternalTicket, workflow: Parameters<BindManifestWorker>[1], agentId: string): QueueRequest {
  const meta = (ticket.metadata ?? {}) as QueueMetadata & Record<string, unknown>;
  if (!ticket.ownerSub || workflow.ticketType !== LINKEDIN_CONTENT_QUEUE_WORKFLOW
    || workflow.workerBot !== LINKEDIN_CONTENT_QUEUE_WORKER || workflow.pipeline !== 'manifest-worker'
    || agentId !== LINKEDIN_CONTENT_QUEUE_AGENT_ID || meta.source !== 'linkedin-content-queue'
    || Object.hasOwn(meta, 'providerIntent') || Object.hasOwn(meta, 'targetAgentId')) {
    throw new Error('Invalid bound LinkedIn content ticket');
  }
  const sourceUrl = text(meta.sourceUrl, 2000);
  const links = [...new Set([...(sourceUrl ? [sourceUrl] : []), ...citations(meta.sourceCitations)])].slice(0, 8);
  return { ownerSub: ticket.ownerSub, meta, topic: text(meta.topic, 500) ?? ticket.title, sourceUrl, links };
}

/**
 * @description Persist the worker's body as a graded pending-approval draft, or reuse the draft a
 * concurrent attempt already persisted for this ticket (the unique owner/ticket index is the
 * final race fence).
 * @param store - The owner-scoped draft store.
 * @param makeJudge - Builds the owner's judge.
 * @param ticketId - The queue ticket.
 * @param request - The validated request.
 * @param body - The worker's draft body.
 * @returns The persisted draft.
 */
async function persistQueueDraft(
  store: ContentDraftStore,
  makeJudge: (ownerSub: string) => JudgeService,
  ticketId: string,
  request: QueueRequest,
  body: string,
): Promise<SocialContentDraft> {
  const { ownerSub, meta, topic, sourceUrl, links } = request;
  let draft: SocialContentDraft;
  try {
    draft = await store.insertDraft(ownerSub, {
      topic, goal: text(meta.goal, 500) ?? null, tone: text(meta.tone, 200) ?? null,
      sourceUrl: sourceUrl ?? links[0] ?? null, sourceCitations: links, sourceTicketId: ticketId, body,
    });
  } catch (error) {
    // A retry that lost the insert race reuses the already persisted draft instead of escalating a
    // successfully completed item.
    const duplicate = await store.getBySourceTicket(ownerSub, ticketId);
    if (!duplicate) throw error;
    return duplicate;
  }
  const grade: GradeResult = await makeJudge(ownerSub).grade({
    task: `Write a LinkedIn post about: ${topic}${text(meta.goal, 500) ? `\nGoal: ${text(meta.goal, 500)}` : ''}`,
    output: body, rubric: [...LINKEDIN_RUBRIC],
  });
  const updated = await store.applyGrade(ownerSub, draft.id, {
    body, score: grade.score, dimensions: grade.dimensions, judgeMode: grade.mode,
    rationale: grade.rationale, refined: false,
  });
  if (!updated) throw new Error('LinkedIn queue draft was not available after grading');
  return updated;
}

/**
 * @description Build the queue binding over the same judge lane used by the interactive assistant.
 * @param pool - Postgres pool for the owner-scoped draft store.
 * @param orchestrator - Runs the quality-judge concierge for the ticket owner.
 * @param tickets - Writes the draft id back onto the source ticket.
 * @returns The manifest-worker binding for `linkedin-content-post` tickets.
 */
export function bindLinkedInContentWorker(pool: Pool, orchestrator: TaskOrchestrator, tickets: LinkedInTicketWriter): BindManifestWorker {
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
    const request = admitQueueTicket(ticket, workflow, agentId);
    const existing = await store.getBySourceTicket(request.ownerSub, ticket.ticketId);
    if (existing) {
      await recordQueueDraftOnTicket(tickets, ticket.ticketId, request.ownerSub, existing);
      return {
        prompt: '', reasonOnly: true, alreadyComplete: true,
        complete: async () => undefined, fail: async () => undefined,
      };
    }
    let created: SocialContentDraft | null = null;
    const complete = async (response: string): Promise<void> => {
      if (created) return;
      const body = response.trim();
      if (!body || body.length > 12000) throw new Error('LinkedIn queue worker returned an empty or oversized draft');
      created = await persistQueueDraft(store, makeJudge, ticket.ticketId, request, body);
      await recordQueueDraftOnTicket(tickets, ticket.ticketId, request.ownerSub, created);
    };
    return { prompt: queuePrompt(ticket, request.meta, request.links), reasonOnly: true, complete, fail: async () => undefined };
  };
}
