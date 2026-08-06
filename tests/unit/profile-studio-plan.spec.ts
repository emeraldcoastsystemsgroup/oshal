/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for LinkedIn Profile Studio: the pure plan state machine (edits only in draft, dispatch only from approved, worker resolves dispatched, a dispatched plan can never silently reset) and the desktop dispatch prompt contract (plan fields present verbatim, assets docker-cp'd, service-secret callback, the never-notify-network guardrail, and absent fields omitted so the operator bot is never asked to touch an unplanned section).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Lock the secretless callback contract: only relative staged assets and strict result JSON enter the prompt; fleet secret, URL, subject, generated shell, and absolute source paths stay out.
 */

import { describe, it, expect } from 'vitest';
import { canTransition, PLAN_STATES, type LinkedInProfilePlan, type PlanState } from '@/features/profile-studio';
import { buildProfilePrompt } from '@/app/profile-studio-dispatch';

function plan(overrides: Partial<LinkedInProfilePlan> = {}): LinkedInProfilePlan {
  return {
    id: 7,
    userSub: 'user-abc',
    headline: 'Platform engineering leader',
    about: 'I lead teams that ship.',
    skills: ['Kubernetes', 'SRE'],
    customUrl: 'the operator-murphy',
    backgroundImagePath: '/data/u/profile-studio/background.png',
    photoPath: '/data/u/profile-studio/photo.png',
    resumePath: '/data/u/profile-studio/Featured_Resume.pdf',
    state: 'approved',
    dispatchTaskId: null,
    dispatchClientId: null,
    dispatchGeneration: 0,
    resultNote: null,
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    ...overrides,
  };
}

describe('profile plan state machine', () => {
  it('allows exactly the legal lifecycle moves', () => {
    expect(canTransition('draft', 'approved')).toBe(true);
    expect(canTransition('approved', 'dispatched')).toBe(true);
    expect(canTransition('dispatched', 'applied')).toBe(true);
    expect(canTransition('dispatched', 'failed')).toBe(true);
    // reset back to editable from every non-dispatched, non-draft state
    expect(canTransition('approved', 'draft')).toBe(true);
    expect(canTransition('applied', 'draft')).toBe(true);
    expect(canTransition('failed', 'draft')).toBe(true);
  });

  it('refuses skips, reversals, and the dispatched-reset race', () => {
    expect(canTransition('draft', 'dispatched')).toBe(false);   // no dispatch without approval
    expect(canTransition('draft', 'applied')).toBe(false);
    expect(canTransition('approved', 'applied')).toBe(false);   // only the worker resolves
    expect(canTransition('dispatched', 'draft')).toBe(false);   // must resolve (or abandon) first
    expect(canTransition('dispatched', 'approved')).toBe(false);
    expect(canTransition('applied', 'approved')).toBe(false);
    expect(canTransition('draft', 'draft')).toBe(false);
  });

  it('only ever reaches applied/failed via dispatched', () => {
    for (const from of PLAN_STATES) {
      for (const to of ['applied', 'failed'] as PlanState[]) {
        expect(canTransition(from, to)).toBe(from === 'dispatched');
      }
    }
  });
});

describe('buildProfilePrompt', () => {
  it('carries planned fields and relative staged assets without callback authority', () => {
    const previousSecret = process.env.SWARM_SERVICE_SECRET;
    process.env.SWARM_SERVICE_SECRET = 'fleet-secret-must-not-appear';
    const p = buildProfilePrompt(plan({ userSub: `hostile'; Write-Output $env:SWARM_SERVICE_SECRET; #` }), {
      photo: 'profile-photo.png', background: 'background.png', resume: 'featured-resume.pdf',
    });
    if (previousSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = previousSecret;
    expect(p).toContain('"Platform engineering leader"');
    expect(p).toContain('"I lead teams that ship."');
    expect(p).toContain('"Kubernetes"');
    expect(p).toContain('"the operator-murphy"');
    expect(p).toContain('background.png');
    expect(p).toContain('photo.png');
    expect(p).toContain('PROFILE PHOTO');
    expect(p).toContain('./featured-resume.pdf');
    expect(p).toContain('"result":"applied"');
    expect(p).not.toContain('docker cp');
    expect(p).not.toContain('Invoke-RestMethod');
    expect(p).not.toContain('/api/profile-studio/ingest');
    expect(p).not.toContain('fleet-secret-must-not-appear');
    expect(p).not.toContain('hostile');
  });

  it('enforces the account-safety guardrails in every prompt', () => {
    const p = buildProfilePrompt(plan());
    expect(p).toContain('NEVER create a feed post');
    expect(p).toContain('notify-network');
    expect(p).toContain('NEVER enter');       // credentials/codes on checkpoint pages
    expect(p).toContain('browser_control');
  });

  it('omits sections the plan does not include', () => {
    const p = buildProfilePrompt(plan({
      about: '', skills: [], customUrl: '', backgroundImagePath: null, photoPath: null, resumePath: null,
    }), {});
    expect(p).toContain('HEADLINE');
    expect(p).not.toContain('PROFILE PHOTO');
    expect(p).not.toContain('ABOUT (');
    expect(p).not.toContain('SKILLS (');
    expect(p).not.toContain('CUSTOM URL');
    expect(p).not.toContain('BACKGROUND PHOTO');
    expect(p).not.toContain('FEATURED RESUME');
    expect(p).not.toContain('TRUSTED STAGED ASSETS');
  });
});
