/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (B4, step B5-2): the Swarm Admin navigation is server data. GET /api/admin/navigation (mounted behind requiresAuth + requiresOperator, the admin role of Amendment A1) lists the Swarm Admin home and the administration pages that exist today, grouped; a screen's entry ships in the same change as its route, so nothing lists a page that does not exist, and users, who never see Swarm Admin, cannot read the list either. The /swarm-admin home and its shared top bar render it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-3): the AI defaults screen's entry, in the same change as its route.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-4): the swarm logins screen's entry, in the same change as its route.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-5): the budgets screen's entry, in the same change as its route.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-5): the connectors screen's entry, in the same change as its route.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-6): the shared-knowledge screen's entry, in the same change as its route.
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
  { id: 'ai-defaults', title: 'AI defaults', path: '/swarm-admin/ai-defaults', group: 'swarm-admin', description: 'The fleet provider, model and fallback order, and the swarm default for voice, speech, images and video.' },
  { id: 'logins', title: 'Swarm logins', path: '/swarm-admin/logins', group: 'swarm-admin', description: 'The vendor logins everyone without their own uses: Claude Code, Codex, Gemini, Antigravity.' },
  { id: 'budgets', title: 'Budgets', path: '/swarm-admin/budgets', group: 'swarm-admin', description: 'Daily spend caps for people, applications and tickets, their spend, and the enforcement trail.' },
  { id: 'connectors', title: 'Connectors', path: '/swarm-admin/connectors', group: 'swarm-admin', description: 'The connector catalog this swarm offers: enable, disable, remove and re-audit, with risk and audit standing.' },
  { id: 'knowledge', title: 'Shared knowledge', path: '/swarm-admin/knowledge', group: 'swarm-admin', description: 'What every bot can retrieve: the shared corpus, bot and private documents; add, remove, and prune collections.' },
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
