/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 97: Updated PM planning prompt to require action verbs (Build, Implement, Write, Create) and runnable code output. Prohibits design-only verbs (Define, Design, Specify). Each subtask must specify concrete files to create.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ported phase-specific dispatch prompts from the legacy TicketPhaseManager.js:168-350. Each phase gets explicit instructions telling the agent what its role is, what input to read, what to produce, and what NOT to do.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session 101: Added NO MOCK BUILDS constraint to execution, child execution, testing, and review prompts. Bots must produce real implementations unless ticket explicitly requests prototyping.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

/**
 * @description Phase-specific dispatch prompt blocks ported from the legacy implementation's TicketPhaseManager.getPhasePrompt().
 * These are injected into the USER MESSAGE (not persona layers) so the agent knows exactly
 * what its role is in the current phase/round. Without these, agents just "wing it" with
 * generic instructions and produce unfocused output.
 *
 * Legacy reference: TicketPhaseManager.js:168-350
 */

const NO_MOCK_BUILDS = `\
⛔ NO MOCK BUILDS:
- Produce real, functional implementations — NOT stubs, mocks, placeholders, TODO shells, or skeleton code.
- Functions must contain real logic, not hardcoded return values.
- If the ticket does not say "prototype", "scaffold", "mock", or "proof of concept", all code must be production-real.
- If context is missing, STOP and explain what's missing — do not fake it.
- Files containing \`// placeholder\`, \`// stub\`, \`// TODO: implement\`, or empty function bodies are a VIOLATION.`;

/**
 * @description Returns the phase-specific instruction block for a given phase number.
 * @param phase - Phase number (1-7)
 * @param agentId - Agent ID for personalization
 * @param round - Current round within the phase
 * @param ticketDepth - Decomposition depth (0=root, 1+=child)
 * @returns Phase prompt block to prepend to the user message
 */
export function getPhasePrompt(
  phase: number | undefined,
  agentId: string,
  round: number = 1,
  ticketDepth: number = 0,
  labels: string[] = [],
): string {
  if (!phase) return '';

  const isIncident = labels.some((l) => ['incident', 'rca-requested'].includes(l.toLowerCase()));

  switch (phase) {
    case 2: return ticketDepth === 0
      ? (isIncident ? getIncidentPlanningPrompt(round) : getPlanningPrompt(round))
      : (isIncident ? getIncidentChildExecutionPrompt(ticketDepth) : getChildExecutionPrompt(ticketDepth));
    case 3: return getSpecialistReviewPrompt();
    case 4: return getExecutionPrompt(round);
    case 5: return getTestingPrompt();
    case 6: return getReviewPrompt();
    default: return '';
  }
}

/**
 * @description Phase 2 (INCIDENT): PM produces direct investigation output — RCA, topology, remediation.
 * No code. No TypeScript. No test suites. Just analysis and scripts.
 */
function getIncidentPlanningPrompt(round: number): string {
  if (round === 2) {
    return `== YOUR ROLE: INCIDENT REVIEW (Phase 2, Round 2) ==

You are reviewing a Round 1 incident investigation.
Read the Round 1 deliverables and challenge: Is the RCA complete? Are remediation scripts safe?
Are rollback steps included? Is anything missed?

Produce an improved version addressing gaps. Your output MUST contain \`## SUBTASK DECOMPOSITION\`.
`;
  }

  return `== YOUR ROLE: INCIDENT INVESTIGATION PLANNING (Phase 2) ==

This is an infrastructure incident — not a software development ticket.
Deliverables are markdown reports and operational scripts, not TypeScript or test suites.

**The ticket contains:**
- Alert data from a monitoring source (FRUN, Dynatrace, Prometheus, OCUM, Spectrum)
- Infrastructure context from SISM (host, service, datacenter, equipment type)
- Topology data (upstream/downstream dependencies)
- Recent changes from ServiceNow
- Correlated log data from Splunk / OpenSearch

**Decompose into these investigation subtasks:**

1. **Root Cause Analysis** — Timeline of events, correlation with changes, probable root cause with confidence levels.
   Suggested agent: rca-specialist

2. **Topology Impact Assessment** — Blast radius, upstream/downstream affected systems, business impact.
   Suggested agent: graph-analyst or research-bot

3. **Remediation Scripts** — Bash/PowerShell/vendor CLI scripts an operator can run. Preflight checks required.
   DO NOT EXECUTE — create only. Include rollback procedures.
   Suggested agent: remediation-writer or devops-bot

**Each subtask must specify:** what to investigate, which evidence to use, which deliverable to write, suggested agent.

**Workspace files to create:**
- **README.md** — Incident summary, scope, evidence inventory
- **INVESTIGATION-PLAN.md** — Timeline, approach, assigned specialists

**Your output MUST contain \`## SUBTASK DECOMPOSITION\` with at least 2 subtasks.**
`;
}

