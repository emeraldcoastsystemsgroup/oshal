/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve real Cockpit profile/account interactions over synthetic session HTTP without account or business mutations.
 * =============================================================================
 */
import { startWorkspaceNavigationFixture } from './workspace-navigation';

export type ProfileReply = { status: number; body: unknown; wait?: Promise<void>; raw?: string };

/** @description A synthetic session exercises the actual renderer without impersonating a real account. */
export function signedInProfile(): ProfileReply {
  return { status: 200, body: { authenticated: true, user: {
    name: 'Example Member', email: 'member@example.test', sub: 'synthetic-profile-member',
  }, sub: 'synthetic-profile-member', guestMode: false } };
}

/** @description Hold a real HTTP response to exercise cancellation and late-result handling. */
export function profileGate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

/** @description Reuse complete actual app.js boot and shell CSS, overriding only synthetic HTTP responses. */
export async function startCockpitProfileFixture() {
  const state = { reply: signedInProfile(), authReads: 0, requests: [] as string[] };
  const fixture = await startWorkspaceNavigationFixture(app => {
    app.use((req, _res, next) => { state.requests.push(`${req.method} ${req.path}`); next(); });
    app.get('/api/auth/user', async (_req, res) => {
      state.authReads += 1;
      const reply = state.reply;
      await reply.wait;
      if (reply.raw !== undefined) res.status(reply.status).type('json').send(reply.raw);
      else res.status(reply.status).json(reply.body);
    });
    app.get(['/login', '/logout'], (req, res) => res.type('html').send(
      `<!doctype html><title>Isolated account destination</title><p>${req.path}</p>`));
  });
  return { ...fixture, profile: state };
}
