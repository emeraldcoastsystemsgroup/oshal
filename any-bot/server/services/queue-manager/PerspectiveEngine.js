/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PerspectiveEngine - Multi-perspective analysis framework for ticket processing
 * 
 * Every ticket is analyzed through 11 professional perspectives organized in 4 tiers.
 * This is a VIRTUAL perspective system — one LLM call with structured analysis instructions,
 * NOT separate containers or calls per perspective.
 * 
 * Replaces the old single-perspective AgentPerspectives.js model.
 */

const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ═══════════════════════════════════════════════════════════════
// PERSPECTIVE DEFINITIONS (11 core perspectives in 4 tiers)
// ═══════════════════════════════════════════════════════════════

/**
 * @description Canonical registry of the 11 built-in professional perspectives, keyed by
 * perspective id and grouped across 4 tiers. Centralizing them here lets every ticket be
 * examined from a consistent, comprehensive set of viewpoints and gives callers a single
 * source of truth for perspective metadata (name, tier, key question, analysis prompt, and
 * the capabilities each perspective is meant to cover). Exported so other modules can read
 * perspective definitions without hard-coding them.
 */
const PERSPECTIVES = {
  // ─── TIER 1: ANALYSIS (Technical deep-dive) ───
  'developer-sme': {
    id: 'developer-sme',
    name: 'Developer SME',
    tier: 'analysis',
    emoji: '👨‍💻',
    keyQuestion: 'How do I implement this?',
    prompt: `**Developer SME Perspective:**
Analyze this as a senior software engineer. Consider:
- Implementation approach and code patterns
- Technology choices and framework fit
- Effort estimate (hours/days/sprints)
- Technical debt implications
- Existing codebase patterns to follow or refactor
- Dependencies and prerequisites
- Risks: What could go wrong technically?`,
    capabilities: ['code', 'implementation', 'development', 'programming', 'bug-fix']
  },

  'architecture': {
    id: 'architecture',
    name: 'Architecture',
    tier: 'analysis',
    emoji: '🏗️',
    keyQuestion: 'How does this fit the system?',
    prompt: `**Architecture Perspective:**
Analyze this as a system architect. Consider:
- System-level impact (which components are affected?)
- Scalability implications
- Design patterns applicable (microservices, event-driven, etc.)
- Data flow changes
- Integration points with existing services
- Non-functional requirements (performance, reliability, availability)
- Architecture Decision Record: What trade-offs are we making?`,
    capabilities: ['architecture', 'design', 'system-design', 'scalability']
  },

  'qa-testing': {
    id: 'qa-testing',
    name: 'QA / Testing',
    tier: 'analysis',
    emoji: '🧪',
    keyQuestion: 'How can this fail?',
    prompt: `**QA / Testing Perspective:**
Analyze this as a QA engineer. Consider:
- Acceptance criteria (what must be true for this to be "done"?)
- Test cases: positive, negative, boundary, edge cases
- Regression risk: what existing features could break?
- Test automation approach
- Performance testing needs
- Data validation requirements
- Environments needed for testing`,
    capabilities: ['testing', 'qa', 'quality-assurance', 'test-automation']
  },

  'security': {
    id: 'security',
    name: 'Security',
    tier: 'analysis',
    emoji: '🔒',
    keyQuestion: 'What could go wrong from a security standpoint?',
    prompt: `**Security Perspective:**
Analyze this as a security engineer. Consider:
- Authentication / authorization implications
- Data exposure risks (PII, secrets, credentials)
- Input validation and injection risks
- Principle of least privilege
- Audit logging requirements
- Compliance considerations (if applicable)
- Threat vectors introduced by this change`,
    capabilities: ['security', 'compliance', 'threat-modeling', 'auth']
  },

  // ─── TIER 2: MANAGEMENT (Planning & coordination) ───
  'project-management': {
    id: 'project-management',
    name: 'Project Management',
    tier: 'management',
    emoji: '📊',
    keyQuestion: 'What is the timeline, impact, and who needs to know?',
    prompt: `**Project Management Perspective:**
Analyze this as a project manager. Consider:
- Timeline estimate (start, milestones, delivery)
- Dependencies on other teams or systems
- Stakeholder communication needs
- Risk register: probability × impact
- Resource requirements
- Go/No-Go criteria
- Rollback plan if things go wrong`,
    capabilities: ['planning', 'coordination', 'stakeholder', 'timeline']
  },

  'task-management': {
    id: 'task-management',
    name: 'Task Management',
    tier: 'management',
    emoji: '📋',
    keyQuestion: 'How do I break this down into actionable work?',
    prompt: `**Task Management Perspective:**
Analyze this as a task manager. Consider:
- Sub-task breakdown (numbered, actionable items)
- Task sequencing and dependencies between sub-tasks
- Parallel vs sequential work streams
- Definition of Done for each sub-task
- Assignability: can each sub-task stand alone?
- Estimated effort per sub-task
- Priority ordering of sub-tasks`,
    capabilities: ['task-breakdown', 'sequencing', 'work-management']
  },

  'scrum-agile': {
    id: 'scrum-agile',
    name: 'Scrum / Agile',
    tier: 'management',
    emoji: '🔄',
    keyQuestion: 'How does this fit the sprint and agile methodology?',
    prompt: `**Scrum / Agile Perspective:**
Analyze this as a scrum master. Consider:
- Story points estimate (Fibonacci: 1, 2, 3, 5, 8, 13, 21)
- Sprint fit: can this be completed in one sprint?
- Acceptance criteria in Given/When/Then format
- User story format: "As a [user], I want [feature], so that [benefit]"
- Epic vs Story vs Task classification
- Sprint capacity impact
- Impediments and blockers to flag`,
    capabilities: ['agile', 'scrum', 'sprint', 'story-points']
  },

  // ─── TIER 3: QUALITY (Documentation, business, UX) ───
  'technical-writing': {
    id: 'technical-writing',
    name: 'Technical Writing',
    tier: 'quality',
    emoji: '📝',
    keyQuestion: 'Is this clear, documented, and understandable?',
    prompt: `**Technical Writing Perspective:**
Analyze this as a technical writer. Consider:
- Documentation needed (API docs, user guides, runbooks?)
- Clarity of requirements (are they unambiguous?)
- User-facing text quality (error messages, UI labels)
- README / changelog updates needed
- Knowledge transfer requirements
- Diagrams or visuals that would help explain this
- Audience: who needs to understand this?`,
    capabilities: ['documentation', 'writing', 'clarity', 'communication']
  },

  'functional-sme': {
    id: 'functional-sme',
    name: 'Functional SME',
    tier: 'quality',
    emoji: '🎯',
    keyQuestion: 'Does this actually solve the user\'s problem?',
    prompt: `**Functional SME Perspective:**
Analyze this from a domain/functional expert viewpoint. Consider:
- Does this address the root cause or just symptoms?
- User workflow: how does this change the user's experience?
- Feature completeness: are there missing pieces?
- Edge cases in business logic
- Backward compatibility with existing workflows
- User acceptance: will users find this intuitive?
- Alternative approaches the user might not have considered`,
    capabilities: ['functional', 'domain-expert', 'user-experience', 'business-logic']
  },

  'business-sme': {
    id: 'business-sme',
    name: 'Business SME',
    tier: 'quality',
    emoji: '💼',
    keyQuestion: 'Is this worth doing? What is the business value?',
    prompt: `**Business SME Perspective:**
Analyze this from a business strategy viewpoint. Consider:
- Return on investment (effort vs value)
- Strategic alignment (does this serve team/org goals?)
- Opportunity cost (what are we NOT doing by doing this?)
- Market impact or competitive advantage
- Revenue / cost implications
- Customer satisfaction impact
- Build vs buy vs defer decision`,
    capabilities: ['business', 'strategy', 'roi', 'market']
  },

  // ─── TIER 4: CHALLENGE (Devil's advocate) ───
  'executive-challenge': {
    id: 'executive-challenge',
    name: 'Executive / Devil\'s Advocate',
    tier: 'challenge',
    emoji: '⚡',
    keyQuestion: 'Prove it. Challenge every assumption.',
    prompt: `**Executive / Devil's Advocate Perspective:**
Now challenge EVERYTHING from the previous 10 perspectives. You are the skeptic:
- What assumptions are the other perspectives making?
- Where is the evidence weak or missing?
- What's the worst case scenario?
- Is there a simpler way to achieve the same result?
- Are we over-engineering this?
- What would a competitor or critic say about this approach?
- What's the "do nothing" option and is it actually acceptable?
- Pick the TOP 3 concerns across all perspectives and demand answers.`,
    capabilities: ['challenge', 'critical-thinking', 'executive', 'oversight']
  }
};