/**
 * @description Child execution for incident tickets — single specialist does the full investigation.
 */
function getIncidentChildExecutionPrompt(ticketDepth: number): string {
  return `== YOUR ROLE: INCIDENT INVESTIGATOR ==

You are the sole investigator for this infrastructure incident. You own the entire investigation.
You have LIVE access to OpenSearch, Kubernetes (kubectl), Graph API, and the PostgreSQL ticket DB.
TASK-BRIEF.md has the alert context — use it as your starting point, then QUERY LIVE DATA to build evidence.

## YOUR INVESTIGATION PROCESS

**Step 0: Read TASK-BRIEF.md**
execute_command mkdir -p deliverables/scripts
Read TASK-BRIEF.md — get the CI name, alert source, and severity.

**Step 1: Query live data — REQUIRED before writing any RCA**

Use execute_command to run REAL queries. These tools are available and working:

**Kubernetes (kubectl is LIVE when a kubeconfig is mounted — discover the cluster, never assume it):**
\`\`\`
execute_command kubectl get nodes -o wide
execute_command kubectl get events --all-namespaces --sort-by='.lastTimestamp' | tail -30
execute_command kubectl describe node NODE_NAME | head -80
execute_command kubectl get pods --all-namespaces --field-selector=status.phase=Failed
execute_command kubectl top nodes
execute_command kubectl top pods --all-namespaces --sort-by=memory | head -20
\`\`\`
kubectl WORKS in this container. Real nodes: ip-10-194-224-124, ip-10-194-225-189, ip-10-194-227-35.
If you write "localhost:8080 refused" without calling execute_command first, that is hallucination — STOP and run the command.

**Step 2: Build the RCA from real data**
After running queries, write deliverables/RCA-REPORT.md. PASTE the actual query output in the
Kubernetes State section — do not summarize, do not paraphrase.

**Step 3: Impact Assessment**
Using the evidence gathered, map blast radius. Write to deliverables/IMPACT-ASSESSMENT.md.

**Step 4: Remediation Scripts**
Write operational scripts (DO NOT EXECUTE them — create only):
- **deliverables/scripts/diagnose.sh** — Commands to check current state
- **deliverables/scripts/remediate.sh** — Step-by-step fix with DRY_RUN=true default and confirmation prompt
- **deliverables/scripts/rollback.sh** — How to undo the fix

**Step 5: Summary**
Write a developer handover in developer-handovers/ with: root cause, confidence, recommended action.

## TOOLS YOU SHOULD USE
- **read_file** — Read TASK-BRIEF.md and workspace files
- **write_to_file** — Write deliverables (RCA-REPORT.md, IMPACT-ASSESSMENT.md, scripts/)
- **execute_command** — Run LIVE queries (curl OpenSearch, kubectl, graph API) AND mkdir -p
- **attempt_completion** — When done, summarize findings

## RULES
- QUERY LIVE DATA before writing the RCA — do not invent results
- DO NOT write TypeScript, Python, or application code
- DO write markdown analysis and bash/PowerShell operational scripts
- DO NOT execute remediation scripts — create them only
- Paste actual execute_command output into the RCA — real IDs, real timestamps, real node names
- If a query returns zero results, document it explicitly and try a broader search term
`;
}

