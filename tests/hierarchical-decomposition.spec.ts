/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added tests for 2-level hierarchical decomposition and subtask queue logic
 */

import { test, expect } from '@playwright/test';
import {
  TicketDecompositionService,
  type DecomposedWorkUnit,
  type SubtaskDecompositionInput,
} from '../src/features/swarm-orchestration/services/ticket-decomposition-service';
import {
  MAX_ACTIVE_SUBTASKS_PER_PARENT,
  MAX_DECOMPOSITION_DEPTH,
  SUBTASK_STATUSES,
  ACTIVE_SUBTASK_STATUSES,
  TERMINAL_SUBTASK_STATUSES,
} from '../src/entities/work-item/types';

// ─── TicketDecompositionService — Root-Level (depth 0) ──────────────────

test.describe('TicketDecompositionService — root decomposition', () => {
  const svc = new TicketDecompositionService();

  test('decompose() returns depth 0 units with null parentUnitId', () => {
    const units = svc.decompose({
      externalId: 'TICK-1',
      title: 'Build auth module',
      body: 'Create login form\nAdd JWT validation\nWrite tests',
      provider: 'plane',
      status: 'Todo',
      labels: ['auth'],
      priority: 'high',
    });

    expect(units).toHaveLength(3);
    for (const unit of units) {
      expect(unit.depth).toBe(0);
      expect(unit.parentUnitId).toBeNull();
    }
  });

  test('decompose() caps root units at 5', () => {
    const body = Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`).join('\n');
    const units = svc.decompose({
      externalId: 'TICK-2',
      title: 'Big task',
      body,
      provider: 'plane',
      status: 'Todo',
      labels: [],
    });

    expect(units).toHaveLength(5);
  });

  test('decompose() falls back to single unit when body is empty', () => {
    const units = svc.decompose({
      externalId: 'TICK-3',
      title: 'Simple task',
      body: '',
      provider: 'plane',
      status: 'Todo',
      labels: [],
    });

    expect(units).toHaveLength(1);
    expect(units[0].depth).toBe(0);
    expect(units[0].parentUnitId).toBeNull();
    expect(units[0].title).toBe('Simple task');
  });
});

// ─── TicketDecompositionService — Subtask (depth 1) ─────────────────────

test.describe('TicketDecompositionService — subtask decomposition', () => {
  const svc = new TicketDecompositionService();

  const baseInput: SubtaskDecompositionInput = {
    parentUnitId: 'parent-uuid-1',
    parentDepth: 0,
    activeChildCount: 0,
    body: 'Write unit tests\nWrite integration tests\nUpdate CI config',
    titlePrefix: 'Auth Module',
    externalId: 'TICK-1',
    labels: ['auth'],
    priority: 'high',
  };

  test('decomposeSubtasks() creates depth 1 units linked to parent', () => {
    const subtasks = svc.decomposeSubtasks(baseInput);

    expect(subtasks).toHaveLength(3);
    for (const sub of subtasks) {
      expect(sub.depth).toBe(1);
      expect(sub.parentUnitId).toBe('parent-uuid-1');
    }
  });

  test('decomposeSubtasks() titles include subtask number', () => {
    const subtasks = svc.decomposeSubtasks(baseInput);

    expect(subtasks[0].title).toContain('Subtask 1');
    expect(subtasks[1].title).toContain('Subtask 2');
    expect(subtasks[2].title).toContain('Subtask 3');
  });

  test('decomposeSubtasks() unitIds include parent reference', () => {
    const subtasks = svc.decomposeSubtasks(baseInput);

    for (const sub of subtasks) {
      expect(sub.unitId).toContain('parent-uuid-1');
      expect(sub.unitId).toContain('TICK-1');
      expect(sub.unitId).toContain('-sub-');
    }
  });

  test('decomposeSubtasks() caps at 5 subtasks', () => {
    const body = Array.from({ length: 10 }, (_, i) => `Sub-step ${i + 1}`).join('\n');
    const subtasks = svc.decomposeSubtasks({ ...baseInput, body });

    expect(subtasks).toHaveLength(5);
  });

  test('decomposeSubtasks() respects active child cap', () => {
    // Already have 3 active children → only 2 slots available
    const subtasks = svc.decomposeSubtasks({ ...baseInput, activeChildCount: 3 });

    expect(subtasks).toHaveLength(2);
  });

  test('decomposeSubtasks() returns empty when cap is reached', () => {
    const subtasks = svc.decomposeSubtasks({ ...baseInput, activeChildCount: 5 });

    expect(subtasks).toHaveLength(0);
  });

  test('decomposeSubtasks() returns empty when activeChildCount exceeds cap', () => {
    const subtasks = svc.decomposeSubtasks({ ...baseInput, activeChildCount: 7 });

    expect(subtasks).toHaveLength(0);
  });

  test('decomposeSubtasks() BLOCKS decomposition at depth >= 1 (hard cutoff)', () => {
    const subtasks = svc.decomposeSubtasks({ ...baseInput, parentDepth: 1 });

    expect(subtasks).toHaveLength(0);
  });

  test('decomposeSubtasks() returns empty for empty body', () => {
    const subtasks = svc.decomposeSubtasks({ ...baseInput, body: '' });

    expect(subtasks).toHaveLength(0);
  });

  test('decomposeSubtasks() inherits labels and priority from parent', () => {
    const subtasks = svc.decomposeSubtasks(baseInput);

    for (const sub of subtasks) {
      expect(sub.labels).toEqual(['auth']);
      expect(sub.priority).toBe('high');
    }
  });

  test('decomposeSubtasks() with exactly 1 available slot creates exactly 1 subtask', () => {
    const subtasks = svc.decomposeSubtasks({ ...baseInput, activeChildCount: 4 });

    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].title).toContain('Subtask 1');
  });
});

// ─── canDecompose() ─────────────────────────────────────────────────────

test.describe('TicketDecompositionService — canDecompose', () => {
  const svc = new TicketDecompositionService();

  test('canDecompose() returns true for depth 0', () => {
    expect(svc.canDecompose(0)).toBe(true);
  });

  test('canDecompose() returns false for depth 1 (max depth)', () => {
    expect(svc.canDecompose(1)).toBe(false);
  });

  test('canDecompose() returns false for depth > 1', () => {
    expect(svc.canDecompose(2)).toBe(false);
    expect(svc.canDecompose(5)).toBe(false);
  });
});

// ─── Constants ──────────────────────────────────────────────────────────

test.describe('Hierarchical decomposition constants', () => {
  test('MAX_DECOMPOSITION_DEPTH is 1 (2 levels: root + subtask)', () => {
    expect(MAX_DECOMPOSITION_DEPTH).toBe(1);
  });

  test('MAX_ACTIVE_SUBTASKS_PER_PARENT is 5', () => {
    expect(MAX_ACTIVE_SUBTASKS_PER_PARENT).toBe(5);
  });

  test('subtask statuses are separate from main queue statuses', () => {
    const mainStatuses = ['pending', 'assigned', 'executing', 'completed', 'failed', 'escalated'];
    for (const subtaskStatus of SUBTASK_STATUSES) {
      expect(mainStatuses).not.toContain(subtaskStatus);
      expect(subtaskStatus).toMatch(/^subtask-/);
    }
  });

  test('active subtask statuses are subset of subtask statuses', () => {
    for (const active of ACTIVE_SUBTASK_STATUSES) {
      expect(SUBTASK_STATUSES).toContain(active);
    }
  });

  test('terminal subtask statuses are subset of subtask statuses', () => {
    for (const terminal of TERMINAL_SUBTASK_STATUSES) {
      expect(SUBTASK_STATUSES).toContain(terminal);
    }
  });

  test('active and terminal subtask statuses are disjoint', () => {
    for (const active of ACTIVE_SUBTASK_STATUSES) {
      expect(TERMINAL_SUBTASK_STATUSES).not.toContain(active);
    }
  });

  test('active + terminal covers all subtask statuses', () => {
    const combined = [...ACTIVE_SUBTASK_STATUSES, ...TERMINAL_SUBTASK_STATUSES];
    for (const status of SUBTASK_STATUSES) {
      expect(combined).toContain(status);
    }
  });
});

// ─── Slot Freeing Logic ─────────────────────────────────────────────────

test.describe('Subtask slot freeing across cycles', () => {
  const svc = new TicketDecompositionService();

  test('completed subtasks free slots for new subtasks in next cycle', () => {
    // Cycle 1: 5 active children, cap reached
    const cycle1 = svc.decomposeSubtasks({
      parentUnitId: 'parent-1',
      parentDepth: 0,
      activeChildCount: 5,
      body: 'More work\nEven more work',
      titlePrefix: 'Task',
      externalId: 'TICK-1',
      labels: [],
    });
    expect(cycle1).toHaveLength(0);

    // Cycle 2: 2 children completed → 3 active → 2 slots available
    const cycle2 = svc.decomposeSubtasks({
      parentUnitId: 'parent-1',
      parentDepth: 0,
      activeChildCount: 3,
      body: 'More work\nEven more work',
      titlePrefix: 'Task',
      externalId: 'TICK-1',
      labels: [],
    });
    expect(cycle2).toHaveLength(2);
  });

  test('all children done allows full re-decomposition up to cap', () => {
    const subtasks = svc.decomposeSubtasks({
      parentUnitId: 'parent-1',
      parentDepth: 0,
      activeChildCount: 0,
      body: 'A\nB\nC\nD\nE\nF\nG',
      titlePrefix: 'Task',
      externalId: 'TICK-1',
      labels: [],
    });
    // 7 lines but capped at 5
    expect(subtasks).toHaveLength(5);
  });
});
