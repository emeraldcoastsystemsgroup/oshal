/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial RCA domain types for rca-specialist bot
 */

/**
 * @description Available RCA analysis methods.
 * Each method maps to a different root-cause investigation technique.
 */
export type RcaMethod = 'five-whys' | 'fishbone' | 'fault-tree';

/**
 * @description Incident severity levels following CNCF CloudEvents convention.
 */
export type RcaSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * @description Request payload for submitting an incident to RCA analysis.
 */
export interface RcaAnalysisRequest {
  /** Unique incident identifier */
  incidentId: string;
  /** Human-readable description of the incident */
  description: string;
  /** Analysis method to apply */
  method: RcaMethod;
  /** Optional additional context payload */
  payload?: Record<string, unknown>;
  /** Optional incident severity */
  severity?: RcaSeverity;
}

/**
 * @description A single root cause identified during analysis.
 */
export interface RootCause {
  /** Description of the identified root cause */
  description: string;
  /** Category classification (e.g., 'process', 'technology', 'human') */
  category: string;
  /** Likelihood score between 0 and 1 */
  likelihood: number;
  /** Supporting evidence strings */
  evidence: string[];
}

/**
 * @description A corrective or preventive action recommendation.
 */
export interface Recommendation {
  /** Specific action to take */
  action: string;
  /** Priority level for the action */
  priority: 'low' | 'medium' | 'high';
  /** Estimated effort to implement (e.g., '2-4 hours') */
  estimatedEffort: string;
  /** Expected impact of implementing the action */
  expectedImpact: string;
}

/**
 * @description Result of an RCA analysis execution.
 */
export interface RcaAnalysisResult {
  /** Incident identifier matching the request */
  incidentId: string;
  /** Method used for analysis */
  method: RcaMethod;
  /** Identified root causes */
  rootCauses: RootCause[];
  /** Corrective and preventive recommendations */
  recommendations: Recommendation[];
  /** ISO 8601 timestamp of analysis completion */
  timestamp: string;
  /** Confidence score between 0 and 1 */
  confidence: number;
}