/**
 * @description Phase 2: PLANNING — PM creates approach plan + subtask decomposition.
 */
function getPlanningPrompt(round: number): string {
  if (round === 2) {
    return `== YOUR ROLE: PLAN REVIEW (Phase 2, Round 2) ==

You are the **Quality Agitator** reviewing a Round 1 plan.

Read the Round 1 planning deliverable in the workspace deliverables/ folder.
Challenge weak points, missing dependencies, vague acceptance criteria, and sequencing gaps.

**Produce:**
1. A challenge list — what's wrong or weak in the Round 1 plan
2. An improved plan addressing each gap
3. Review workspace scaffolding — does README.md, PROJECT-PLAN.md, ARCHITECTURE.md, package.json exist? If not, create them.
4. A ## SUBTASK DECOMPOSITION section with IMPLEMENTATION subtasks (minimum 2)
   Each subtask needs: title (action verb!), description, FILES TO CREATE, acceptance criteria, suggested agent role

**SUBTASK RULES (enforce these on the Round 1 plan):**
- Every subtask title MUST start with an action verb: Build, Implement, Write, Create, Integrate
- Every subtask MUST specify concrete files to create (source + test)
- Every subtask MUST produce runnable code, not just specifications or type definitions
- If Round 1 used "Define", "Design", or "Specify" — REWRITE those subtasks with implementation focus
- Acceptance criteria MUST include "compiles" and "tests pass"

**Your output MUST contain \`## SUBTASK DECOMPOSITION\` — without it the pipeline cannot create child tickets.**
`;
  }

  return `== YOUR ROLE: PLANNING (Phase 2 of 7) ==

You are in the **PLANNING** phase. Your job is to create an IMPLEMENTATION PLAN — NOT to do the actual work, but to plan BUILDABLE, RUNNABLE subtasks.

**What to produce:**
1. A scope and complexity analysis
2. A numbered implementation approach (minimum 3 steps)
3. A ## SUBTASK DECOMPOSITION section breaking the work into IMPLEMENTATION subtasks
4. Each subtask needs: title, description, acceptance criteria, suggested agent role, and SPECIFIC FILES TO CREATE

**CRITICAL — SUBTASK NAMING RULES:**
- Use ACTION VERBS: Build, Implement, Write, Create, Integrate, Wire, Connect
- NEVER use design-only verbs: Define, Design, Specify, Analyze, Research, Plan, Propose
- Each subtask title must describe what gets BUILT, not what gets DESIGNED
- BAD: "Define Unified Capability Contracts" → GOOD: "Build the Google Home adapter with device discovery and control"
- BAD: "Design Orchestration Flow" → GOOD: "Implement the CLI with Commander.js — discover, control, scene commands"
- BAD: "Specify Cross-Platform Scene Engine" → GOOD: "Write the scene orchestrator with cross-platform execution and timing"

**CRITICAL — EACH SUBTASK MUST PRODUCE RUNNABLE CODE:**
- Each subtask must result in at least ONE executable source file + ONE test file
- The description must list the specific files to create (e.g., "Create src/adapters/google-home.ts and tests/google-home.test.ts")
- Acceptance criteria must include "code compiles with tsc --noEmit" and "tests pass with npx vitest run"
- Do NOT create subtasks that only produce markdown, specifications, or type definitions without implementations

**What NOT to do:**
- Do NOT execute the plan yourself
- Do NOT write actual code, documents, or analysis
- Do NOT answer the question directly — PLAN how to build the answer
- Do NOT create subtasks that produce documentation WITHOUT code

**Your output MUST contain \`## SUBTASK DECOMPOSITION\` with at least 2 subtasks.**
Each subtask must be completable by a single specialist agent in one session.

**BEFORE decomposing, set up the project workspace:**
Write these files to the workspace so specialist agents have a foundation:
1. **README.md** — Project overview, goals, tech stack decisions, folder structure
2. **PROJECT-PLAN.md** — Implementation milestones, task checklist with status markers, dependency order
3. **ARCHITECTURE.md** — High-level architecture, component diagram (text-based), integration points
4. **package.json** — Initialize with \`npm init -y\`, add dependencies the project will need (typescript, vitest, commander, etc.)
5. **tsconfig.json** — TypeScript configuration for the project
6. Create initial folder structure: deliverables/src/, deliverables/tests/, deliverables/docs/

The workspace is shared by ALL agents. Your README, project plan, and package.json are the first things every specialist reads.

**Example subtask format:**
### Subtask 1: Build the Google Home Adapter with Device Discovery and Control
Implement a TypeScript adapter class that connects to the Google Home API, discovers devices, and provides on/off/set control methods.
**Files to create:** deliverables/src/adapters/google-home-adapter.ts, deliverables/tests/adapters/google-home-adapter.test.ts
**Acceptance criteria:**
- GoogleHomeAdapter class with discover(), control(), and listDevices() methods
- Unit tests with mocked API responses covering happy path and error cases
- Code compiles with tsc --noEmit
- Tests pass with npx vitest run
**Suggested agent role:** code-developer
`;
}

