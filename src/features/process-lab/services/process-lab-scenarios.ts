/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from process-lab-service.ts (1000-line cap decomposition): built-in scenario catalog and the initial run-step skeleton
 */

import type { ProcessLabScenario, ProcessLabStep } from './process-lab-types';

/**
 * @description The ordered step skeleton every Process Lab run starts from; each run clones these definitions with a pending status so the UI can show step-by-step progress.
 */
export const INITIAL_STEP_DEFINITIONS: Array<Pick<ProcessLabStep, 'id' | 'label'>> = [
  { id: 'preflight', label: 'Preflight Snapshot' },
  { id: 'create-ticket', label: 'Create Ticket' },
  { id: 'planning-watch', label: 'Watch Planning Flow' },
  { id: 'approve-build', label: 'Approve Build Gate' },
  { id: 'outcome-watch', label: 'Watch Outcome' },
  { id: 'collect-artifacts', label: 'Collect Artifacts' },
  { id: 'assessment', label: 'Assess Trace' },
];

/**
 * @description Built-in low/medium/high complexity scenarios that exercise the ticket lifecycle end-to-end with deterministic requests, used as the catalog callers select from (optionally with per-run overrides).
 */
export const DEFAULT_SCENARIOS: ProcessLabScenario[] = [
  {
    id: 'low-python-hello',
    name: 'Low Complexity - Python Hello',
    complexity: 'low',
    description: 'Exercises the queue, planning handoff, approval gate, build loop, and trace capture on a tiny deterministic request.',
    goal: 'Check that a simple request can move from approved to planning, optionally pause for approval, and finish with a clean trace.',
    autoApproveBuild: true,
    planningWaitMs: 6 * 60_000,
    completionWaitMs: 10 * 60_000,
    ticket: {
      title: 'Create a Python hello-world script with unit test',
      description: [
        'Create a simple Python script that prints Hello, World! and a corresponding unit test.',
        '',
        'Files to create:',
        '- deliverables/hello.py - prints Hello, World! to stdout',
        '- deliverables/test_hello.py - unit test that verifies the output',
        '',
        'Acceptance Criteria:',
        '- hello.py prints exactly "Hello, World!" when run',
        '- test_hello.py passes when run with pytest',
        '- Both files are well-formed Python 3',
      ].join('\n'),
      labels: ['process-lab', 'python', 'low'],
      priority: 'low',
    },
  },
  {
    id: 'medium-markdown-converter',
    name: 'Medium Complexity - Markdown Converter',
    complexity: 'medium',
    description: 'Runs a multi-file implementation request that usually needs decomposition, verification, and at least one review loop.',
    goal: 'Check how the system behaves when a request should decompose into concrete subtasks and produce code plus tests.',
    autoApproveBuild: true,
    planningWaitMs: 7 * 60_000,
    completionWaitMs: 12 * 60_000,
    ticket: {
      title: 'Build a markdown-to-HTML converter',
      description: [
        'Build a TypeScript markdown-to-HTML converter library with paragraph, heading, bold, italic, and unordered-list support.',
        '',
        'Files to create:',
        '- deliverables/src/markdown.ts',
        '- deliverables/tests/markdown.test.ts',
        '',
        'Acceptance Criteria:',
        '- Exposes a convertMarkdown(input: string): string function',
        '- Supports headings, paragraphs, **bold**, *italic*, and unordered lists',
        '- Includes representative tests for canonical formatting cases',
        '- Code compiles and tests pass',
      ].join('\n'),
      labels: ['process-lab', 'typescript', 'medium'],
      priority: 'medium',
    },
  },
  {
    id: 'high-landing-page',
    name: 'High Complexity - Landing Page',
    complexity: 'high',
    description: 'Pushes the planning and execution loop with a broader frontend request so we can compare queue behavior under higher scope.',
    goal: 'Observe decomposition breadth, approval behavior, regression loops, and verification findings on a larger request.',
    autoApproveBuild: true,
    planningWaitMs: 8 * 60_000,
    completionWaitMs: 15 * 60_000,
    ticket: {
      title: 'Build a modern e-business landing page',
      description: [
        'Build a responsive e-business landing page with a hero section, product highlights, testimonials, pricing, and contact CTA.',
        '',
        'Files to create:',
        '- deliverables/index.html',
        '- deliverables/styles.css',
        '- deliverables/main.js',
        '',
        'Acceptance Criteria:',
        '- Layout works on desktop and mobile',
        '- Hero, feature, testimonial, pricing, and CTA sections are present',
        '- Styling is cohesive and polished',
        '- Basic interaction or animation is included',
      ].join('\n'),
      labels: ['process-lab', 'frontend', 'high'],
      priority: 'high',
    },
  },
];
