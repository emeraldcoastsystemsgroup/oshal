/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Haven context composition (ADR-079 slices 2+3): buildHavenPreamble injects the hot core + owner-scoped RAG long-tail into every Jarvis turn; learnFromExchange runs the throttled passive-learning loop (extraction via the caller-supplied Jarvis brain so LLM cost stays on the accountable bot path, ADR-036/050) and overflows narrative evidence into the per-user 'user-model' RAG collection guarded by the permission filter.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The long-tail search takes the user's OWN words (callers pass retrievalQuery), caps the query, and races a time budget: it was being handed the whole assembled bot message - 71,817 chars on 2026-09-15 - and the Postgres full-text leg then took 100-127 s, which blew the Jarvis decision timeout and turned a question into a queued build ticket. A slow or oversized search now drops the long-tail instead of holding up the turn.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { RagService } from '@/features/rag';
import { buildExtractionPrompt, parseExtraction, renderHotCore } from './user-model-logic';
import { UserModelService } from './user-model-service';

const logger = createChildLogger({ module: 'haven-context' });

/** The per-user long-tail memory collection; chunks are owner_sub-ACL'd so only the owner retrieves them. */
const LONG_TAIL_COLLECTION = 'user-model';
/** Longest retrieval query sent to the long-tail search; the embedder truncates well before this. */
const LONG_TAIL_QUERY_MAX_CHARS = Math.max(64, Number(process.env.HAVEN_LONG_TAIL_QUERY_MAX_CHARS) || 512);
/** Time budget for the long-tail search; past it the turn proceeds on the hot core alone. */
const LONG_TAIL_TIMEOUT_MS = Math.max(250, Number(process.env.HAVEN_LONG_TAIL_TIMEOUT_MS) || 3_000);

/** Env kill-switch for passive learning (default on). */
const LEARN_ENABLED = (process.env.OSHAL_USER_MODEL_LEARN ?? 'true').trim().toLowerCase() !== 'false';

/** One service + one rag client per process — both are stateless over the pool / Chroma HTTP. */
const services = new Map<Pool, UserModelService>();
let rag: RagService | null = null;

/** @description The (lazily created) UserModelService bound to this pool. */
export function userModelFor(pool: Pool): UserModelService {
  let svc = services.get(pool);
  if (!svc) { svc = new UserModelService(pool); services.set(pool, svc); }
  return svc;
}

function ragClient(): RagService {
  if (!rag) rag = new RagService();
  return rag;
}

type LongTailHit = Awaited<ReturnType<RagService['search']>>;

/**
 * @description Race the long-tail search against its time budget. The retrieval is an enrichment,
 * never the answer, so a slow search must degrade to "no long-tail" rather than hold the turn: an
 * unbudgeted search spent 100-127 s inside a 75 s decision budget on 2026-09-15. The timer is
 * always cleared, and the abandoned search is left to settle on its own (the RAG path cannot be
 * cancelled mid-query; its rejection is swallowed so it cannot surface as an unhandled rejection).
 * @param search - The in-flight long-tail search.
 * @param userSub - Caller, for the timeout log line only.
 * @returns The hits, or [] when the budget expires.
 */