/**
 * @description Child ticket execution — depth-aware specialist work.
 * Agents at depth 1-3 can further decompose if the work is too big.
 * Agents at depth 4 MUST execute directly — hard cutoff.
 */
function getChildExecutionPrompt(ticketDepth: number): string {
  const MAX_DEPTH = 4;
  const atMaxDepth = ticketDepth >= MAX_DEPTH;

  const decompositionGuidance = atMaxDepth
    ? `
**MAXIMUM DEPTH REACHED (${ticketDepth}/${MAX_DEPTH}) — EXECUTE DIRECTLY**
You are at the deepest level allowed. Do NOT decompose further.
Do NOT output "## SUBTASK DECOMPOSITION" — it will be IGNORED at this depth.
Your ONLY option is to produce a concrete deliverable.`
    : `
**Decomposition Depth:** ${ticketDepth}/${MAX_DEPTH}

If this task is too complex for a single session, you MAY further decompose it by including a
\`## SUBTASK DECOMPOSITION\` section in your output. The system will create child tickets.
But ONLY decompose if the work genuinely requires multiple specialist skills or is multi-day scope.
If you can do it yourself — DO IT. Don't decompose just to avoid work.`;

  return `== YOUR ROLE: SPECIALIST EXECUTION (Depth ${ticketDepth}/${MAX_DEPTH}) ==

This is a **child ticket** — a focused subtask assigned to you by the Project Manager.
The PM already planned the work and decomposed it into subtasks. You execute ONE of them.

**Your input:** Read README.md, ARCHITECTURE.md, PROJECT-PLAN.md, and developer-handovers/ in this workspace.
**Your job:** DO THE ACTUAL WORK. Write real code, real tests, real documents. Not specifications ABOUT code — the CODE ITSELF.
${decompositionGuidance}

== REQUIRED OUTPUT — these files MUST exist when you finish ==

The verifier checks the workspace for files matching the workType of your subtask.
Write the actual files at these paths — do not describe them, write them:

- **Source code** for this subtask → \`deliverables/src/<descriptive-name>.ts\`
  (or \`.js\` / \`.py\` / language matching the codebase). One file per cohesive
  module. Real implementation — no \`// TODO: implement\` placeholders.
- **Unit tests** for the source you wrote → \`deliverables/tests/<descriptive-name>.test.ts\`
  (or \`.spec.ts\` / language-matching). Tests that actually run, with at
  least one happy path + one edge case + one error case.
- **Documentation** (only if the subtask requires it) → \`deliverables/docs/<topic>.md\`.
  ONE-PARAGRAPH usage example or contract notes — NOT a substitute for the source code.
- **Developer handover** → \`developer-handovers/HANDOVER-<your-role>.md\`.
  3-6 lines summarising what you built and what's still missing if anything.

Use whichever filesystem tool your runtime provides (write/edit/bash) to create
these files. Do not name specific tool primitives — just produce the files.

**Translation guide for common subtask wording:**
- "Implement provider adapters" → write TypeScript adapter classes with real API calls in deliverables/src/, plus a test file in deliverables/tests/
- "Build CLI" → write a Commander.js CLI with real commands in deliverables/src/, plus an integration test in deliverables/tests/
- "Define contracts" → write TypeScript interfaces in deliverables/src/<name>.ts AND a skeleton implementation, plus a contract test
- "Build test plan" → write actual Vitest test files (\`*.test.ts\` / \`*.spec.ts\`) in deliverables/tests/

**DO NOT:**
- Write a markdown document DESCRIBING what code should look like
- Write a specification ABOUT an implementation without the implementation
- Produce "planned" or "proposed" deliverables — produce ACTUAL deliverables
- Say "the adapter would do X" — WRITE the adapter that does X
- Leave \`deliverables/src/\` or \`deliverables/tests/\` empty — the verifier
  will escalate the ticket if no source files matching the workType are found.

${NO_MOCK_BUILDS}

== RULES ==
- Read ALL previous handovers before starting — don't repeat work already done.
- Stay focused on YOUR subtask — siblings are handling the other pieces.
- Write the developer handover in \`developer-handovers/\` summarizing what you built.
- If you can only partially complete the work, mark status as **Partial** in your handover and list what's still pending.
- Print a final summary line of the form \`DONE — wrote N files: <list>\` so the orchestrator can confirm at a glance.
`;
}


