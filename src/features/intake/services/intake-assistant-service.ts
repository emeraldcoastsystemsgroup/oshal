/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 22: Conversational intake assistant - interviews users with consulting 101 questions before ticket enters pipeline
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Outcome-first L1 intake - classifies quick answers vs lightweight execution vs structured project delivery
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type {
  IntakeEffortTier,
  IntakeOutcomeType,
  IntakePlanStatus,
  IntakePlanningEntryMode,
} from '@/shared/types/intake';
import {
  IntakeL1ProcessorService,
  type IntakeL1Assessment,
} from './intake-l1-processor-service';

const logger = createChildLogger({ module: 'intake-assistant' });

/**
 * @description Represents one in-progress or completed intake conversation, holding the full
 * message transcript, the structured data gathered so far, and the latest L1 assessment so the
 * assistant can resume or summarize the interview at any point.
 */
export interface IntakeSession {
  id: string;
  status: 'active' | 'submitted' | 'cancelled';
  messages: IntakeMessage[];
  gathered: IntakeGathered;
  assessment: IntakeL1Assessment | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * @description A single turn in the intake transcript, capturing who spoke (the assistant or the
 * user), the text content, and when it occurred so the conversation can be replayed in order.
 */
export interface IntakeMessage {
  role: 'assistant' | 'user';
  content: string;
  timestamp: string;
}

/**
 * @description The accumulated answers extracted from the user during the interview, normalized into
 * the optional fields needed to classify the request and build a downstream ticket payload; every
 * field is optional because the user may stop the interview early.
 */
export interface IntakeGathered {
  title?: string;
  description?: string;
  goal?: string;
  outcomeType?: IntakeOutcomeType | '';
  effortTier?: IntakeEffortTier | '';
  projectType?: 'poc' | 'internal' | 'production' | 'research' | '';
  repoUrl?: string;
  credentialsNeeded?: boolean;
  credentialNotes?: string;
  apiSpecs?: string;
  businessRequirements?: string;
  suppliedPlanNotes?: string;
  suppliedPlanPaths?: string[];
  knownGaps?: string;
  reviewStages?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  labels?: string[];
  escalationFlags?: string[];
}

const INTERVIEW_FLOW: Array<{
  key: keyof IntakeGathered;
  question: string;
}> = [
  { key: 'goal', question: "What's the goal? What are you trying to build or accomplish?" },
  {
    key: 'outcomeType',
    question: 'What kind of outcome do you want: a quick answer, a small change, a proof of concept, an integration, an investigation, or a production-grade product?',
  },
  {
    key: 'effortTier',
    question: 'What level of effort do you want: quick, low-fidelity, standard, or professional?',
  },
  {
    key: 'projectType',
    question: 'Is this closer to a POC/prototype, internal tool, production release, or research effort?',
  },
  { key: 'repoUrl', question: 'Is there an existing code repo? If so, paste the URL.' },
  { key: 'apiSpecs', question: 'Any technical references, specs, APIs, architecture notes, or diagrams I should know about?' },
  { key: 'businessRequirements', question: 'What business requirements, success criteria, or delivery expectations matter most?' },
  {
    key: 'suppliedPlanNotes',
    question: 'Do you already have a plan, architecture package, or spec docs we should validate instead of rebuilding? If yes, summarize it and include any file paths.',
  },
  { key: 'credentialsNeeded', question: 'Will this need credentials or access keys? (API keys, cloud access, DB connections, etc.)' },
  { key: 'knownGaps', question: "Any blockers, risks, open questions, or unknowns that planning should account for?" },
  { key: 'priority', question: 'How urgent is this? (low / medium / high / critical)' },
  { key: 'reviewStages', question: 'Would you like reviews at specific stages? (after planning, after first build, before deploy, etc.)' },
];

/**
 * @description Drives the conversational intake flow: it interviews a user through a fixed set of
 * consulting questions, extracts structured answers, runs the L1 processor to classify the request,
 * and ultimately produces a ticket payload (with PM prep packet) for the delivery pipeline.
 */
export class IntakeAssistantService {
  private readonly sessions = new Map<string, IntakeSession>();
  private readonly l1Processor = new IntakeL1ProcessorService();

