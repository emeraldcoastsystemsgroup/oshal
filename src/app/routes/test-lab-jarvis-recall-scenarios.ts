/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Register the Jarvis cross-conversation recall acceptance card: one explicit-only step that seeds a tagged owner-bound thread holding a random codeword, asks for it from a new thread through the real /api/jarvis/ask, requires the answer and the owner-scoped capture of conversation_query/conversation_fetch, and removes exactly what it created. Guard: tests/unit/test-lab-jarvis-recall-registration.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attach the Antigravity-brain guards this card's first live run called for: the recall ask died on a headless read_file denial because agy chased the answer with its own tools. antigravity-host-tool-loop runs the same two-tool recall through the real host loop with agy held tool-less; antigravity-bot-runtime pins the invocation's permission scope.
 */
import type { Scenario } from './test-lab-scenarios';
import { JARVIS_RECALL_STEP_LABEL, runJarvisCrossThreadRecall } from './test-lab-jarvis-recall';

export const JARVIS_RECALL_SCENARIOS: Scenario[] = [{
  id: 'jarvis-cross-thread-recall',
  title: 'Jarvis recalls another conversation',
  group: 'jarvis',
  explicitOnly: true,
  description: 'Seeds one clearly labelled thread (testlab-recall-a-*) for you holding a random codeword, then asks Jarvis for '
    + 'that codeword from a NEW thread without repeating it. Passes only when the answer carries the codeword AND the '
    + 'Token Chase capture of that ask, read through your own owner-scoped routes, shows conversation_query or '
    + 'conversation_fetch ran for you. Spends ONE real model turn on your configured brain, so it runs only from its own '
    + 'card, never from "Run live scenarios". Both threads, their messages, the chat ticket and the ask workspace are '
    + 'deleted afterwards; anything left turns the card red. Same case as scripts/operations/jarvis-recall-live-proof.js.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/jarvis-recall-acceptance.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-recall-acceptance-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-jarvis-recall-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-read-only-tools-owner-scope-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/jarvis-persona-recall.spec.ts' },
    { level: 'integration', path: 'tests/unit/antigravity-host-tool-loop.spec.ts' },
    { level: 'unit', path: 'tests/unit/antigravity-bot-runtime.spec.ts' },
  ],
  steps: [
    { id: 'jarvis-recall-other-thread', app: 'jarvis', label: JARVIS_RECALL_STEP_LABEL,
      run: (cookie, _prior, runtime) => runJarvisCrossThreadRecall(cookie, runtime) },
  ],
}];