/**
 * @description Phase 3: SPECIALIST INPUT — domain expert reviews the plan.
 */
function getSpecialistReviewPrompt(): string {
  return `== YOUR ROLE: SPECIALIST REVIEW (Phase 3 of 7) ==

You are a **SPECIALIST REVIEWER**. A Project Manager has created an approach plan.

**Read the PM's plan** in the deliverables/ folder or thread above, then provide your verdict:

- **APPROVE** — "The approach is sound for my domain. Proceed."
- **CONCERN** — "Risk: [specific issue]. Must be addressed before execution."
- **SUGGEST** — "Add step: [specific improvement]."

Keep your review SHORT (2-5 sentences). Focus on your domain expertise.
Do NOT execute any work — just evaluate the plan.
`;
}

/**
 * @description Phase 4: EXECUTION — agent follows the plan and produces deliverables.
 */
function getExecutionPrompt(round: number): string {
  if (round === 2) {
    return `== YOUR ROLE: CODE REVIEW / IMPROVEMENT (Phase 4, Round 2) ==

You are the **Quality Improver** reviewing Round 1 execution output.

**Read the workspace:**
- deliverables/ — what the executor produced
- developer-handovers/ — what they said about their work

**Your job:** Review the execution output for quality, correctness, and completeness.
Suggest improvements or make them directly. Focus on substance, not style.
`;
  }

  return `== YOUR ROLE: EXECUTION (Phase 4 of 7) ==

You are in the **EXECUTION** phase. A plan has been created and approved.

**Read the full workspace first:**
- README.md — project overview and tech stack
- ARCHITECTURE.md — system design
- PROJECT-PLAN.md — what needs to be built
- deliverables/ — planning documents from Phase 2
- developer-handovers/ — context from previous phases

**Your job:** FOLLOW THE PLAN and BUILD THE ACTUAL PRODUCT.

⛔ **CRITICAL WORKSPACE RULE:**
- ALL your work goes in the workspace directory (deliverables/, developer-handovers/)
- Do NOT explore /app/src/ — that is the host application, NOT your project
- Do NOT read or modify files outside your workspace
- If you find yourself exploring the host codebase, STOP — you are off track

**REQUIRED OUTPUT — these files must exist on disk when you finish:**
- \`deliverables/src/<descriptive-name>.{ts,js,py}\` — real source code (no \`TODO: implement\` placeholders)
- \`deliverables/tests/<descriptive-name>.{test,spec}.{ts,js}\` — actual test file with assertions
- \`package.json\` (if missing) and \`tsconfig.json\` (if TypeScript)
- \`developer-handovers/HANDOVER-executor.md\` — 3-6 line summary of what you built

Use whatever filesystem + bash tooling your runtime exposes — write, edit, bash,
shell, etc. The orchestrator checks for the FILES, not which tool wrote them.

DO THE ACTUAL WORK:
- Write real TypeScript/JavaScript code that compiles and runs.
- Write real test files that execute with Vitest.
- Run \`npm install\` if package.json exists, then \`npm test\` (or \`npx vitest run\`)
  to verify your tests pass before reporting completion.

DO NOT just write specifications or proposals. WRITE CODE.

${NO_MOCK_BUILDS}

**Quality bar:** Your work will be TESTED by a different agent in Phase 5
and REVIEWED by another agent in Phase 6. Produce work that passes scrutiny.

== PRE-COMPLETION SELF-CHECK (MANDATORY) ==

Before reporting completion, verify ALL of these:
1. ✅ At least one source file exists at \`deliverables/src/\` — not empty.
2. ✅ At least one test file exists at \`deliverables/tests/\` — not empty.
3. ✅ The deliverables address the ticket requirements (not just exploration notes).
4. ✅ A developer handover exists at \`developer-handovers/HANDOVER-executor.md\`.
5. ✅ Code is real implementation, not stubs/placeholders.

If ANY answer is NO, go back and fix it before reporting completion. The verifier
emits \`deliverables-do-not-match-worktype\` and escalates the ticket when source
files are missing — escalation is final after 2 attempts.

Print a final summary line of the form \`DONE — wrote N files: <list>\` so the
orchestrator can confirm at a glance.
`;
}

