/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persona regression evals (golden-task gate): suite/task/assertion types + report shapes. Assertions are TIERED — structural (mechanically checkable now) vs semantic (rubric graded by an LLM judge when a real lane is available; skipped-with-notice under noop) — so a persona edit can be regression-gated honestly without faking passes.
 */

/**
 * @description Which evaluation tier an assertion belongs to. Structural assertions are
 * mechanically checkable right now (regex, JSON shape, artifact presence); semantic assertions
 * need an LLM judge and are SKIPPED with an explicit notice when the active lane cannot judge
 * (noop) — never silently passed. The tiering is the honesty contract of the whole gate.
 */
export type AssertionTier = 'structural' | 'semantic';

/**
 * @description Outcome of one assertion. `skipped` is a first-class state (semantic tier under
 * noop, or artifact checks in a lane with no captured workspace) so lane limitations are visible
 * in the report instead of being laundered into green.
 */
export type AssertionStatus = 'pass' | 'fail' | 'skipped' | 'error';

/**
 * @description The structural assertion vocabulary. Each type is a mechanical check over the
 * persona's output text (or, for `artifact-exists`, over a captured workspace directory):
 * - `contains` / `not-contains` — literal substring presence/absence (`value`).
 * - `regex` / `not-regex`       — pattern match/absence (`pattern`, optional `flags`).
 * - `json-parses`               — the output contains a parseable JSON document/block.
 * - `json-keys`                 — that JSON has every key in `keys` (top-level, or on every
 *                                 element when the document is an array).
 * - `citation-block`            — a citation with a `doc_id` is present (RAG provenance rule).
 * - `artifact-exists`           — `path` exists under the run's workspace dir (skips with
 *                                 notice when the lane captured no workspace).
 * - `max-lines`                 — at most `max` non-empty output lines.
 * - `min-words`                 — at least `min` whitespace-separated words.
 */
export type StructuralAssertionType =
  | 'contains'
  | 'not-contains'
  | 'regex'
  | 'not-regex'
  | 'json-parses'
  | 'json-keys'
  | 'citation-block'
  | 'artifact-exists'
  | 'max-lines'
  | 'min-words';

/**
 * @description The semantic assertion vocabulary. `rubric` is graded 0-100 by the LLM judge
 * against the assertion's rubric text; it passes at `minScore` (default 70).
 */
export type SemanticAssertionType = 'rubric';

/**
 * @description One golden-task assertion as authored in ai-lab/persona-evals/<persona>.yaml.
 * The union of parameters across all assertion types; the suite loader validates that the
 * parameters required by `type` are actually present so a typo fails at load time, not as a
 * silently-vacuous check at run time.
 */
export interface EvalAssertion {
  /** Stable id, unique within the task — the report keys per-assertion detail on it. */
  id: string;
  /** Tier — structural runs everywhere; semantic needs an LLM judge lane. */
  tier: AssertionTier;
  /** Assertion type (see the tier vocabularies). */
  type: StructuralAssertionType | SemanticAssertionType;
  /** Human explanation of WHY this assertion encodes the persona's contract. */
  description?: string;
  /** `contains` / `not-contains`: the literal substring. */
  value?: string;
  /** `regex` / `not-regex` / `citation-block` override: the pattern source. */
  pattern?: string;
  /** Regex flags for `pattern` (e.g. "i", "m"). */
  flags?: string;
  /** `json-keys`: required top-level keys. */
  keys?: string[];
  /** `artifact-exists`: path relative to the run's workspace directory. */
  path?: string;
  /** `max-lines`: maximum non-empty lines. */
  max?: number;
  /** `min-words`: minimum word count. */
  min?: number;
  /** `contains` / `not-contains`: case-insensitive comparison (default true). */
  caseInsensitive?: boolean;
  /** `rubric`: what a correct response looks like, for the LLM judge. */
  rubric?: string;
  /** `rubric`: pass threshold 0-100 (default 70). */
  minScore?: number;
}