// Tier groupings
/**
 * @description Tier-level groupings that organize the individual perspectives into four
 * logical bands (analysis, management, quality, challenge). Defining tiers separately lets
 * the prompt builder render perspectives section-by-section, apply per-tier weighting, and
 * let projects emphasize or de-emphasize whole categories of analysis. Exported so callers
 * can reason about tier membership and default weights without duplicating the grouping.
 */
const TIERS = {
  analysis: {
    name: 'Technical Analysis',
    perspectives: ['developer-sme', 'architecture', 'qa-testing', 'security'],
    defaultWeight: 1.0
  },
  management: {
    name: 'Management & Planning',
    perspectives: ['project-management', 'task-management', 'scrum-agile'],
    defaultWeight: 1.0
  },
  quality: {
    name: 'Quality & Business',
    perspectives: ['technical-writing', 'functional-sme', 'business-sme'],
    defaultWeight: 1.0
  },
  challenge: {
    name: 'Executive Challenge',
    perspectives: ['executive-challenge'],
    defaultWeight: 1.0
  }
};

// Depth templates
const DEPTH_INSTRUCTIONS = {
  brief: 'Provide 1-2 sentences for each perspective. Focus on the single most important insight.',
  standard: 'Provide a short paragraph (3-5 sentences) for each perspective. Cover key points.',
  detailed: 'Provide thorough analysis for each perspective. Include evidence, examples, and specific recommendations.'
};