  /**
   * @description Creates and registers a new active intake session, seeding it with the assistant's
   * opening message so the front end can begin the interview immediately.
   * @returns The new session id paired with the assistant's first message.
   */
  startSession(): { sessionId: string; message: IntakeMessage } {
    const session: IntakeSession = {
      id: randomUUID(),
      status: 'active',
      messages: [],
      gathered: {},
      assessment: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const opening: IntakeMessage = {
      role: 'assistant',
      content: [
        "Hi! I'm your intake assistant.",
        'I will help decide whether this should be answered immediately, handled as a lightweight build, or set up like a real product project.',
        'You can say **"done"** or **"that is enough"** at any time and I will summarize what we have.',
        '',
        "**Let's start - what's the goal? What are you trying to build or accomplish?**",
      ].join('\n'),
      timestamp: new Date().toISOString(),
    };

    session.messages.push(opening);
    this.sessions.set(session.id, session);

    logger.info({ sessionId: session.id }, 'Intake session started');
    return { sessionId: session.id, message: opening };
  }

  /**
   * @description Advances an active session by one turn: records the user's reply, detects early-exit
   * keywords, extracts the answer to the current interview question, re-runs the L1 assessment, and
   * either asks the next question or returns the final summary.
   * @param sessionId The id of the active session to advance.
   * @param userMessage The raw text the user sent for the current question.
   * @returns The assistant's next message, whether the interview is finished, and the updated session.
   */
  processMessage(sessionId: string, userMessage: string): { message: IntakeMessage; done: boolean; session: IntakeSession } {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') {
      throw new Error(`No active intake session: ${sessionId}`);
    }

    const userMsg: IntakeMessage = { role: 'user', content: userMessage, timestamp: new Date().toISOString() };
    session.messages.push(userMsg);
    session.updatedAt = new Date().toISOString();

    const lower = userMessage.toLowerCase().trim();
    if (lower === 'done' || lower === 'submit' || lower === 'skip' || lower === 'that is enough' || lower === "that's enough" || lower === 'thats enough') {
      return this.buildSummary(session);
    }

    const currentIndex = this.getCurrentQuestionIndex(session);
    if (currentIndex < INTERVIEW_FLOW.length) {
      this.extractAnswer(session, INTERVIEW_FLOW[currentIndex], userMessage);
      session.assessment = this.l1Processor.assess(session.gathered);
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < INTERVIEW_FLOW.length) {
      const nextQ = INTERVIEW_FLOW[nextIndex];
      const assistantMsg: IntakeMessage = {
        role: 'assistant',
        content: `Got it. ${nextQ.question}`,
        timestamp: new Date().toISOString(),
      };
      session.messages.push(assistantMsg);
      return { message: assistantMsg, done: false, session };
    }

    return this.buildSummary(session);
  }

