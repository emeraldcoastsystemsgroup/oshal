/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the unmodified cockpit shell, the real /api/help router over the real docs/guides corpus, and the real Intelligent Processing screen over synthetic ticket rows, so the in-app help affordances are exercised across the browser/route boundary they claim.
 */
import express from 'express';
import { resolve } from 'node:path';
import { createHelpRoutes } from '@/app/routes/help-routes';
import { startWorkspaceNavigationFixture } from './workspace-navigation';

/** A synthetic ticket row as the Intelligent Processing screen reads it from /api/tickets. */
export interface FixtureTicket {
  ticketId: string;
  title: string;
  status: string;
  ticketType?: string;
  priority?: string;
  labels?: string[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * @description Start the real cockpit shell with the real help router mounted, plus the real
 * Intelligent Processing page over a controllable synthetic ticket list. Nothing here touches a
 * database, a provider or an installed account.
 * @returns The fixture origin, its mutable synthetic state and a complete shutdown.
 */
export async function startSurfaceHelpFixture() {
  const tickets: FixtureTicket[] = [];
  const fixture = await startWorkspaceNavigationFixture(app => {
    // The complete, unmodified cockpit document — every boot script, including first-run.js.
    app.get(['/cockpit/', '/cockpit/index.html'], (_req, res) =>
      res.sendFile(resolve('src/pages/cockpit/index.html')));
    app.use('/api/help', createHelpRoutes());
    app.get('/api/tickets', (req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const rows = status ? tickets.filter(ticket => ticket.status === status) : tickets;
      res.json({ tickets: rows, count: rows.length });
    });
    app.get('/api/providers/access', (_req, res) =>
      res.json({ hasActive: true, freeModel: null, providers: [{ id: 'fixture', label: 'Fixture', active: true }] }));
    app.use('/intelligent-processing', express.static(resolve('src/pages/intelligent-processing')));
  });
  // A framework-shaped ribbon: two surfaces the guide corpus covers and one it does not.
  Object.assign(fixture.state.profiles, {
    '': {
      name: 'framework-default', displayName: 'Synthetic Cockpit', defaultView: 'tool-fixture-editor',
      hideChatPanel: false, hideAssistant: false, hideStatusBar: false,
      ribbon: {
        items: [
          { id: 'tool-fixture-editor', label: 'Editor', section: 'home', toolUi: { iframeUrl: '/fixture/editor?mode=edit' } },
          'tickets', 'settings',
        ],
        dynamicTools: { allow: [] },
      },
    } as never,
  });
  return { ...fixture, tickets };
}
