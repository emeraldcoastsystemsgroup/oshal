/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (B4, step B5-2): the Swarm Admin navigation is server data. GET /api/admin/navigation (mounted behind requiresAuth + requiresOperator, the admin role of Amendment A1) lists the Swarm Admin home and the administration pages that exist today, grouped; a screen's entry ships in the same change as its route, so nothing lists a page that does not exist, and users, who never see Swarm Admin, cannot read the list either. The /swarm-admin home and its shared top bar render it.
 */

import { Router as createRouter, type Router } from 'express';

/**
 * @description One navigation entry: a page that exists and the group it is shown under.
 */
export interface SwarmAdminNavigationItem {
  id: string;
  title: string;
  path: string;
  group: 'swarm-admin' | 'people' | 'operations';
  description: string;
}

/**
 * @description The Swarm Admin navigation (ADR-174 Amendment B, B4): the home, then the
 * administration pages that exist today. Each later Swarm Admin screen adds its own entry in the
 * change that adds its route, never before. Every path here is a registered standalone surface
 * (resolveUiSurfacePages), which the surface guard pins. Frozen item by item.
 */
export const SWARM_ADMIN_NAVIGATION: ReadonlyArray<SwarmAdminNavigationItem> = Object.freeze(([
  { id: 'home', title: 'Swarm Admin', path: '/swarm-admin', group: 'swarm-admin', description: 'Portal defaults for everyone in this swarm.' },
  { id: 'users', title: 'Users and roles', path: '/users', group: 'people', description: 'Who holds swarm root and admin; invitations.' },
  { id: 'access-review', title: 'Access review', path: '/access-review', group: 'people', description: 'What each person and application may reach, and why.' },
  { id: 'admin-console', title: 'Operations console', path: '/admin', group: 'operations', description: 'Identity, health, audit search and posture.' },
  { id: 'governance', title: 'Governance posture', path: '/governance', group: 'operations', description: 'Runtime security controls and readiness.' },
  { id: 'app-loader', title: 'Application loader', path: '/app-loader', group: 'operations', description: 'Install and stage application packages.' },
  { id: 'config', title: 'Platform settings', path: '/config', group: 'operations', description: 'Platform settings and secrets.' },
  { id: 'data-model', title: 'Data model', path: '/data-model', group: 'operations', description: 'The data-model explorer.' },
] as SwarmAdminNavigationItem[]).map((item) => Object.freeze(item)));

/**
 * @description The navigation API for the Swarm Admin screens. Mount behind requiresAuth and
 * requiresOperator: the list is admin-only data, and the pages it names are guarded the same way.
 * @returns The configured router: GET / answers the home path and the grouped items.
 */
export function createSwarmAdminNavigationRoutes(): Router {
  const router = createRouter();
  router.get('/', (_req, res) => {
    res.json({ home: '/swarm-admin', items: SWARM_ADMIN_NAVIGATION });
  });
  return router;
}