/**
 * @description One golden task: a fixture prompt fired at the persona plus the assertions its
 * output must satisfy. `fixture` is structured data (e.g. a set of emails, a job list) appended
 * to the prompt as an explicit FIXTURE DATA block, so the persona is graded on reasoning over
 * KNOWN inputs — the pre-condition for assertions about grounding and non-invention.
 */
export interface EvalTask {
  /** Stable id, unique within the suite. */
  id: string;
  /** Short human title for reports. */
  title?: string;
  /** The user-message prompt (the fixture ticket text) sent to the persona. */
  prompt: string;
  /** Optional structured fixture data serialized into the prompt as a FIXTURE DATA block. */
  fixture?: unknown;
  /** The tiered assertions the output must satisfy. */
  assertions: EvalAssertion[];
}

/**
 * @description A persona's golden-task suite, loaded from ai-lab/persona-evals/<persona>.yaml.
 * `persona` names the persona YAML in ai-lab/bot-personas (same filename-based lookup the bot
 * nodes use), so the eval always runs the persona AS DEPLOYED, not a copy.
 */
export interface PersonaEvalSuite {
  /** Persona file name in ai-lab/bot-personas (without extension). */
  persona: string;
  /** What this suite gates, for reports and the suites listing. */
  description?: string;
  /** The golden tasks. */
  tasks: EvalTask[];
}

/**
 * @description Per-assertion outcome with the evidence for it (matched/missing pattern, judge
 * score, skip reason). `detail` is always populated — a bare pass/fail is not reviewable.
 */
export interface AssertionResult {
  id: string;
  tier: AssertionTier;
  type: string;
  status: AssertionStatus;
  /** Evidence: what matched / what was missing / judge score / why skipped. */
  detail: string;
  /** Judge score 0-100 for semantic assertions that were actually graded. */
  score?: number;
}

/**
 * @description Rollup status of one task. `error` means the execution itself failed (provider
 * threw) — distinct from `fail` (the persona answered but broke its contract). `skipped` means
 * every assertion was skipped (e.g. an all-semantic task under noop) — surfaced, not counted
 * as green.
 */
export type TaskStatus = 'pass' | 'fail' | 'skipped' | 'error';

/**
 * @description One executed golden task: the assertion outcomes plus an output excerpt so a
 * failing report is diagnosable without re-running the lane.
 */
export interface TaskResult {
  id: string;
  title: string;
  status: TaskStatus;
  /** First N chars of the persona's raw output (evidence for the assertion outcomes). */
  outputExcerpt: string;
  durationMs: number;
  assertions: AssertionResult[];
}

/**
 * @description Which execution lane produced a report. `semanticCapable=false` (the noop lane)
 * means semantic assertions were skipped-with-notice and structural results measure the eval
 * plumbing end-to-end, not persona quality — the report says so explicitly via `laneNotice`.
 */
export interface EvalLaneInfo {
  /** Provider name reported by the lane's LLMService (e.g. 'noop', 'harness:claude-code'). */
  provider: string;
  /** Whether the lane can grade semantic rubric assertions. */
  semanticCapable: boolean;
  /** Honest caveat about what this lane's results do and do not prove. */
  laneNotice: string;
}

/**
 * @description Aggregate counts for a report — tasks and assertions counted separately so a
 * suite full of skips can never read as a healthy gate.
 */
export interface EvalSummary {
  tasks: { total: number; passed: number; failed: number; skipped: number; errored: number };
  assertions: { total: number; passed: number; failed: number; skipped: number; errored: number };
}

/**
 * @description The full result of running one persona's golden suite: lane provenance, per-task
 * per-assertion detail, aggregate counts, and the gate verdict. `passed` requires zero
 * failures/errors AND at least one task that actually passed — an all-skipped run is NOT a pass.
 */
export interface PersonaEvalReport {
  persona: string;
  suiteDescription?: string;
  lane: EvalLaneInfo;
  startedAt: string;
  finishedAt: string;
  tasks: TaskResult[];
  summary: EvalSummary;
  /** Gate verdict: no failed/errored tasks and at least one passing task. */
  passed: boolean;
}