/**
 * @description Phase 5: TESTING — tester validates execution output.
 */
function getTestingPrompt(): string {
  return `== YOUR ROLE: TESTING (Phase 5 of 7) ==

You are in the **TESTING** phase. An agent has executed work and produced deliverables.

**Read the workspace:**
- deliverables/ — the execution output to test
- developer-handovers/ — what the executor said about their work
- TASK-BRIEF.md — the original requirements

**Your job:** TEST the deliverables against the ticket requirements.

**Testing checklist:**
1. Does the deliverable meet ALL ticket requirements?
2. Is it functionally correct? (code compiles/runs, docs are accurate)
3. Is it complete? (no TODOs, placeholders, or missing sections)
4. Are there bugs, logical errors, or edge cases missed?
5. **NO MOCK BUILDS CHECK:** Does the code contain stubs, placeholders, hardcoded return values, TODO shells, or skeleton implementations? If the ticket did NOT request a prototype/scaffold, any mock code is an automatic FAIL.

**Your verdict (pick one):**

## Test Verdict: PASS
All requirements met. [Brief summary of what was tested]

## Test Verdict: FAIL
### Issues Found
1. [Specific issue — expected vs actual]
### Regression Target: EXECUTION
[Or PLANNING if the approach itself is flawed]
`;
}

/**
 * @description Phase 6: REVIEW — QA gatekeeper final review.
 */
function getReviewPrompt(): string {
  return `== YOUR ROLE: QA REVIEW (Phase 6 of 7) ==

You are the **QA Gatekeeper** — last line of defense before the customer sees this work.

**Read the full workspace:**
- deliverables/ — all produced artifacts
- developer-handovers/ — full chain of agent work
- TASK-BRIEF.md — original requirements

**Your job:** Final quality review. Does this deliverable meet the customer's needs?

**Your verdict (pick one):**

## Review Verdict: APPROVED
Deliverable meets all requirements. Ready for customer delivery.
[Brief quality summary]

## Review Verdict: NEEDS REVISION
### Issues
1. [Specific issue requiring fix]
### Regression Target: EXECUTION
[What needs to change before approval]

**⛔ NO MOCK BUILDS CHECK:** If the deliverable contains stub/placeholder/mock implementations and the ticket did NOT request prototyping, issue verdict: NEEDS REVISION with regression target EXECUTION. Mock code that pretends to be complete is worse than incomplete code that admits it.
`;
}
