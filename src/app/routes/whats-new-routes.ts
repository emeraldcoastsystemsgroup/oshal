/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

import { Router, Request, Response } from 'express';

interface WhatsNewEntry {
  version: string;
  date: string;
  title: string;
  details: string[];
}

const CHANGELOG: WhatsNewEntry[] = [
  {
    version: '2.0.0-beta.1',
    date: '2026-03-31',
    title: 'Welcome Screen & Dashboard',
    details: [
      'First-time onboarding wizard',
      'Dashboard homepage with config health, spend, and recent activity',
      'Saved swarm presets',
      'Windows desktop automation MCP (ADR-029)',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-03-30',
    title: 'Swarm Execution Pipeline',
    details: [
      'Phase-based multi-bot orchestration',
      'Verification and governance gates',
      'Cost rollup per swarm run',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-03-21',
    title: 'Cockpit Hardening',
    details: [
      'Ticket workbench with hierarchy and filters',
      'Bot address book with enable/disable',
      'Calendar scheduling integration',
      'Settings decomposition and views barrel',
    ],
  },
];

/**
 * @description Builds the Express router that exposes the application's
 * "What's New" changelog so the UI can surface recent releases to users
 * (e.g. for an onboarding or update-notification panel). Centralizing the
 * route in a factory keeps the changelog data and its HTTP contract together
 * and lets the host app mount it without coupling to global router state.
 * @returns {Router} An Express router serving GET /whats-new, which responds
 * with a JSON object containing the changelog entries under `entries`.
 */
export function createWhatsNewRoutes(): Router {
  const router = Router();

  router.get('/whats-new', (_req: Request, res: Response) => {
    res.json({ entries: CHANGELOG });
  });

  return router;
}