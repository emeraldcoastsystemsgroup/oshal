/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | First-run fix: the meter scored OPTIONAL integrations, so a perfectly-installed swarm reported "20% configured" and read as broken (operator walked the fresh Windows install and stopped here). percentComplete is now computed over REQUIRED items only — an install with a working model + a live bot reads 100% — and every check carries `required` so the UI can rank them. Dropped the standalone "API Key" check: it was a permanent ❌ on the dominant BYOK/OAuth/free-model paths, which have no key by design. The AI-provider check now reads listConfiguredProviders() — the SAME signal the onboarding gate and the wizard use — so the meter can no longer disagree with the gate that is holding the user. Every actionUrl was retargeted off /cockpit#… : those bounced (a) /cockpit is behind surfaceOnboardingGuard, so mid-onboarding they 302 straight back to /welcome, dropping the hash, and (b) #settings was never a cockpit route at all (RibbonNav routes on ?app=). Items the wizard itself can fix now carry `wizardStep` so it jumps in-wizard instead of opening a tab that bounces.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import type { AppContext } from '../composition/app-context';
import { listConfiguredProviders } from './provider-routes';

interface ConfigCheckItem {
  key: string;
  label: string;
  status: 'ok' | 'missing' | 'warning';
  detail: string;
  /** Required checks gate a usable swarm and are the ONLY ones scored in percentComplete. */
  required: boolean;
  actionUrl?: string;
  actionLabel?: string;
  /** Wizard step id that fixes this item in-place, when the onboarding wizard can fix it. */
  wizardStep?: string;
}

interface ConfigHealthResponse {
  /** Percentage of REQUIRED checks passing. Optional integrations never drag this down. */
  percentComplete: number;
  items: ConfigCheckItem[];
  criticalMissing: number;
  totalChecks: number;
  requiredChecks: number;
  requiredComplete: number;
  optionalChecks: number;
  optionalComplete: number;
}

function readGlobalConfig(): Record<string, any> {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = path.join(configDir, 'global-config.json');
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch { /* return empty */ }
  return {};
}

/**
 * @description Builds the Express router that exposes the onboarding/setup
 * "config health" endpoint. It exists so the cockpit UI can show users, at a
 * glance, which critical and optional integrations are configured and surface
 * direct action links to finish setup, rather than failing silently later when
 * a feature is used without its prerequisites.
 * @param ctx Application composition context; provides the shared Postgres pool
 * used to inspect runtime state (active bots, RAG collections).
 * @returns A configured Express Router mounting `GET /config/health`, which
 * responds with a {@link ConfigHealthResponse} summarizing each check.
 */
