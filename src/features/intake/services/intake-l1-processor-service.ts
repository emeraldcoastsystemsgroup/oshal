/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

import type {
  IntakeArtifactBlueprint,
  IntakeEffortTier,
  IntakeOutcomeType,
  IntakePlanningMode,
  IntakeRecommendedPath,
  IntakeSetupLevel,
  IntakeTeamShape,
} from '@/shared/types/intake';

/**
 * @description Raw, mostly-optional signals captured at the intake front door for a
 * single request. These fields are deliberately loose because they come straight from
 * a human or upstream bot before any classification has happened; the L1 processor is
 * responsible for inferring missing values (outcome type, effort tier, etc.) from
 * whatever subset of hints is present so the rest of the pipeline can reason about the
 * work with a normalized shape.
 */
export interface IntakeL1Input {
  goal?: string;
  projectType?: 'poc' | 'internal' | 'production' | 'research' | '';
  outcomeType?: IntakeOutcomeType | '';
  effortTier?: IntakeEffortTier | '';
  repoUrl?: string;
  credentialsNeeded?: boolean;
  credentialNotes?: string;
  apiSpecs?: string;
  businessRequirements?: string;
  knownGaps?: string;
  reviewStages?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * @description The fully-resolved intake decision the L1 processor hands downstream.
 * It exists to collapse fuzzy input into an actionable routing contract: which path to
 * run, how much planning ceremony is warranted, what team shape and setup level to use,
 * and which planning artifacts must be produced. The `rationale` trail is kept so a
 * human can audit why a given path was chosen rather than having to re-derive it.
 */
export interface IntakeL1Assessment {
  outcomeType: IntakeOutcomeType;
  effortTier: IntakeEffortTier;
  recommendedPath: IntakeRecommendedPath;
  planningMode: IntakePlanningMode;
  teamShape: IntakeTeamShape;
  setupLevel: IntakeSetupLevel;
  seriousProject: boolean;
  requiredArtifacts: string[];
  artifactBlueprints: IntakeArtifactBlueprint[];
  rationale: string[];
}

const EMPTY_ARTIFACTS: string[] = [];

/**
 * @description Level-1 (front-door) triage for incoming work. This service is the
 * gatekeeper that decides how much process a request deserves before any execution
 * happens, ranging from answering trivial questions inline up to spinning a full
 * structured project swarm. Centralizing the decision here keeps routing consistent
 * and avoids each agent re-inventing "how serious is this?" heuristics.
 */
export class IntakeL1ProcessorService {
  /**
   * @description Classify a single intake request and return the routing decision plus
   * the planning artifacts it requires. The method escalates through increasingly heavy
   * paths (instant answer, lightweight/PoC, standard execution, structured project) and
   * records human-readable rationale explaining why the chosen path was selected, so the
   * caller never has to guess the reasoning behind the routing.
   * @param input Raw intake signals; any missing classification fields are inferred.
   * @returns The resolved assessment describing the path, planning mode, team shape,
   * setup level, and the required artifact blueprints for the request.
   */
  assess(input: IntakeL1Input): IntakeL1Assessment {
    const outcomeType = this.resolveOutcomeType(input);
    const effortTier = this.resolveEffortTier(input, outcomeType);
    const rationale: string[] = [];

    const hasCredentials = Boolean(input.credentialsNeeded);
    const hasReviews = (input.reviewStages?.length ?? 0) > 0;
    const hasTechnicalRefs = Boolean(input.apiSpecs?.trim());
    const hasBusinessRequirements = Boolean(input.businessRequirements?.trim());
    const hasKnownGaps = Boolean(input.knownGaps?.trim());

    const isImmediateAnswer = outcomeType === 'question-answer'
      && effortTier === 'quick'
      && !hasCredentials
      && !hasReviews;

    if (isImmediateAnswer) {
      rationale.push('Direct question/answer work should be answered immediately without invoking the full project pipeline.');
      const artifactBlueprints = this.buildArtifactBlueprints([
        'answer-in-thread',
      ]);
      return {
        outcomeType,
        effortTier,
        recommendedPath: 'instant-answer',
        planningMode: 'none',
        teamShape: 'single-agent',
        setupLevel: 'none',
        seriousProject: false,
        requiredArtifacts: artifactBlueprints.map((artifact) => artifact.artifactId),
        artifactBlueprints,
        rationale,
      };
    }

    const professionalTriggers: string[] = [];
    if (effortTier === 'professional') professionalTriggers.push('user requested professional effort');
    if (input.projectType === 'production') professionalTriggers.push('production-grade delivery');
    if (outcomeType === 'product-delivery') professionalTriggers.push('product delivery outcome');
    if (outcomeType === 'integration') professionalTriggers.push('integration outcome');
    if (hasCredentials) professionalTriggers.push('credentials/access needed');
    if (hasReviews) professionalTriggers.push('explicit review stages requested');

    if (professionalTriggers.length > 0) {
      rationale.push(`Serious delivery path selected because: ${professionalTriggers.join(', ')}.`);
      if (!hasBusinessRequirements) {
        rationale.push('Business success criteria are still missing and should be clarified during planning.');
      }
      if (!hasTechnicalRefs && outcomeType !== 'product-delivery') {
        rationale.push('Technical references are thin, so planning should establish scope and constraints before execution.');
      }
      const artifactBlueprints = this.buildArtifactBlueprints([
        'OUTCOME-BRIEF.md',
        'BUSINESS-REQUIREMENTS.md',
        'FEATURE-INVENTORY.md',
        'PROCESS-FLOW.md',
        'APPLICATION-ARCHITECTURE.md',
        'TECHNICAL-SPECIFICATION.md',
        'INTEGRATION-ARCHITECTURE.md',
        'FUNCTIONAL-SPECIFICATION.md',
        'INTEGRATION-PLAN.md',
        'PRODUCT-DIAGRAMS.md',
        'RESEARCH-SUMMARY.md',
        'KEY-DECISIONS-LOG.md',
        'STACK-DEFINITION.md',
        'HOSTING-AND-ENVIRONMENT-PLAN.md',
        'COSTING-AND-BUDGET-VIEW.md',
        'EFFORT-ESTIMATE.md',
        'PHASED-DELIVERY-PLAN.md',
        'IMPLEMENTATION-PLAN.md',
        'MASTER-PLAN.md',
        'ESTIMATION.md',
        'STAKEHOLDER-AND-COMMS-PLAN.md',
        'RESOURCE-PLAN.md',
        'TASK-BRIEF.md',
        'RISK-REGISTER.md',
        'ACCEPTANCE-CRITERIA.md',
        'SETUP-AND-CONFIG-CHECKLIST.md',
      ]);
      return {
        outcomeType,
        effortTier,
        recommendedPath: 'structured-project',
        planningMode: 'structured',
        teamShape: 'project-swarm',
        setupLevel: 'professional',
        seriousProject: true,
        requiredArtifacts: artifactBlueprints.map((artifact) => artifact.artifactId),
        artifactBlueprints,
        rationale,
      };
    }

    const pairNeeded = outcomeType === 'proof-of-concept'
      || outcomeType === 'investigation'
      || hasKnownGaps
      || hasTechnicalRefs;

    if (effortTier === 'low-fidelity' || outcomeType === 'proof-of-concept') {
      rationale.push('Low-fidelity/PoC work can bypass heavyweight project planning but still benefits from explicit scope and success criteria.');
      const artifactBlueprints = this.buildArtifactBlueprints([
        'lightweight-scope',
        'success-criteria',
        'lightweight-technical-approach',
        ...(pairNeeded ? ['handover-notes'] : EMPTY_ARTIFACTS),
      ]);
      return {
        outcomeType,
        effortTier,
        recommendedPath: 'direct-execution',
        planningMode: 'lightweight',
        teamShape: pairNeeded ? 'specialist-pair' : 'single-agent',
        setupLevel: hasCredentials ? 'professional' : 'basic',
        seriousProject: false,
        requiredArtifacts: artifactBlueprints.map((artifact) => artifact.artifactId),
        artifactBlueprints,
        rationale,
      };
    }

    rationale.push('This request needs execution structure, but not the full professional product-delivery ceremony.');
    const artifactBlueprints = this.buildArtifactBlueprints([
      'outcome-brief',
      'acceptance-criteria',
      'delivery-checklist',
      ...(pairNeeded ? ['handover-notes'] : EMPTY_ARTIFACTS),
    ]);
    return {
      outcomeType,
      effortTier,
      recommendedPath: 'direct-execution',
      planningMode: 'lightweight',
      teamShape: pairNeeded ? 'specialist-pair' : 'single-agent',
      setupLevel: hasCredentials ? 'professional' : 'basic',
      seriousProject: false,
      requiredArtifacts: artifactBlueprints.map((artifact) => artifact.artifactId),
      artifactBlueprints,
      rationale,
    };
  }

