/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added unit tests for AgentRouter + SelectionBidService
 */

import { test, expect } from '@playwright/test';
import { AgentRouter, type RouteCandidate, type RouteContext } from '../src/features/agent-management/services/agent-router';
import { SelectionBidService, type AgentBid } from '../src/features/agent-management/services/selection-bid-service';

// ─── SelectionBidService ───────────────────────────────────────────────

test.describe('SelectionBidService', () => {
  const svc = new SelectionBidService();

  test('chooseWinner() selects highest confidence bid', () => {
    const bids: AgentBid[] = [
      { agentId: 'a', confidence: 0.7, estimatedCost: 10, estimatedLatencyMs: 100 },
      { agentId: 'b', confidence: 0.9, estimatedCost: 10, estimatedLatencyMs: 100 },
      { agentId: 'c', confidence: 0.5, estimatedCost: 10, estimatedLatencyMs: 100 },
    ];
    expect(svc.chooseWinner(bids).agentId).toBe('b');
  });

  test('chooseWinner() breaks confidence ties by lowest cost', () => {
    const bids: AgentBid[] = [
      { agentId: 'a', confidence: 0.9, estimatedCost: 20, estimatedLatencyMs: 100 },
      { agentId: 'b', confidence: 0.9, estimatedCost: 5, estimatedLatencyMs: 100 },
      { agentId: 'c', confidence: 0.9, estimatedCost: 15, estimatedLatencyMs: 100 },
    ];
    expect(svc.chooseWinner(bids).agentId).toBe('b');
  });

  test('chooseWinner() breaks cost ties by lowest latency', () => {
    const bids: AgentBid[] = [
      { agentId: 'a', confidence: 0.9, estimatedCost: 10, estimatedLatencyMs: 500 },
      { agentId: 'b', confidence: 0.9, estimatedCost: 10, estimatedLatencyMs: 50 },
      { agentId: 'c', confidence: 0.9, estimatedCost: 10, estimatedLatencyMs: 200 },
    ];
    expect(svc.chooseWinner(bids).agentId).toBe('b');
  });

  test('chooseWinner() throws on empty bids', () => {
    expect(() => svc.chooseWinner([])).toThrow('No bids submitted');
  });

  test('chooseWinner() works with single bid', () => {
    const bids: AgentBid[] = [
      { agentId: 'only', confidence: 0.5, estimatedCost: 10, estimatedLatencyMs: 100 },
    ];
    expect(svc.chooseWinner(bids).agentId).toBe('only');
  });
});

// ─── AgentRouter ───────────────────────────────────────────────────────

test.describe('AgentRouter', () => {
  const router = new AgentRouter();

  const candidates: RouteCandidate[] = [
    { agentId: 'code-developer', score: 0.8, reason: 'capability match' },
    { agentId: 'test-engineer', score: 0.6, reason: 'partial match' },
    { agentId: 'documentation-writer', score: 0.4, reason: 'weak match' },
  ];

  test('route() uses score-based ranking when no bids provided', () => {
    const ctx: RouteContext = { taskId: 'task-1' };
    const decision = router.route(ctx, candidates);

    expect(decision.strategy).toBe('score');
    expect(decision.winner.agentId).toBe('code-developer'); // Highest score
    expect(decision.ranked).toHaveLength(3);
    expect(decision.ranked[0].agentId).toBe('code-developer');
    expect(decision.ranked[1].agentId).toBe('test-engineer');
    expect(decision.ranked[2].agentId).toBe('documentation-writer');
  });

  test('route() uses bid winner when bid winner is in candidates', () => {
    const ctx: RouteContext = {
      taskId: 'task-2',
      bids: [
        { agentId: 'test-engineer', confidence: 0.95, estimatedCost: 5, estimatedLatencyMs: 100 },
        { agentId: 'code-developer', confidence: 0.7, estimatedCost: 10, estimatedLatencyMs: 200 },
      ],
    };
    const decision = router.route(ctx, candidates);

    expect(decision.strategy).toBe('bid');
    expect(decision.winner.agentId).toBe('test-engineer'); // Bid winner overrides score
    // Ranked list is still score-ordered
    expect(decision.ranked[0].agentId).toBe('code-developer');
  });

  test('route() falls back to score when bid winner not in candidates', () => {
    const ctx: RouteContext = {
      taskId: 'task-3',
      bids: [
        { agentId: 'non-existent-agent', confidence: 0.99, estimatedCost: 1, estimatedLatencyMs: 10 },
      ],
    };
    const decision = router.route(ctx, candidates);

    expect(decision.strategy).toBe('score');
    expect(decision.winner.agentId).toBe('code-developer'); // Falls back to highest score
  });

  test('route() throws on empty candidates', () => {
    const ctx: RouteContext = { taskId: 'task-4' };
    expect(() => router.route(ctx, [])).toThrow('No routing candidates available');
  });

  test('route() works with single candidate', () => {
    const ctx: RouteContext = { taskId: 'task-5' };
    const single: RouteCandidate[] = [
      { agentId: 'only-agent', score: 0.5, reason: 'only option' },
    ];
    const decision = router.route(ctx, single);

    expect(decision.winner.agentId).toBe('only-agent');
    expect(decision.ranked).toHaveLength(1);
    expect(decision.strategy).toBe('score');
  });

  test('route() correctly ranks when scores are tied', () => {
    const ctx: RouteContext = { taskId: 'task-6' };
    const tied: RouteCandidate[] = [
      { agentId: 'a', score: 0.8, reason: 'match' },
      { agentId: 'b', score: 0.8, reason: 'match' },
    ];
    const decision = router.route(ctx, tied);

    expect(decision.strategy).toBe('score');
    // Either a or b could win — just ensure one of them is winner
    expect(['a', 'b']).toContain(decision.winner.agentId);
    expect(decision.ranked).toHaveLength(2);
  });

  test('route() with bids but empty bids array falls back to score', () => {
    const ctx: RouteContext = { taskId: 'task-7', bids: [] };
    const decision = router.route(ctx, candidates);

    expect(decision.strategy).toBe('score');
    expect(decision.winner.agentId).toBe('code-developer');
  });
});