export function createConfigHealthRoutes(ctx: AppContext): Router {
  const router = Router();
  const pool: Pool = ctx.pool;

  router.get('/config/health', async (_req: Request, res: Response) => {
    const items: ConfigCheckItem[] = [];
    const globalCfg = readGlobalConfig();

    // 1. A working AI model? REQUIRED — every bot runs on one, so nothing works without it.
    // Read from listConfiguredProviders() rather than global-config directly: it is the same
    // signal the onboarding gate (server.ts) and the wizard's /api/providers/access check use,
    // and it correctly counts OAuth/BYOK and pooled free-model logins that write no API key.
    // Checking raw config keys here is what made a connected user still see a red ❌.
    try {
      const { providers, activeProvider } = listConfiguredProviders();
      const active = providers.find((p) => p.id === activeProvider);
      items.push({
        key: 'llm-provider',
        label: 'AI model',
        status: activeProvider ? 'ok' : 'missing',
        detail: activeProvider
          ? `${active?.label ?? activeProvider} is connected and set as the default.`
          : 'No AI model connected yet. Every bot runs on one, so this is required.',
        required: true,
        wizardStep: 'setup',
        actionUrl: '/utilities',
        actionLabel: 'Connect a model',
      });
    } catch {
      items.push({
        key: 'llm-provider',
        label: 'AI model',
        status: 'missing',
        detail: 'Unable to read the provider roster.',
        required: true,
        wizardStep: 'setup',
      });
    }

    // 2. At least one bot active? REQUIRED — a swarm with no workers cannot run a ticket.
    // Deliberately carries NO action link: bots register themselves as their containers finish
    // booting (the installer batches them), so there is nothing for the user to click. An honest
    // "still starting" beats a button that goes nowhere.
    try {
      const botCount = await pool.query(`SELECT COUNT(*) as cnt FROM agents WHERE status = 'active'`);
      const activeBots = parseInt(botCount.rows[0]?.cnt ?? '0', 10);
      items.push({
        key: 'active-bots',
        label: 'Bots online',
        status: activeBots > 0 ? 'ok' : 'missing',
        detail: activeBots > 0
          ? `${activeBots} bot(s) online.`
          : 'No bots online yet — they register themselves as their containers finish starting. Give it a minute.',
        required: true,
      });
    } catch {
      items.push({
        key: 'active-bots',
        label: 'Bots online',
        status: 'warning',
        detail: 'Unable to check bot status (the database may still be starting).',
        required: true,
      });
    }

    // --- Optional add-ons. None of these gate a usable swarm, so none are scored. -------------
    // Every actionUrl below points at a surface that is NOT behind surfaceOnboardingGuard
    // (/utilities, /rag-center), so the link works even while the user is mid-onboarding.

    // 3. RAG / Knowledge base?
    try {
      const ragCollections = await pool.query(`SELECT COUNT(*) as cnt FROM rag_collections WHERE status = 'active'`).catch(() => ({ rows: [{ cnt: '0' }] }));
      const ragCount = parseInt(ragCollections.rows[0]?.cnt ?? '0', 10);
      items.push({
        key: 'rag',
        label: 'Knowledge base (RAG)',
        status: ragCount > 0 ? 'ok' : 'warning',
        detail: ragCount > 0 ? `${ragCount} collection(s) active.` : 'Optional — add documents your bots can cite.',
        required: false,
        actionUrl: '/rag-center',
        actionLabel: 'Add documents',
      });
    } catch {
      items.push({ key: 'rag', label: 'Knowledge base (RAG)', status: 'warning', detail: 'Optional — RAG status unknown.', required: false });
    }

    // 4. Phone configured? (check global config for Twilio keys)
    const hasPhone = !!(globalCfg.twilioAccountSid || globalCfg.twilioPhoneNumber);
    items.push({
      key: 'phone',
      label: 'Phone & text (Twilio)',
      status: hasPhone ? 'ok' : 'warning',
      detail: hasPhone ? 'Phone number configured.' : 'Optional — let bots call and text you.',
      required: false,
      actionUrl: '/utilities',
      actionLabel: 'Set up',
    });

    // 5. Email configured? (check global config for email/SMTP keys)
    const hasEmail = !!(globalCfg.smtpHost || globalCfg.emailProvider);
    items.push({
      key: 'email',
      label: 'Email',
      status: hasEmail ? 'ok' : 'warning',
      detail: hasEmail ? 'Email configured.' : 'Optional — connect an inbox for bots to triage.',
      required: false,
      wizardStep: 'connect',
      actionUrl: '/utilities',
      actionLabel: 'Connect',
    });

    // 6. GitLab / repo sync configured?
    const hasGitlab = !!globalCfg.gitlabUrl;
    items.push({
      key: 'gitlab',
      label: 'GitLab',
      status: hasGitlab ? 'ok' : 'warning',
      detail: hasGitlab ? 'GitLab integration active.' : 'Optional — sync repos and issues.',
      required: false,
      actionUrl: '/utilities',
      actionLabel: 'Set up',
    });

    // Score REQUIRED items only. Folding optional integrations into the denominator is what made
    // a healthy fresh install read "20% configured" — a failing grade nobody could clear, since a
    // personal install legitimately never configures GitLab/Twilio/SMTP.
    const required = items.filter((i) => i.required);
    const optional = items.filter((i) => !i.required);
    const requiredComplete = required.filter((i) => i.status === 'ok').length;
    const percentComplete = required.length > 0 ? Math.round((requiredComplete / required.length) * 100) : 100;

    const response: ConfigHealthResponse = {
      percentComplete,
      items,
      criticalMissing: required.filter((i) => i.status !== 'ok').length,
      totalChecks: items.length,
      requiredChecks: required.length,
      requiredComplete,
      optionalChecks: optional.length,
      optionalComplete: optional.filter((i) => i.status === 'ok').length,
    };

    res.json(response);
  });

  return router;
}