async function withLongTailBudget(search: Promise<LongTailHit>, userSub: string): Promise<LongTailHit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), LONG_TAIL_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([search.catch((err) => { throw err; }), timeout]);
    if (outcome === 'timeout') {
      void search.catch(() => undefined);
      logger.warn({ userSub, budgetMs: LONG_TAIL_TIMEOUT_MS }, 'haven long-tail retrieval over budget — answering on the hot core alone');
      return [] as unknown as LongTailHit;
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @description Build the Haven preamble injected ahead of the user's message on every Jarvis
 * turn: the hot core (compact durable facts) plus up to 3 owner-scoped long-tail memories
 * relevant to this message (retrieved through the permission-filtered RAG path, allowPublic=false
 * so ONLY the caller's own chunks can surface). Returns '' when nothing is known — a new user
 * costs zero prompt overhead. Never throws: a degraded memory layer must not break the ask.
 * @param pool - Postgres pool.
 * @param userSub - The signed-in caller.
 * @param message - The user's message (kept for callers that have nothing more specific).
 * @param retrievalQuery - What to search the long-tail with. Callers that assemble a large prompt
 * MUST pass the user's own words here: the search cost grows with the query, and the retrieval is
 * on the turn's critical path.
 * @returns The preamble block, or ''.
 */
export async function buildHavenPreamble(
  pool: Pool, userSub: string, message: string, retrievalQuery: string = message,
): Promise<string> {
  try {
    const facts = await userModelFor(pool).getFacts(userSub, true);
    const core = renderHotCore(facts);
    let tail = '';
    const query = retrievalQuery.trim().slice(0, LONG_TAIL_QUERY_MAX_CHARS);
    if (query.length >= 12) {
      try {
        const hits = await withLongTailBudget(ragClient().search(query, LONG_TAIL_COLLECTION, 3, {
          userSub, allowPublic: false,
        }), userSub);
        if (hits.length > 0) {
          tail = ['[Possibly relevant older memories about this user]', ...hits.map((h) => `- ${h.text.slice(0, 240)}`)].join('\n');
        }
      } catch (err) {
        logger.warn({ err }, 'haven long-tail retrieval failed — continuing without it');
      }
    }
    return [core, tail].filter(Boolean).join('\n\n');
  } catch (err) {
    logger.error({ err, userSub }, 'haven preamble failed — continuing without user model');
    return '';
  }
}

/**
 * @description Prefix a message with the Haven preamble (helper so call-sites stay one line).
 * @param pool - Postgres pool. @param userSub - The signed-in caller.
 * @param message - The text the preamble is prefixed to (may be a large assembled prompt).
 * @param retrievalQuery - The user's own words, when `message` is an assembled prompt.
 * @returns The message with the preamble, or the message unchanged.
 */
export async function withHavenContext(
  pool: Pool, userSub: string, message: string, retrievalQuery: string = message,
): Promise<string> {
  const preamble = await buildHavenPreamble(pool, userSub, message, retrievalQuery);
  return preamble ? `${preamble}\n\n---\n${message}` : message;
}

/**
 * @description The passive-learning loop (fire-and-forget after an exchange): throttled per
 * user, it asks the SAME accountable Jarvis brain (caller-supplied runner, so LLM cost lands in
 * chat_tasks under the bot — ADR-036/050) to extract durable facts, merges them into the model,
 * and ingests each fact's evidence into the owner-ACL'd long-tail RAG collection. Never throws.
 * @param pool - Postgres pool.
 * @param userSub - The signed-in caller.
 * @param message - The user's message this exchange.
 * @param answer - The assistant's final answer.
 * @param runBrain - Runs one prompt on the accountable Jarvis inline bot; returns raw text.
 */
export async function learnFromExchange(
  pool: Pool, userSub: string, message: string, answer: string,
  runBrain: (prompt: string) => Promise<string>,
): Promise<void> {
  if (!LEARN_ENABLED) return;
  try {
    if (message.trim().length < 12) return; // trivial turns teach nothing durable
    const svc = userModelFor(pool);
    if (!(await svc.shouldLearnNow(userSub))) return;
    const raw = await runBrain(buildExtractionPrompt(message, answer));
    const candidates = parseExtraction(raw);
    let stored = 0;
    for (const candidate of candidates) {
      if (await svc.mergeFact(userSub, candidate)) {
        stored += 1;
        if (candidate.evidence) {
          // Long-tail: the evidence sentence, owner-ACL'd so retrieval is caller-only.
          try {
            await ragClient().ingest(
              [`${candidate.factKey}: ${candidate.factValue} — ${candidate.evidence}`],
              LONG_TAIL_COLLECTION,
              { source: 'haven-learning', owner_sub: userSub },
            );
          } catch (err) {
            logger.warn({ err }, 'haven long-tail ingest failed — fact kept, memory overflow skipped');
          }
        }
      }
    }
    if (stored > 0) logger.info({ userSub, stored }, 'haven learned from exchange');
  } catch (err) {
    logger.error({ err, userSub }, 'haven learn step failed (non-fatal)');
  }
}
