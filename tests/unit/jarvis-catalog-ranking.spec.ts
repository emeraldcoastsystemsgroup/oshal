/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the 2026-10-01 cap: the live box had 66 effective routes and Jarvis's ASSISTANT CATALOG showed the first 40, so "calendar" (route 62) could not be routed or planned. On a fixture shaped like that box, every route key is listed; the routes the ask names lead with their description (calendar asked about at route 62 comes first); a turn with no ask keeps the deployment order; the lines stay inside the budget; and a deployment too large even for compact lines names how many were left out instead of cutting them silently. The 40-cap shape is shown losing calendar.
 */

import { describe, expect, it } from 'vitest';
import type { AppRoute } from '@/app/routes/jarvis-orchestrator';
import { CATALOG_LINES_BUDGET_CHARS, catalogLines, renderCatalogBlock } from '@/app/routes/jarvis-catalog-block';

/** Route keys in the live box's order on 2026-10-01; the first five and 21 and 25 take delegated work. */
const LIVE_KEYS = ['email', 'social', 'home', 'cloud', 'presentations', 'identity', 'storage', 'travel', 'creative-studio',
  'gov-contracting', 'kalshi', 'intelligent-operations', 'calling-assistant', 'fantasy-football', 'person-model', 'life',
  'intelligent-processing', 'capability-ideation', 'games', 'career-hunter', 'circuit-lab', 'night-smoke-flow', 'dnd', 'game-show',
  'venture-plan', 'feeds', 'purchasing', 'eats', 'federal-capture', 'portrait-studio', 'movies', 'intelligent-trades', 'system',
  'payroll', 'sports-edge', 'bake-off', 'aero-lab', 'hello-oshal', 'vids', 'animatronics', 'create', 'daily-trade-recap', 'embodied',
  'spotify', 'capability-ideator', 'video', 'email-summarizer', 'switchboard', 'lora', 'print-ingest', 'capture-crm', 'scan-to-print',
  'workflow-studio', 'rides', 'job-apply', 'ocean-lab', 'smoke-published-flow', 'drone-relay', 'finance', 'intelligent-sales', 'world',
  'calendar', 'payments', 'cad-studio', 'little-monsters', 'marketing-engine'];
const DELEGATE = new Set(['email', 'social', 'home', 'cloud', 'presentations', 'circuit-lab', 'venture-plan']);
const NAMES: Record<string, string> = { calendar: 'Calendar Preparation', email: 'Communications', social: 'Social Writer' };

/** A route as loadEffectiveRoutes returns it, with a blurb as long as the live ones. */
function route(key: string): AppRoute {
  const name = NAMES[key] ?? key.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { key, name, agentId: `agent-${key}`, mode: DELEGATE.has(key) ? 'delegate' : 'handoff', deepLink: `/cockpit/?app=${key}`,
    blurb: `Select for ${name} work on this deployment: the ${key.replace(/-/g, ' ')} records, their review and the follow-up actions the owner asks for, nothing else.` };
}
const LIVE = LIVE_KEYS.map(route);

describe('the ASSISTANT CATALOG lists every app, the asked-about ones first', () => {
  it('lists all 66 route keys inside the budget on a turn that asks about one of them', () => {
    const lines = catalogLines(LIVE, 'Pull my calendar for next week, then draft a summary email');
    for (const key of LIVE_KEYS) expect(lines.some((line) => line.startsWith(`- ${key}: `)), key).toBe(true);
    expect(lines.join('\n').length + lines.length).toBeLessThanOrEqual(CATALOG_LINES_BUDGET_CHARS);
  });

  it('brings calendar (route 62) and email to the front with their descriptions when the ask names both', () => {
    const lines = catalogLines(LIVE, 'Pull my calendar for next week, then draft a summary email');
    const lead = lines.slice(0, 3);
    expect(lead).toContain(`- calendar: Calendar Preparation - ${route('calendar').blurb} (point the user to it: /cockpit/?app=calendar)`);
    expect(lead).toContain(`- email: Communications - ${route('email').blurb} (you can hand work to it)`);
  });

  it('keeps the deployment order and describes the first entries when there is no ask', () => {
    const lines = catalogLines(LIVE, '');
    expect(lines.map((line) => line.slice(2, line.indexOf(':')))).toEqual(LIVE_KEYS);
    expect(lines[0]).toContain(route('email').blurb);
    expect(lines[LIVE_KEYS.length - 1]).toBe('- marketing-engine: Marketing Engine (point the user to it: /cockpit/?app=marketing-engine)');
  });

  it('names the reach on a compact line: hand work to a delegate, link the user to a handoff app', () => {
    // 140 characters hold both compact lines (50 + 81) and neither description.
    const lines = catalogLines([route('social'), route('calendar')], '', 140);
    expect(lines).toEqual(['- social: Social Writer (you can hand work to it)',
      '- calendar: Calendar Preparation (point the user to it: /cockpit/?app=calendar)']);
  });

  it('counts the apps that do not fit even as compact lines, keeping the asked-about one', () => {
    const many = Array.from({ length: 400 }, (_, i) => route(`fixture-app-${i}`));
    const lines = catalogLines([...many, route('calendar')], 'what is on my calendar');
    expect(lines[0].startsWith('- calendar: ')).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/^- \(\d+ more apps on this deployment are not listed here; they appear when a request names them\)$/);
    expect(lines.slice(0, -1).join('\n').length).toBeLessThanOrEqual(CATALOG_LINES_BUDGET_CHARS);
  });

  it('would have hidden calendar under the old 40-route cap', () => {
    const capped = LIVE.slice(0, 40).map((r) => `- ${r.key}: ${r.name} - ${r.blurb.slice(0, 180)}`);
    expect(capped.some((line) => line.startsWith('- calendar: '))).toBe(false);
    expect(renderCatalogBlock(LIVE, 'what is on my calendar')).toContain('- calendar: Calendar Preparation - ');
  });

  it('renders nothing for a deployment with no routes', () => {
    expect(renderCatalogBlock([], 'anything')).toBe('');
  });
});
