/**
 * Multi-app plan schema + directive parsing.
 *
 * A MultiAppPlan is an ordered, data-dependent sequence of app-bot steps: turn one natural-language
 * request ("summarize my inbox, then draft a LinkedIn post about it") into steps that each run on a
 * different app bot, with later steps referencing earlier steps' outputs by id (`${step1}`).
 *
 * This module owns ONLY the contract + parsing (the reason-only bot emits a plan as a fenced JSON
 * directive; the controller parses + compiles it — the controller never calls an LLM). Compilation
 * to a runnable ProcessDefinition lives in multi-app-plan-compiler.ts, which emits onto the EXISTING
 * 'graph' ticket rail (engine, checkpoints, approval gates all reused).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: MultiAppPlan/MultiAppPlanStep zod schema, parseMultiAppPlan (fail-closed), isMultiAppPlan (>=2 steps → plan, else single dispatch), extractPlanDirective (```oshal:plan fence), stripPlanDirective.
 *
 * @module multi-app-plan
 */

import { z } from 'zod';

/** One step of a multi-app plan: a single app-bot delegation whose reply becomes `id`'s output. */
export const MultiAppPlanStepSchema = z.object({
  /** Stable step id — ALSO the output variable name later steps reference as `${id}`. */
  id: z.string().min(1).max(40).regex(/^[a-zA-Z_][\w-]*$/, 'id must be a simple identifier'),
  /** App catalog key the step runs on (e.g. "email", "social"); resolved to a bot at dispatch. */
  app: z.string().min(1).max(64),
  /** Optional pre-resolved bot agentId (the controller fills this from the app catalog). */
  agentId: z.string().min(1).max(80).optional(),
  /** Prompt for this step; may reference prior step outputs as `${otherStepId}`. */
  prompt: z.string().min(1).max(4000),
  /** Outward-acting step (sends / publishes / books). Gets an approval gate — automation is
   *  opt-in, default OFF; an outward step never runs without an explicit human approval. */
  outward: z.boolean().optional(),
});
export type MultiAppPlanStep = z.infer<typeof MultiAppPlanStepSchema>;

/** An ordered, data-dependent plan across app bots. */
export const MultiAppPlanSchema = z.object({
  title: z.string().min(1).max(160),
  steps: z.array(MultiAppPlanStepSchema).min(1).max(12),
});
export type MultiAppPlan = z.infer<typeof MultiAppPlanSchema>;

/**
 * @description Parse an untrusted value into a MultiAppPlan (fail-closed). Rejects on any schema
 * violation and on duplicate step ids (which would collide as output variables). Never throws.
 * @param raw - the candidate plan object (e.g. JSON.parse of a fenced directive)
 * @returns a validated MultiAppPlan, or null when invalid
 */
export function parseMultiAppPlan(raw: unknown): MultiAppPlan | null {
  const result = MultiAppPlanSchema.safeParse(raw);
  if (!result.success) return null;
  const seen = new Set<string>();
  for (const step of result.data.steps) {
    if (seen.has(step.id)) return null; // duplicate ids would clobber each other's output var
    seen.add(step.id);
  }
  return result.data;
}

/**
 * @description Whether a plan warrants the multi-app graph rail. A single-step "plan" is just an
 * ordinary single delegation — the caller keeps the existing single-dispatch path (no regression).
 * Two or more steps is a genuine ordered/dependent plan.
 * @param plan - a parsed plan (or null)
 * @returns true when the plan has 2+ steps
 */
export function isMultiAppPlan(plan: MultiAppPlan | null | undefined): plan is MultiAppPlan {
  return Boolean(plan && plan.steps.length >= 2);
}

/** Exactly one ```oshal:plan fence is honoured — a strict machine channel, like the visual fence. */
const PLAN_FENCE = /```oshal:plan\s*([\s\S]*?)```/gi;
const UNTERMINATED_PLAN_FENCE = /```oshal:plan\b[\s\S]*$/i;

/**
 * @description Extract a multi-app plan from a bot reply's ```oshal:plan fenced JSON. Accepts a plan
 * ONLY when there is exactly one fence and its JSON passes the schema (fail-closed, like the visual
 * directive channel). The user never sees this control syntax (see stripPlanDirective).
 * @param text - the raw bot reply
 * @returns the parsed plan, or null when absent/malformed/ambiguous
 */
export function extractPlanDirective(text: string): MultiAppPlan | null {
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  PLAN_FENCE.lastIndex = 0;
  while ((match = PLAN_FENCE.exec(text)) !== null) {
    bodies.push(match[1]);
  }
  if (bodies.length !== 1) return null;
  try {
    return parseMultiAppPlan(JSON.parse(bodies[0].trim()));
  } catch {
    return null;
  }
}

/**
 * @description Strip every plan directive fence (including an unterminated trailing one) from a reply
 * so the user-facing answer never shows control syntax. Collapses the blank lines the removal leaves.
 * @param text - the raw bot reply
 * @returns the reply with plan fences removed
 */
export function stripPlanDirective(text: string): string {
  return text
    .replace(PLAN_FENCE, '')
    .replace(UNTERMINATED_PLAN_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