  /**
   * @description Looks up a session by id so callers can inspect its current state without mutating it.
   * @param sessionId The id of the session to retrieve.
   * @returns The matching session, or undefined if no session exists for that id.
   */
  getSession(sessionId: string): IntakeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * @description Converts a gathered session into the final ticket payload: it assembles a markdown
   * description from the gathered fields and L1 assessment, derives planning metadata and a PM prep
   * packet, marks the session as submitted, and returns the title/priority/labels/metadata bundle.
   * @param sessionId The id of the session to convert into a ticket.
   * @returns A plain object containing the ticket title, description, priority, labels, and metadata.
   */
  buildTicketPayload(sessionId: string): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No intake session: ${sessionId}`);

    const g = session.gathered;
    const assessment = session.assessment ?? this.l1Processor.assess(g);
    const planningMetadata = derivePlanningMetadata(g, assessment);
    session.assessment = assessment;

    const title = g.title || g.goal || 'Untitled ticket';
    const descParts: string[] = [];
    if (g.goal) descParts.push(`## Goal\n${g.goal}`);
    descParts.push([
      '## Delivery Profile',
      `- Requested outcome: ${g.outcomeType || assessment.outcomeType}`,
      `- Requested effort: ${g.effortTier || assessment.effortTier}`,
      `- Recommended path: ${assessment.recommendedPath}`,
      `- Planning mode: ${assessment.planningMode}`,
      `- Team shape: ${assessment.teamShape}`,
      `- Setup level: ${assessment.setupLevel}`,
    ].join('\n'));
    if (g.businessRequirements) descParts.push(`## Business Requirements\n${g.businessRequirements}`);
    if (g.apiSpecs) descParts.push(`## Technical References\n${g.apiSpecs}`);
    if (planningMetadata.suppliedPlanSummary || planningMetadata.suppliedPlanningArtifactPaths.length > 0 || planningMetadata.suppliedPlanningArtifacts.length > 0) {
      descParts.push([
        '## Supplied Plan Package',
        planningMetadata.suppliedPlanSummary ? planningMetadata.suppliedPlanSummary : '- Summary: user indicated an existing planning package',
        planningMetadata.suppliedPlanningArtifacts.length > 0
          ? `- Detected supplied artifacts: ${planningMetadata.suppliedPlanningArtifacts.join(', ')}`
          : '',
        planningMetadata.suppliedPlanningArtifactPaths.length > 0
          ? `- Detected plan paths: ${planningMetadata.suppliedPlanningArtifactPaths.join(', ')}`
          : '',
      ].filter(Boolean).join('\n'));
    }
    if (g.knownGaps) descParts.push(`## Known Gaps and Risks\n${g.knownGaps}`);
    if (g.credentialsNeeded) descParts.push(`## Credentials\n${g.credentialNotes || 'Credentials required - details TBD'}`);
    if (g.reviewStages?.length) descParts.push(`## Review Stages\n${g.reviewStages.join(', ')}`);
    if (assessment.requiredArtifacts.length > 0) {
      descParts.push(`## Required Structure\n${assessment.requiredArtifacts.map((artifact) => `- ${artifact}`).join('\n')}`);
    }
    if (assessment.artifactBlueprints.length > 0) {
      descParts.push([
        '## Project Preparation Contract',
        ...assessment.artifactBlueprints.map((artifact) => `- ${artifact.displayName} (${artifact.artifactId}) - owner: ${artifact.ownerRole} - standards: ${artifact.governingStandards.join(', ')} - ${artifact.purpose}`),
      ].join('\n'));
    }
    if (assessment.rationale.length > 0) {
      descParts.push(`## L1 Assessment Notes\n${assessment.rationale.map((note) => `- ${note}`).join('\n')}`);
    }
    const pmPrepPacket = buildPmPrepPacket(g, assessment, planningMetadata);

    session.status = 'submitted';

    return {
      title,
      description: descParts.join('\n\n') || g.goal || '',
      priority: g.priority || 'medium',
      labels: g.labels || [],
      metadata: {
        outcomeType: g.outcomeType || assessment.outcomeType,
        effortTier: g.effortTier || assessment.effortTier,
        projectType: g.projectType || '',
        repoUrl: g.repoUrl || '',
        credentialsNeeded: g.credentialsNeeded || false,
        credentialNotes: g.credentialNotes || '',
        reviewStages: g.reviewStages || [],
        escalationFlags: g.escalationFlags || [],
        recommendedPath: assessment.recommendedPath,
        planningMode: assessment.planningMode,
        planningEntryMode: planningMetadata.planningEntryMode,
        planStatus: planningMetadata.planStatus,
        suppliedPlanSummary: planningMetadata.suppliedPlanSummary || '',
        suppliedPlanningArtifacts: planningMetadata.suppliedPlanningArtifacts,
        suppliedPlanningArtifactPaths: planningMetadata.suppliedPlanningArtifactPaths,
        providedPlanPaths: planningMetadata.suppliedPlanningArtifactPaths,
        teamShape: assessment.teamShape,
        setupLevel: assessment.setupLevel,
        seriousProject: assessment.seriousProject,
        requiredArtifacts: assessment.requiredArtifacts,
        artifactBlueprints: assessment.artifactBlueprints,
        pmPrepPacket,
        l1Assessment: assessment,
        intakeSessionId: sessionId,
        source: 'intake-assistant',
      },
    };
  }