  private buildArtifactBlueprints(artifactIds: string[]): IntakeArtifactBlueprint[] {
    return artifactIds.map((artifactId) => createArtifactBlueprint(artifactId));
  }

  private resolveOutcomeType(input: IntakeL1Input): IntakeOutcomeType {
    if (input.outcomeType) {
      return input.outcomeType;
    }

    switch (input.projectType) {
      case 'poc':
        return 'proof-of-concept';
      case 'production':
        return 'product-delivery';
      case 'research':
        return 'investigation';
      default:
        break;
    }

    const text = [
      input.goal,
      input.businessRequirements,
      input.apiSpecs,
      input.knownGaps,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (/\bhow\b|\bwhat\b|\bwhy\b|\bwhen\b|\bwhere\b|\bcan you explain\b/.test(text)) {
      return 'question-answer';
    }
    if (/\bpoc\b|\bprototype\b|\bmock\b|\bspike\b/.test(text)) {
      return 'proof-of-concept';
    }
    if (/\bintegrat(e|ion)\b|\bsync\b|\bconnector\b|\boauth\b|\bapi\b/.test(text)) {
      return 'integration';
    }
    if (/\binvestigat(e|ion)\b|\broot cause\b|\brca\b|\bdebug\b|\bresearch\b/.test(text)) {
      return 'investigation';
    }
    if (/\bfix\b|\bupdate\b|\bsmall\b|\bminor\b/.test(text)) {
      return 'small-change';
    }
    return 'product-delivery';
  }

  private resolveEffortTier(input: IntakeL1Input, outcomeType: IntakeOutcomeType): IntakeEffortTier {
    if (input.effortTier) {
      return input.effortTier;
    }

    if (input.projectType === 'production') {
      return 'professional';
    }
    if (input.projectType === 'poc') {
      return 'low-fidelity';
    }
    if (outcomeType === 'question-answer') {
      return 'quick';
    }
    if (input.credentialsNeeded || (input.reviewStages?.length ?? 0) > 0) {
      return 'professional';
    }
    if (outcomeType === 'proof-of-concept') {
      return 'low-fidelity';
    }
    if (input.priority === 'critical') {
      return 'professional';
    }
    return 'standard';
  }
}

function createArtifactBlueprint(artifactId: string): IntakeArtifactBlueprint {
  switch (artifactId) {
    case 'answer-in-thread':
      return {
        artifactId,
        displayName: 'Answer In Thread',
        purpose: 'Deliver a direct answer without creating unnecessary planning or project scaffolding.',
        ownerRole: 'front-door-bot',
        governingStandards: ['RALF-light'],
        minimumContents: [
          'Direct answer to the question',
          'Any important caveats or assumptions',
          'Next-step offer only if more work is actually needed',
        ],
        exampleOutline: [
          'Question restated in one line',
          'Direct answer',
          'Short caveat or decision note',
        ],
      };
    case 'OUTCOME-BRIEF.md':
    case 'outcome-brief':
      return {
        artifactId,
        displayName: 'Outcome Brief',
        purpose: 'Anchor the work in the user outcome, success bar, scope boundary, and operational constraints.',
        ownerRole: 'project-shaper',
        governingStandards: ['RALF', 'PMP-lite'],
        minimumContents: [
          'Problem statement and target users',
          'Definition of done and non-goals',
          'Constraints, risks, and dependencies',
        ],
        exampleOutline: [
          'Objective and target user',
          'In scope / out of scope',
          'Success criteria',
        ],
      };
    case 'BUSINESS-REQUIREMENTS.md':
      return {
        artifactId,
        displayName: 'Business Requirements',
        purpose: 'Capture the business objectives, stakeholder needs, success metrics, and operating constraints that justify the project.',
        ownerRole: 'project-shaper',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Business objective and desired outcomes',
          'Primary stakeholders, users, and business constraints',
          'Success metrics, assumptions, and non-goals',
        ],
        exampleOutline: [
          'Business objective and problem statement',
          'Stakeholders and success measures',
          'Assumptions, constraints, and exclusions',
        ],
      };
    case 'FEATURE-INVENTORY.md':
      return {
        artifactId,
        displayName: 'Feature Inventory',
        purpose: 'Translate business intent into the concrete features, capabilities, and user-visible slices the build must deliver.',
        ownerRole: 'delivery-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Feature list grouped by capability area',
          'Priority or release grouping for each feature',
          'Notes on dependencies, exclusions, and deferred work',
        ],
        exampleOutline: [
          'Capability group',
          'Feature list with priority',
          'Deferred or out-of-scope features',
        ],
      };
    case 'PROCESS-FLOW.md':
      return {
        artifactId,
        displayName: 'Process Flow',
        purpose: 'Document the current and target business process so architecture and planning are anchored to real operational flow.',
        ownerRole: 'architect-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'AS-IS and TO-BE process description',
          'Actors, decision gates, integrations, and data movement',
          'At least one process flow diagram',
        ],
        exampleOutline: [
          'Current state process',
          'Future state process',
          'Decision gates, integrations, and open questions',
        ],
      };
    case 'APPLICATION-ARCHITECTURE.md':
      return {
        artifactId,
        displayName: 'Application Architecture',
        purpose: 'Describe the application-facing architecture across services, modules, boundaries, and runtime responsibilities.',
        ownerRole: 'architect-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'Application components and responsibilities',
          'Interface boundaries and interactions',
          'Application-level diagrams and dependency notes',
        ],
        exampleOutline: [
          'Application context and components',
          'Interfaces and interaction flows',
          'Operational concerns and constraints',
        ],
      };
    case 'TECHNICAL-SPECIFICATION.md':
      return {
        artifactId,
        displayName: 'Technical Specification',
        purpose: 'Turn the architecture into implementation-ready technical detail for the execution team.',
        ownerRole: 'system-architect',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'Technical objectives and affected layers',
          'External dependencies, contracts, and implementation boundaries',
          'Implementation plan and risk register',
        ],
        exampleOutline: [
          'Objective and architecture decision',
          'External dependencies and data contracts',
          'Implementation steps and risks',
        ],
      };
    case 'INTEGRATION-ARCHITECTURE.md':
      return {
        artifactId,
        displayName: 'Integration Architecture',
        purpose: 'Make external system interactions, auth boundaries, data flow, and failure handling explicit.',
        ownerRole: 'integration-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'Systems and endpoints involved',
          'Auth, secrets, trust boundaries, and rate limits',
          'Sequence/data flow diagrams and error handling model',
        ],
        exampleOutline: [
          'External systems matrix',
          'Sequence and data flow diagrams',
          'Auth, retries, and failure paths',
        ],
      };
    case 'technical-architecture':
      return {
        artifactId,
        displayName: 'Technical Architecture',
        purpose: 'Define the system shape before implementation starts.',
        ownerRole: 'architect-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'Core components and boundaries',
          'Data flow, external integrations, and trust boundaries',
          'Key technical risks and implementation constraints',
        ],
        exampleOutline: [
          'System context',
          'Component inventory',
          'Integration boundaries and failure modes',
        ],
      };
    case 'FUNCTIONAL-SPECIFICATION.md':
    case 'functional-specification':
      return {
        artifactId,
        displayName: 'Functional Specification',
        purpose: 'Make behavior explicit so delivery is not guessed from a loose ticket title.',
        ownerRole: 'delivery-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Primary user stories or workflows',
          'Functional requirements and exclusions',
          'Acceptance conditions for the delivered behavior',
        ],
        exampleOutline: [
          'Primary workflows',
          'Requirements list',
          'Out of scope and assumptions',
        ],
      };
    case 'INTEGRATION-PLAN.md':
    case 'integration-plan':
      return {
        artifactId,
        displayName: 'Integration Plan',
        purpose: 'Clarify how the project touches outside systems, credentials, and runtime dependencies.',
        ownerRole: 'integration-bot',
        governingStandards: ['PMP', 'TOGAF', 'RALF'],
        minimumContents: [
          'Systems touched and why',
          'Auth model, secrets, and setup dependencies',
          'Error handling, rate limits, and fallback behavior',
        ],
        exampleOutline: [
          'External systems matrix',
          'Auth and setup requirements',
          'Failure and retry strategy',
        ],
      };
    case 'PRODUCT-DIAGRAMS.md':
    case 'product-diagrams':
      return {
        artifactId,
        displayName: 'Product Diagrams',
        purpose: 'Give operators and builders a visual understanding of the intended system and flow.',
        ownerRole: 'architect-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'At least one system or process diagram',
          'Named actors/services and their interactions',
          'Legend or notes for non-obvious flows',
        ],
        exampleOutline: [
          'System context diagram',
          'Sequence or process flow',
          'Notes on assumptions',
        ],
      };
    case 'RESEARCH-SUMMARY.md':
    case 'research-summary':
      return {
        artifactId,
        displayName: 'Research Summary',
        purpose: 'Capture the external facts, references, and options that informed the design.',
        ownerRole: 'research-bot',
        governingStandards: ['TOGAF', 'PMP', 'RALF'],
        minimumContents: [
          'Sources reviewed',
          'Relevant findings and tradeoffs',
          'Open questions that still need validation',
        ],
        exampleOutline: [
          'Sources and dates',
          'What was learned',
          'Implications for the build',
        ],
      };
    case 'KEY-DECISIONS-LOG.md':
    case 'key-decisions-log':
      return {
        artifactId,
        displayName: 'Key Decisions Log',
        purpose: 'Record the major choices so later rounds do not silently undo them.',
        ownerRole: 'architect-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'Decision statement',
          'Why that option was selected',
          'Rejected alternatives or tradeoffs',
        ],
        exampleOutline: [
          'Decision',
          'Rationale',
          'Consequences',
        ],
      };
    case 'STACK-DEFINITION.md':
    case 'stack-definition':
      return {
        artifactId,
        displayName: 'Stack Definition',
        purpose: 'Lock in the implementation stack, frameworks, and major service choices.',
        ownerRole: 'architect-bot',
        governingStandards: ['TOGAF', 'RALF'],
        minimumContents: [
          'Languages, frameworks, and runtime platforms',
          'Reasoning for major technology picks',
          'Compatibility or team constraints',
        ],
        exampleOutline: [
          'Frontend / backend / infra stack',
          'Why this stack fits',
          'Known compatibility constraints',
        ],
      };
    case 'HOSTING-AND-ENVIRONMENT-PLAN.md':
    case 'hosting-and-environment-plan':
      return {
        artifactId,
        displayName: 'Hosting And Environment Plan',
        purpose: 'Make deployment shape, environments, and operational dependencies explicit.',
        ownerRole: 'project-setup-bot',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Environment list and purpose',
          'Hosting targets and runtime dependencies',
          'Secrets, config, and deployment gating requirements',
        ],
        exampleOutline: [
          'Local / staging / production plan',
          'Hosting target and access model',
          'Deployment prerequisites',
        ],
      };
    case 'COSTING-AND-BUDGET-VIEW.md':
    case 'costing-and-budget-view':
      return {
        artifactId,
        displayName: 'Costing And Budget View',
        purpose: 'Set expectations for spend, usage, and cost-sensitive design choices.',
        ownerRole: 'delivery-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Primary cost drivers',
          'Expected baseline and risk areas',
          'Any budget guardrails or approval needs',
        ],
        exampleOutline: [
          'Infrastructure and API cost drivers',
          'Expected monthly or delivery cost bands',
          'Cost risks and mitigations',
        ],
      };
    case 'EFFORT-ESTIMATE.md':
    case 'effort-estimate':
      return {
        artifactId,
        displayName: 'Effort Estimate',
        purpose: 'Provide a defendable estimate before execution is broken into work units.',
        ownerRole: 'delivery-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Estimate by phase or work package',
          'Dependencies or uncertainty notes',
          'Critical path assumptions',
        ],
        exampleOutline: [
          'Phase estimates',
          'Confidence level',
          'Critical path and blockers',
        ],
      };
    case 'PHASED-DELIVERY-PLAN.md':
    case 'phased-delivery-plan':
      return {
        artifactId,
        displayName: 'Phased Delivery Plan',
        purpose: 'Sequence the work into understandable delivery chunks.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Delivery phases or milestones',
          'Dependencies between phases',
          'Exit criteria for each phase',
        ],
        exampleOutline: [
          'Phase 1 foundation',
          'Phase 2 implementation',
          'Phase 3 validation and rollout',
        ],
      };
    case 'MASTER-PLAN.md':
      return {
        artifactId,
        displayName: 'Master Plan',
        purpose: 'Act as the authoritative delivery plan tying architecture, phases, ownership, and dependencies together.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Scope boundary and assumptions',
          'Work breakdown with sequencing',
          'Dependencies, risks, and acceptance criteria',
        ],
        exampleOutline: [
          'Scope boundary',
          'Work breakdown structure',
          'Dependency graph and risk register',
        ],
      };
    case 'IMPLEMENTATION-PLAN.md':
      return {
        artifactId,
        displayName: 'Implementation Plan',
        purpose: 'Provide the detailed build sequence that the planning orchestrator and execution team can decompose into work units.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Build phases and ordered implementation steps',
          'Subtask decomposition with ownership hints',
          'Dependencies, sequencing, and rollout considerations',
        ],
        exampleOutline: [
          'Implementation phases',
          'Subtask decomposition',
          'Sequencing and rollout notes',
        ],
      };
    case 'ESTIMATION.md':
      return {
        artifactId,
        displayName: 'Estimation Pack',
        purpose: 'Capture cost, schedule, confidence, and major estimate assumptions in one place.',
        ownerRole: 'delivery-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Effort, schedule, and cost estimate summary',
          'Confidence level and estimating assumptions',
          'Estimate risks and triggers for re-estimation',
        ],
        exampleOutline: [
          'Estimate summary',
          'Confidence and assumptions',
          'Re-estimation triggers',
        ],
      };
    case 'STAKEHOLDER-AND-COMMS-PLAN.md':
      return {
        artifactId,
        displayName: 'Stakeholder And Communications Plan',
        purpose: 'Define who needs updates, decisions, approvals, and when those communication points happen.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Stakeholder list and responsibilities',
          'Communication cadence, audiences, and required checkpoints',
          'Approval or escalation paths',
        ],
        exampleOutline: [
          'Stakeholders and roles',
          'Communication rhythm and checkpoints',
          'Approvals and escalation flow',
        ],
      };
    case 'RESOURCE-PLAN.md':
      return {
        artifactId,
        displayName: 'Resource And Staffing Plan',
        purpose: 'Spell out the roles, specialist coverage, and staffing assumptions needed to deliver the project.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Roles or agents needed by phase',
          'Capacity or concurrency assumptions',
          'Critical role gaps and staffing risks',
        ],
        exampleOutline: [
          'Roles by phase',
          'Capacity assumptions',
          'Gaps and resourcing risks',
        ],
      };
    case 'TASK-BRIEF.md':
    case 'task-brief':
      return {
        artifactId,
        displayName: 'Task Brief',
        purpose: 'Give downstream execution agents a concise, shared starting point.',
        ownerRole: 'project-manager',
        governingStandards: ['RALF'],
        minimumContents: [
          'Objective and current status',
          'Assigned work and acceptance bar',
          'Critical context and handoff expectations',
        ],
        exampleOutline: [
          'What to build',
          'Constraints and acceptance criteria',
          'Expected outputs and handoff notes',
        ],
      };
    case 'RISK-REGISTER.md':
    case 'risk-register':
      return {
        artifactId,
        displayName: 'Risk Register',
        purpose: 'Track delivery, technical, and dependency risks before build starts.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Named risk with likelihood and impact',
          'Mitigation or contingency',
          'Owner for follow-up',
        ],
        exampleOutline: [
          'Technical risks',
          'Delivery risks',
          'Mitigations and owners',
        ],
      };
    case 'ACCEPTANCE-CRITERIA.md':
    case 'acceptance-criteria':
      return {
        artifactId,
        displayName: 'Acceptance Criteria',
        purpose: 'Define what must be true for the project or phase to be considered complete.',
        ownerRole: 'project-manager',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Observable completion conditions',
          'Validation or test expectations',
          'Any operator signoff requirements',
        ],
        exampleOutline: [
          'Functional acceptance points',
          'Validation steps',
          'Release or handoff signoff conditions',
        ],
      };
    case 'SETUP-AND-CONFIG-CHECKLIST.md':
    case 'setup-and-config-checklist':
      return {
        artifactId,
        displayName: 'Setup And Config Checklist',
        purpose: 'Prevent build rounds from stalling on missing setup, auth, or environment prep.',
        ownerRole: 'project-setup-bot',
        governingStandards: ['PMP', 'RALF'],
        minimumContents: [
          'Repos, environments, and services to prepare',
          'Secrets and config fields needed',
          'Smoke tests proving setup is ready',
        ],
        exampleOutline: [
          'Accounts, repos, and access',
          'Env vars and secrets',
          'Smoke checks before execution',
        ],
      };
    case 'lightweight-scope':
      return {
        artifactId,
        displayName: 'Lightweight Scope',
        purpose: 'Bound a small build so it stays intentionally lightweight.',
        ownerRole: 'front-door-bot',
        governingStandards: ['RALF-light'],
        minimumContents: [
          'What is being changed',
          'What is explicitly not included',
          'Any constraints that still matter',
        ],
        exampleOutline: [
          'Requested change',
          'Out of scope',
          'Success check',
        ],
      };
    case 'success-criteria':
      return {
        artifactId,
        displayName: 'Success Criteria',
        purpose: 'Keep a lightweight execution path outcome-focused.',
        ownerRole: 'front-door-bot',
        governingStandards: ['RALF-light'],
        minimumContents: [
          'What must be demonstrably true after the work',
          'How success will be validated',
          'Any acceptable shortcuts for PoC work',
        ],
        exampleOutline: [
          'Success statement',
          'Validation step',
          'Known limitations accepted',
        ],
      };
    case 'lightweight-technical-approach':
      return {
        artifactId,
        displayName: 'Lightweight Technical Approach',
        purpose: 'Give enough implementation direction without creating a full project plan.',
        ownerRole: 'specialist-bot',
        governingStandards: ['RALF'],
        minimumContents: [
          'One-page implementation approach',
          'Key files or systems touched',
          'Main risk or caveat',
        ],
        exampleOutline: [
          'Approach summary',
          'Files and systems touched',
          'Validation note',
        ],
      };
    case 'handover-notes':
      return {
        artifactId,
        displayName: 'Handover Notes',
        purpose: 'Preserve continuity when more than one lightweight agent participates.',
        ownerRole: 'specialist-bot',
        governingStandards: ['RALF'],
        minimumContents: [
          'What was done',
          'What remains',
          'Any assumptions or known issues',
        ],
        exampleOutline: [
          'Completed work',
          'Open items',
          'Watch-outs for the next agent',
        ],
      };
    case 'delivery-checklist':
      return {
        artifactId,
        displayName: 'Delivery Checklist',
        purpose: 'Keep a standard execution request from drifting past its intended finish line.',
        ownerRole: 'front-door-bot',
        governingStandards: ['RALF'],
        minimumContents: [
          'Major steps to complete',
          'Validation checks',
          'Release or handoff condition',
        ],
        exampleOutline: [
          'Build step',
          'Verify step',
          'Hand off step',
        ],
      };
    default:
      return {
        artifactId,
        displayName: artifactId,
        purpose: 'Required project artifact.',
        ownerRole: 'project-manager',
        governingStandards: ['RALF'],
        minimumContents: ['Document the artifact clearly enough for downstream execution.'],
        exampleOutline: ['Purpose', 'Key contents', 'Next-step implications'],
      };
  }
}