/**
 * @description Default-exported engine that turns a ticket plus optional project config into
 * a single, structured multi-perspective analysis prompt. It owns the active perspective and
 * tier sets, resolves project-specific overrides (disabled/custom perspectives, tier weights,
 * context) loaded from YAML, chooses analysis depth from ticket complexity, and exposes
 * lookup/listing helpers. The goal is one well-shaped LLM request that covers every angle,
 * rather than many per-perspective calls.
 */
class PerspectiveEngine {
  /**
   * @description Initialize an engine instance with its own working copies of the built-in
   * perspective and tier definitions (so per-instance mutation cannot corrupt the shared
   * module-level registries) and an empty per-instance cache for loaded project configs.
   */
  constructor() {
    this.perspectives = { ...PERSPECTIVES };
    this.tiers = { ...TIERS };
    this.projectConfigCache = new Map();
  }

  /**
   * Build the multi-perspective analysis prompt for a ticket
   * This is the main entry point — produces the full framework prompt
   * 
   * @param {Object} ticket - Plane ticket object
   * @param {Object} projectConfig - Project configuration (from YAML)
   * @param {string} depth - 'brief' | 'standard' | 'detailed'
   * @returns {string} Complete multi-perspective prompt section
   */
  buildMultiPerspectivePrompt(ticket, projectConfig = {}, depth = 'standard') {
    const activePerspectives = this.getActivePerspectives(projectConfig);
    const depthInstruction = DEPTH_INSTRUCTIONS[depth] || DEPTH_INSTRUCTIONS.standard;
    const tierWeights = (projectConfig.perspectives && projectConfig.perspectives.tier_weights) || {};

    let prompt = `
═══════════════════════════════════════════════════════════════
MULTI-PERSPECTIVE ANALYSIS FRAMEWORK
═══════════════════════════════════════════════════════════════

You MUST analyze this ticket from ${activePerspectives.length} professional perspectives before providing your response. This ensures comprehensive, high-quality analysis that considers all angles.

**Analysis Depth:** ${depth.toUpperCase()} — ${depthInstruction}

**Required Output Format:**
For each perspective, provide your analysis under its heading. After all perspectives, provide a SYNTHESIS section.

`;

    // Build each tier's perspectives
    for (const [tierKey, tierConfig] of Object.entries(this.tiers)) {
      const tierPerspectives = tierConfig.perspectives.filter(id => 
        activePerspectives.some(p => p.id === id)
      );

      if (tierPerspectives.length === 0) continue;

      const weight = tierWeights[tierKey] || tierConfig.defaultWeight;
      const weightNote = weight < 1.0 ? ' (lighter analysis for this project)' : '';

      prompt += `\n### ${tierConfig.name}${weightNote}\n\n`;

      for (const perspId of tierPerspectives) {
        const persp = this.perspectives[perspId];
        if (!persp) continue;

        prompt += `#### ${persp.emoji} ${persp.name}\n`;
        prompt += `**Key Question:** "${persp.keyQuestion}"\n`;
        prompt += `${persp.prompt}\n\n`;
      }
    }

    // Add synthesis section
    prompt += `
### 📊 SYNTHESIS (Required — This Is Your Final Answer)

After completing all ${activePerspectives.length} perspective analyses above, synthesize into:

1. **Recommendation:** Your unified recommendation (1-3 sentences)
2. **Action Items:** Numbered list of concrete next steps
3. **Top Risks:** The 3 biggest risks identified across all perspectives
4. **Effort Estimate:** Overall effort (story points + time estimate)
5. **Decision Needed:** Any decisions that require human input before proceeding

**IMPORTANT:** The synthesis is what the user primarily reads. Make it clear, actionable, and evidence-based. Reference specific perspective findings.

═══════════════════════════════════════════════════════════════
`;

    // Add custom perspectives from project config
    if (projectConfig.perspectives && projectConfig.perspectives.custom_perspectives) {
      prompt += this._buildCustomPerspectives(projectConfig.perspectives.custom_perspectives);
    }

    // Add project context if available
    if (projectConfig.context) {
      prompt += `
═══════════════════════════════════════════════════════════════
PROJECT CONTEXT
═══════════════════════════════════════════════════════════════

${projectConfig.context}

${projectConfig.additional_instructions || ''}
═══════════════════════════════════════════════════════════════
`;
    }

    return prompt;
  }