  private getCurrentQuestionIndex(session: IntakeSession): number {
    const userMsgCount = session.messages.filter((m) => m.role === 'user').length;
    return Math.min(userMsgCount - 1, INTERVIEW_FLOW.length - 1);
  }

  private extractAnswer(session: IntakeSession, question: typeof INTERVIEW_FLOW[number], answer: string): void {
    const g = session.gathered;
    const lower = answer.toLowerCase().trim();

    switch (question.key) {
      case 'goal':
        g.goal = answer;
        g.title = answer.length <= 80 ? answer : `${answer.slice(0, 77).trim()}...`;
        break;
      case 'outcomeType':
        if (lower.includes('question') || lower.includes('answer')) g.outcomeType = 'question-answer';
        else if (lower.includes('small') || lower.includes('minor') || lower.includes('quick fix')) g.outcomeType = 'small-change';
        else if (lower.includes('poc') || lower.includes('prototype') || lower.includes('proof')) g.outcomeType = 'proof-of-concept';
        else if (lower.includes('integration') || lower.includes('connector') || lower.includes('oauth') || lower.includes('sync')) g.outcomeType = 'integration';
        else if (lower.includes('investigation') || lower.includes('debug') || lower.includes('research') || lower.includes('root cause')) g.outcomeType = 'investigation';
        else if (lower.includes('product') || lower.includes('production') || lower.includes('release')) g.outcomeType = 'product-delivery';
        else g.outcomeType = '';
        break;
      case 'effortTier':
        if (lower.includes('quick')) g.effortTier = 'quick';
        else if (lower.includes('low') || lower.includes('fidelity') || lower.includes('prototype') || lower.includes('poc')) g.effortTier = 'low-fidelity';
        else if (lower.includes('professional') || lower.includes('serious') || lower.includes('production')) g.effortTier = 'professional';
        else if (lower.includes('standard')) g.effortTier = 'standard';
        else g.effortTier = '';
        break;
      case 'projectType':
        if (lower.includes('poc') || lower.includes('prototype')) g.projectType = 'poc';
        else if (lower.includes('internal')) g.projectType = 'internal';
        else if (lower.includes('prod')) g.projectType = 'production';
        else if (lower.includes('research')) g.projectType = 'research';
        else g.projectType = '';
        break;
      case 'repoUrl':
        g.repoUrl = answer.startsWith('http') ? answer.trim() : (lower === 'no' || lower === 'none' ? '' : answer);
        break;
      case 'credentialsNeeded':
        g.credentialsNeeded = lower.includes('yes') || lower.includes('need') || lower.includes('require');
        if (g.credentialsNeeded) {
          g.credentialNotes = answer;
          g.escalationFlags = [...(g.escalationFlags || []), 'credentials-required'];
        }
        break;
      case 'suppliedPlanNotes':
        if (lower === 'no' || lower === 'none' || lower === 'not yet') {
          g.suppliedPlanNotes = '';
          g.suppliedPlanPaths = [];
        } else {
          g.suppliedPlanNotes = answer.trim();
          g.suppliedPlanPaths = extractDocumentPaths(answer);
          if ((g.suppliedPlanPaths?.length ?? 0) > 0 || hasExplicitPlanSignal(answer)) {
            g.escalationFlags = [...new Set([...(g.escalationFlags || []), 'plan-supplied'])];
          }
        }
        break;
      case 'priority':
        if (lower.includes('critical')) g.priority = 'critical';
        else if (lower.includes('high')) g.priority = 'high';
        else if (lower.includes('low')) g.priority = 'low';
        else g.priority = 'medium';
        break;
      case 'reviewStages':
        if (lower === 'no' || lower === 'none') {
          g.reviewStages = [];
        } else {
          g.reviewStages = answer.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        }
        if (g.reviewStages?.length) {
          g.escalationFlags = [...(g.escalationFlags || []), 'review-requested'];
        }
        break;
      default:
        (g as Record<string, unknown>)[question.key] = answer;
    }
  }

