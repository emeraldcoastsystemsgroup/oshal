/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the inline-bot display-online fix. Inline/api-hosted bots never publish a heartbeat, so the cockpit's heartbeat-only rule rendered every one of them offline even while working (dnd had 122 real runs). resolveDisplayOnline = heartbeat OR isControllerInlineContainer(container), classified from the LIVE registry container — NOT agents.metadata, which stale-tags the promoted trading-analyst NODE as inline. This locks in: inline (oshal-api) with no heartbeat = online; a dedicated node with no heartbeat = offline; and the trading-analyst trap can't regress.
 */

import { describe, expect, it } from 'vitest';
import { resolveDisplayOnline, isControllerInlineContainer } from '../../src/features/agent-management';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';

describe('display online rule — inline bots must not render offline', () => {
  it('inline/api-hosted bot with NO heartbeat is online (the api is up)', () => {
    expect(resolveDisplayOnline(false, 'oshal-api')).toBe(true);
    expect(resolveDisplayOnline(false, 'oshal-local-api')).toBe(true);
  });

  it('dedicated bot-node with NO heartbeat is offline (it must rely on its heartbeat)', () => {
    expect(resolveDisplayOnline(false, 'trading-bot')).toBe(false);
    expect(resolveDisplayOnline(false, 'email-bot')).toBe(false);
    expect(resolveDisplayOnline(false, '')).toBe(false);
    expect(resolveDisplayOnline(false, undefined)).toBe(false);
    expect(resolveDisplayOnline(false, null)).toBe(false);
  });

  it('any bot WITH a heartbeat is online regardless of container', () => {
    expect(resolveDisplayOnline(true, 'trading-bot')).toBe(true);
    expect(resolveDisplayOnline(true, 'oshal-api')).toBe(true);
  });

  it('an operator-DISABLED inline bot reads offline (the enabled gate honours the toggle)', () => {
    expect(resolveDisplayOnline(false, 'oshal-api', false)).toBe(false); // disabled inline → offline
    expect(resolveDisplayOnline(false, 'oshal-api', true)).toBe(true);   // enabled inline → online
    // enabled defaults true (back-compat)
    expect(resolveDisplayOnline(false, 'oshal-api')).toBe(true);
    // a heartbeat still wins — the enabled gate only governs the inline branch
    expect(resolveDisplayOnline(true, 'oshal-api', false)).toBe(true);
  });

  it('classifies the REAL registry from the container, not the stale DB metadata', () => {
    const byName = new Map(LOCAL_BOT_REGISTRY.map((b) => [b.name, b]));

    // trading-analyst is DB-tagged inlineControllerBot=true (stale, pre-ADR-083), but the registry
    // container is the source of truth: trading-bot + requiresOwnNode = a dedicated NODE → NOT inline,
    // so with no heartbeat it must read OFFLINE (this is the documented trap the fix must not regress).
    const trading = byName.get('trading-analyst');
    expect(trading, 'trading-analyst present in registry').toBeDefined();
    expect(isControllerInlineContainer(trading!.container)).toBe(false);
    expect(resolveDisplayOnline(false, trading!.container)).toBe(false);

    // security-analyst is a real inline concierge (container oshal-api) → online with no heartbeat.
    const security = byName.get('security-analyst');
    expect(security, 'security-analyst present in registry').toBeDefined();
    expect(isControllerInlineContainer(security!.container)).toBe(true);
    expect(resolveDisplayOnline(false, security!.container)).toBe(true);
  });
});