  /**
   * Get active perspectives based on project config
   * @param {Object} projectConfig - Project configuration
   * @returns {Array} Active perspective objects
   */
  getActivePerspectives(projectConfig = {}) {
    const disabled = (projectConfig.perspectives && projectConfig.perspectives.disabled_perspectives) || [];
    
    return Object.values(this.perspectives).filter(p => !disabled.includes(p.id));
  }

  /**
   * Build custom perspective prompts from project config
   * @private
   */
  _buildCustomPerspectives(customPerspectives) {
    if (!customPerspectives || customPerspectives.length === 0) return '';

    let prompt = '\n### 🔧 Project-Specific Perspectives\n\n';

    for (const custom of customPerspectives) {
      prompt += `#### 🔧 ${custom.id}\n`;
      prompt += `**Key Question:** "${custom.question}"\n`;
      prompt += `**Focus:** ${custom.focus}\n\n`;
    }

    return prompt;
  }

  /**
   * Determine analysis depth based on ticket complexity
   * @param {string} complexity - From CapabilityMatcher: 'low' | 'medium' | 'high'
   * @returns {string} 'brief' | 'standard' | 'detailed'
   */
  getDepthForComplexity(complexity) {
    switch (complexity) {
      case 'low': return 'brief';
      case 'medium': return 'standard';
      case 'high': return 'detailed';
      default: return 'standard';
    }
  }

  /**
   * Load project configuration from YAML file
   * @param {string} projectSlug - Project identifier
   * @returns {Object} Project configuration
   */
  loadProjectConfig(projectSlug) {
    // Check cache first
    if (this.projectConfigCache.has(projectSlug)) {
      return this.projectConfigCache.get(projectSlug);
    }

    // Look in container-mounted path first, then relative dev path
    const configDir = process.env.PROJECT_CONFIGS_PATH || '/app/project-configs';
    const devConfigDir = path.join(__dirname, '../../../../ai-lab/project-configs');
    
    const configPaths = [
      path.join(configDir, `${projectSlug}.yaml`),
      path.join(configDir, `${projectSlug}.yml`),
      path.join(devConfigDir, `${projectSlug}.yaml`),
      path.join(devConfigDir, `${projectSlug}.yml`),
      path.join(configDir, 'default.yaml'),
      path.join(devConfigDir, 'default.yaml')
    ];

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          const config = yaml.load(content);
          this.projectConfigCache.set(projectSlug, config);
          logger.info(`Loaded project config: ${configPath}`);
          return config;
        }
      } catch (error) {
        logger.warn(`Failed to load project config ${configPath}: ${error.message}`);
      }
    }

    // Fallback: empty config
    const fallback = { project_name: projectSlug, context: '' };
    this.projectConfigCache.set(projectSlug, fallback);
    return fallback;
  }

  /**
   * Get a single perspective by ID (backward compatibility with AgentPerspectives)
   * @param {string} perspectiveId
   * @returns {Object|null}
   */
  getPerspectiveById(perspectiveId) {
    return this.perspectives[perspectiveId] || null;
  }

  /**
   * List all perspectives with their capabilities
   * @returns {Array}
   */
  listPerspectives() {
    return Object.values(this.perspectives).map(p => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      keyQuestion: p.keyQuestion,
      capabilities: p.capabilities
    }));
  }

  /**
   * Get perspective count
   * @returns {number}
   */
  getPerspectiveCount() {
    return Object.keys(this.perspectives).length;
  }

  /**
   * Get all capabilities across all perspectives (flattened, unique)
   * @returns {Array<string>}
   */
  getAllCapabilities() {
    const caps = new Set();
    for (const p of Object.values(this.perspectives)) {
      for (const c of p.capabilities) {
        caps.add(c);
      }
    }
    return Array.from(caps);
  }

  /**
   * Clear the project config cache
   */
  clearCache() {
    this.projectConfigCache.clear();
  }
}

module.exports = PerspectiveEngine;
module.exports.PERSPECTIVES = PERSPECTIVES;
module.exports.TIERS = TIERS;