  private buildSummary(session: IntakeSession): { message: IntakeMessage; done: boolean; session: IntakeSession } {
    const g = session.gathered;
    const assessment = session.assessment ?? this.l1Processor.assess(g);
    const planningMetadata = derivePlanningMetadata(g, assessment);
    session.assessment = assessment;

    const lines: string[] = ["Here's what I've prepared for your ticket:\n"];
    if (g.title || g.goal) lines.push(`**Title:** ${g.title || g.goal}`);
    lines.push(`**Outcome:** ${g.outcomeType || assessment.outcomeType}`);
    lines.push(`**Level of Effort:** ${g.effortTier || assessment.effortTier}`);
    if (g.projectType) lines.push(`**Type:** ${g.projectType}`);
    if (g.priority) lines.push(`**Priority:** ${g.priority}`);
    if (g.repoUrl) lines.push(`**Repo:** ${g.repoUrl}`);
    if (g.credentialsNeeded) lines.push(`**Credentials:** Required - ${g.credentialNotes || 'details TBD'}`);
    if (g.apiSpecs) lines.push(`**Tech Refs:** ${g.apiSpecs}`);
    if (g.businessRequirements) lines.push(`**Requirements:** ${g.businessRequirements}`);
    if (g.knownGaps) lines.push(`**Known Gaps:** ${g.knownGaps}`);
    if (g.reviewStages?.length) lines.push(`**Review At:** ${g.reviewStages.join(', ')}`);
    lines.push(`**Recommended Path:** ${assessment.recommendedPath}`);
    lines.push(`**Planning Mode:** ${assessment.planningMode}`);
    lines.push(`**Planning Entry:** ${planningMetadata.planningEntryMode}`);
    if (planningMetadata.suppliedPlanSummary) lines.push(`**Supplied Plan:** ${planningMetadata.suppliedPlanSummary}`);
    if (planningMetadata.suppliedPlanningArtifactPaths.length > 0) lines.push(`**Plan Paths:** ${planningMetadata.suppliedPlanningArtifactPaths.join(', ')}`);
    lines.push(`**Team Shape:** ${assessment.teamShape}`);
    lines.push(`**Setup Level:** ${assessment.setupLevel}`);
    if (assessment.requiredArtifacts.length > 0) {
      lines.push(`**Required Structure:** ${assessment.requiredArtifacts.join(', ')}`);
    }
    if (assessment.artifactBlueprints.length > 0) {
      lines.push(`**Preparation Contract:** ${assessment.artifactBlueprints.map((artifact) => `${artifact.displayName} -> ${artifact.ownerRole}`).join('; ')}`);
      lines.push('**Prep Packet:** PM-PREP-PACKET.md will be generated for the planning team with required artifacts and example outlines.');
    }
    if (assessment.rationale.length > 0) {
      lines.push(`**Why:** ${assessment.rationale.join(' ')}`);
    }
    if (g.escalationFlags?.length) lines.push(`\n**Flags:** ${g.escalationFlags.join(', ')}`);

    if (assessment.recommendedPath === 'instant-answer') {
      lines.push('\n**Recommendation:** This looks like immediate-answer work. A front-door or intake bot should answer it directly unless you still want a tracked ticket.');
    } else {
      lines.push('\n**Ready to submit?** Click Create to submit this ticket, or keep chatting to add more details.');
    }

    const summaryMsg: IntakeMessage = {
      role: 'assistant',
      content: lines.join('\n'),
      timestamp: new Date().toISOString(),
    };
    session.messages.push(summaryMsg);

    return { message: summaryMsg, done: true, session };
  }
}

interface DerivedPlanningMetadata {
  planningEntryMode: IntakePlanningEntryMode;
  planStatus: IntakePlanStatus;
  suppliedPlanSummary?: string;
  suppliedPlanningArtifacts: string[];
  suppliedPlanningArtifactPaths: string[];
}

