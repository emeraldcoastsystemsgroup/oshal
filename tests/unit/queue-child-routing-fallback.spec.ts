import { describe, expect, it } from 'vitest';
import {
  inferPlanningUnitSuggestedRole,
  normalizePlanningRole,
} from '../../src/features/swarm-orchestration/services/queue-manager-service';

describe('queue child routing fallback', () => {
  it('uses explicit suggested agent role hidden in acceptance criteria', () => {
    const role = inferPlanningUnitSuggestedRole({
      title: 'Implement validate_us_phone Function with Corrected Regex',
      workType: 'testing',
      labels: ['implementation'],
      acceptanceCriteria: [
        '*Suggested agent role:** code-developer',
        'Function handles E.164 and common US phone formats',
      ],
    });

    expect(role).toBe('code-developer');
  });

  it('infers a test engineer for test-focused planning units', () => {
    const role = inferPlanningUnitSuggestedRole({
      title: 'Write Pytest-Compatible Test Suite',
      workType: 'testing',
      labels: ['tests'],
      acceptanceCriteria: ['Regression tests cover valid and invalid phone numbers'],
    });

    expect(role).toBe('test-engineer');
  });

  it('normalizes PM role aliases to canonical local bot names', () => {
    expect(normalizePlanningRole('qa-engineer')).toBe('test-engineer');
    expect(normalizePlanningRole('Technical Writer')).toBe('documentation-writer');
    expect(normalizePlanningRole('SRE')).toBe('devops-bot');
  });

  it('normalizes explicit suggested role aliases from acceptance criteria', () => {
    const role = inferPlanningUnitSuggestedRole({
      title: 'Write regression coverage',
      acceptanceCriteria: ['**Suggested agent role:** qa-engineer'],
    });

    expect(role).toBe('test-engineer');
  });

  it('defaults implementation-shaped planning units to code developer', () => {
    const role = inferPlanningUnitSuggestedRole({
      title: 'Fix Ticket Queue Metadata Persistence',
      labels: ['bugfix'],
      acceptanceCriteria: ['Metadata is stored with each status history event'],
    });

    expect(role).toBe('code-developer');
  });
});
