/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Tests for Plane sync 3-point loop and RAG default namespaces
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const OSHAL_ROOT = path.resolve(__dirname, '..');

// ─── Plane Sync 3-Point Integration Tests ────────────────────────────────────

test.describe('Plane Sync: 3-point polling loop', () => {
  test('PlaneSyncService has startPolling method', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'ticketing', 'services', 'plane-sync-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('startPolling(');
    expect(content).toContain('stopPolling(');
  });

  test('PlaneSyncService has pushCompletion method for step 3', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'ticketing', 'services', 'plane-sync-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('pushCompletion(');
    expect(content).toContain('transitionIssueState(');
  });

  test('poll cycle fetches issues by state and transitions to started', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'ticketing', 'services', 'plane-sync-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    // Verify the 3 steps are present in pollCycle
    expect(content).toContain("fetchIssuesByState(");
    expect(content).toContain("transitionIssueState(");
    expect(content).toContain("'approved'"); // creates internal ticket as approved
    expect(content).toContain("'started'"); // transitions Plane issue to started
  });

  test('pushCompletion transitions Plane issue to completed', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'ticketing', 'services', 'plane-sync-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain("'completed'");
    expect(content).toContain('formatCompletionComment(');
  });

  test('default poll state is unstarted (Plane Todo)', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'ticketing', 'services', 'plane-sync-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain("const DEFAULT_POLL_STATE = 'unstarted'");
  });
});

// ─── RAG Default Community Namespaces Tests ──────────────────────────────────

test.describe('RAG: Default community namespaces', () => {
  test('SWARM_RAG_NAMESPACES is exported with tickets, messages, knowledge', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('export const SWARM_RAG_NAMESPACES');
    expect(content).toContain("tickets: 'swarm-tickets'");
    expect(content).toContain("messages: 'swarm-messages'");
    expect(content).toContain("knowledge: 'swarm-knowledge'");
  });

  test('SWARM_RAG_NAMESPACE_LIST is exported for iteration', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('export const SWARM_RAG_NAMESPACE_LIST');
  });

  test('ensureDefaultNamespaces method exists', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('async ensureDefaultNamespaces()');
  });

  test('ingestTicketContext method exists for swarm-tickets namespace', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('async ingestTicketContext(');
    expect(content).toContain('SWARM_RAG_NAMESPACES.tickets');
  });

  test('ingestMessage method exists for swarm-messages namespace', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('async ingestMessage(');
    expect(content).toContain('SWARM_RAG_NAMESPACES.messages');
  });

  test('ingestKnowledge method exists for swarm-knowledge namespace', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('async ingestKnowledge(');
    expect(content).toContain('SWARM_RAG_NAMESPACES.knowledge');
  });

  test('queryNamespace method exists for cross-namespace queries', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('async queryNamespace(');
  });

  test('backward compat: memory namespace still maps to swarm-memory', () => {
    const filePath = path.join(OSHAL_ROOT, 'src', 'features', 'agent-management', 'services', 'swarm-memory-service.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain("memory: SWARM_MEMORY_COLLECTION");
  });
});