function derivePlanningMetadata(g: IntakeGathered, assessment: IntakeL1Assessment): DerivedPlanningMetadata {
  if (assessment.recommendedPath !== 'structured-project') {
    return {
      planningEntryMode: 'discovery',
      planStatus: 'approved',
      suppliedPlanningArtifacts: [],
      suppliedPlanningArtifactPaths: [],
    };
  }

  const explicitPlanSummary = normalizeText(g.suppliedPlanNotes);
  const suppliedPlanningArtifactPaths = uniqueStrings([
    ...(g.suppliedPlanPaths ?? []),
    ...extractDocumentPaths(g.apiSpecs),
  ]).filter(isLikelyPlanningPath);
  const planSignalText = [
    explicitPlanSummary,
    g.apiSpecs,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
  const suppliedPlanningArtifacts = inferPlanningArtifacts(planSignalText, suppliedPlanningArtifactPaths);
  const hasSuppliedPlan = Boolean(explicitPlanSummary)
    || suppliedPlanningArtifactPaths.length > 0
    || hasExplicitPlanSignal(planSignalText);

  if (!hasSuppliedPlan) {
    return {
      planningEntryMode: 'discovery',
      planStatus: 'missing',
      suppliedPlanningArtifacts: [],
      suppliedPlanningArtifactPaths: [],
    };
  }

  return {
    planningEntryMode: 'validate-existing',
    planStatus: 'supplied',
    suppliedPlanSummary: explicitPlanSummary
      ?? `Use supplied planning artifacts from: ${suppliedPlanningArtifactPaths.join(', ')}`,
    suppliedPlanningArtifacts,
    suppliedPlanningArtifactPaths,
  };
}

function inferPlanningArtifacts(sourceText: string, suppliedPaths: string[]): string[] {
  const normalized = `${sourceText} ${suppliedPaths.join(' ')}`.toLowerCase();
  const artifactSignals: Array<{ artifact: string; pattern: RegExp }> = [
    { artifact: 'technical-architecture', pattern: /\btechnical-specification\b|\btechnical architecture\b|\barchitecture\b/ },
    { artifact: 'functional-specification', pattern: /\bfunctional spec\b|\bfunctional specification\b|\brequirements doc\b/ },
    { artifact: 'integration-plan', pattern: /\bintegration plan\b|\boauth\b|\bconnector\b|\bapi mapping\b/ },
    { artifact: 'product-diagrams', pattern: /\bdiagram\b|\bmermaid\b|\bdraw\.io\b|\bsequence diagram\b/ },
    { artifact: 'research-summary', pattern: /\bresearch\b|\binvestigation\b/ },
    { artifact: 'key-decisions-log', pattern: /\bdecision log\b|\badr\b|\bdecision record\b/ },
    { artifact: 'stack-definition', pattern: /\btech stack\b|\bstack definition\b/ },
    { artifact: 'hosting-and-environment-plan', pattern: /\bhosting\b|\bdeployment\b|\binfra\b|\benvironment plan\b/ },
    { artifact: 'costing-and-budget-view', pattern: /\bcost\b|\bbudget\b|\bpricing\b/ },
    { artifact: 'effort-estimate', pattern: /\bestimate\b|\btimeline\b|\beffort\b/ },
    { artifact: 'phased-delivery-plan', pattern: /\bphase\b|\brollout\b|\bdelivery plan\b/ },
    { artifact: 'MASTER-PLAN.md', pattern: /\bmaster-plan\.md\b|\bmaster plan\b/ },
    { artifact: 'task-brief', pattern: /\btask brief\b/ },
    { artifact: 'acceptance-criteria', pattern: /\bacceptance criteria\b/ },
  ];

  return artifactSignals
    .filter((signal) => signal.pattern.test(normalized))
    .map((signal) => signal.artifact);
}

function extractDocumentPaths(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const matches = value.match(/[A-Za-z]:\\[^\s,;]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_\-/\\.]+\.md\b/gi) ?? [];
  return uniqueStrings(matches.map((match) => match.trim()));
}

function hasExplicitPlanSignal(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return /\balready have\b|\bexisting plan\b|\bsupplied plan\b|\battached plan\b|\buse the plan\b|\bvalidate (the )?plan\b|\bmaster-plan\b|\bimplementation-plan\b|\btechnical-specification\b/i.test(value);
}

function isLikelyPlanningPath(value: string): boolean {
  return /plan|spec|architecture|design|brief|requirements|diagram|adr|decision/i.test(value);
}

function normalizeText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function buildPmPrepPacket(
  gathered: IntakeGathered,
  assessment: IntakeL1Assessment,
  planningMetadata: DerivedPlanningMetadata,
): string {
  const lines: string[] = [
    '# PM-PREP-PACKET',
    '',
    `**Goal:** ${gathered.goal || gathered.title || 'Not provided'}`,
    `**Recommended Path:** ${assessment.recommendedPath}`,
    `**Planning Mode:** ${assessment.planningMode}`,
    `**Planning Entry:** ${planningMetadata.planningEntryMode}`,
    `**Plan Status:** ${planningMetadata.planStatus}`,
    `**Team Shape:** ${assessment.teamShape}`,
    `**Setup Level:** ${assessment.setupLevel}`,
    '',
    '## Outcome Summary',
    `- Requested outcome: ${gathered.outcomeType || assessment.outcomeType}`,
    `- Requested effort: ${gathered.effortTier || assessment.effortTier}`,
    `- Project type: ${gathered.projectType || 'unspecified'}`,
  ];

  if (gathered.businessRequirements) {
    lines.push(`- Business requirements: ${gathered.businessRequirements}`);
  }
  if (gathered.apiSpecs) {
    lines.push(`- Technical references: ${gathered.apiSpecs}`);
  }
  if (gathered.repoUrl) {
    lines.push(`- Existing repo: ${gathered.repoUrl}`);
  }
  if (gathered.credentialsNeeded) {
    lines.push(`- Credentials/setup required: ${gathered.credentialNotes || 'Yes - details still need clarification'}`);
  }
  if (gathered.knownGaps) {
    lines.push(`- Known gaps or risks: ${gathered.knownGaps}`);
  }

  lines.push(
    '',
    '## PM Instructions',
    assessment.recommendedPath === 'structured-project'
      ? '1. Treat this as serious delivery work. Prepare the project using the artifact contract below before formal execution starts.'
      : '1. Keep this lightweight. Prepare only the minimum artifacts needed to execute safely.',
    planningMetadata.planningEntryMode === 'validate-existing'
      ? '2. A supplied plan exists. Validate it, preserve what is good, and only fill the missing or weak areas.'
      : '2. No approved plan exists yet. Use discovery and architecture inputs to create the missing planning package.',
    '3. Use the example outlines as shape guidance, not rigid templates.',
    '4. If an artifact is already supplied and good enough, tighten it instead of recreating it from scratch.',
  );

  if (assessment.rationale.length > 0) {
    lines.push(
      '',
      '## Why This Path Was Chosen',
      ...assessment.rationale.map((note) => `- ${note}`),
    );
  }

  if (planningMetadata.suppliedPlanSummary || planningMetadata.suppliedPlanningArtifactPaths.length > 0) {
    lines.push('', '## Supplied Plan Inputs');
    if (planningMetadata.suppliedPlanSummary) {
      lines.push(`- Summary: ${planningMetadata.suppliedPlanSummary}`);
    }
    if (planningMetadata.suppliedPlanningArtifacts.length > 0) {
      lines.push(`- Detected artifacts: ${planningMetadata.suppliedPlanningArtifacts.join(', ')}`);
    }
    if (planningMetadata.suppliedPlanningArtifactPaths.length > 0) {
      lines.push(`- Detected paths: ${planningMetadata.suppliedPlanningArtifactPaths.join(', ')}`);
    }
  }

  lines.push('', '## Required Artifacts');
  for (const artifact of assessment.artifactBlueprints) {
    lines.push(
      '',
      `### ${artifact.displayName} (${artifact.artifactId})`,
      `- Owner: ${artifact.ownerRole}`,
      `- Standards: ${artifact.governingStandards.join(', ')}`,
      `- Purpose: ${artifact.purpose}`,
      '- Minimum contents:',
      ...artifact.minimumContents.map((item) => `  - ${item}`),
      '- Example outline:',
      ...artifact.exampleOutline.map((item) => `  - ${item}`),
    );
  }

  lines.push(
    '',
    '## Readiness Check',
    '- Do not move to formal execution until the required artifacts are either created, validated, or explicitly waived.',
    '- If setup or auth is required, include a setup-and-config checklist before execution.',
    '- If the work is lightweight, keep the artifact set intentionally small and execution-focused.',
  );

  return lines.join('\n');
}
