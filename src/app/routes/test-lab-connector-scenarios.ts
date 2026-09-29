/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register connector callback refusal and browser-bound OAuth regression suites with the existing Test Lab.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register the Yahoo Mail connector card: the anonymous credential refusal on /api/connect/yahoo/access-token, with the loopback-IMAP reader suite and the connector schema/card suite attached. No mailbox is contacted; a live Yahoo connect is an operator acceptance step.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register the ESPN Fantasy league-read card for the fantasy-leagues kernel skill (ADR-146 D2): the anonymous refusal on /api/connect/espn-fantasy/access-token, with the loopback protocol-seam suite and the kernel-skill contract suite attached. No ESPN host is contacted and no real league is read; a real-league read stays an operator acceptance step behind a signed-in session.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Describe same-subject issuer-switch refusal in the linked real-HTTP consent suite; the installed card remains anonymous refusal only.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** @description Exercise only refusal paths, anonymously and without any provider request. */
async function refusal(path: string, expected: number, label: string): Promise<StepResult> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  return {
    app: 'connectors', label, status: response.status,
    state: response.status === expected ? 'pass' : response.status === 404 ? 'gap' : 'fail',
    detail: `HTTP ${response.status}; expected ${expected}. No provider authorization or token exchange was requested.`,
  };
}

export const CONNECTOR_OAUTH_SCENARIOS: Scenario[] = [{
  id: 'connector-oauth-boundary', title: 'Connector sign-in callback boundary', group: 'tool',
  description: 'Check that an anonymous callback reaches state validation while connector data and completion still require sign-in. Cross-domain success, replay and same-subject issuer-switch refusals use real HTTP with isolated authentication/provider/storage fixtures in the linked suites; this card does not perform provider consent.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/connector-oauth-callback.spec.ts' },
    { level: 'integration', path: 'tests/unit/connector-reconnect.spec.ts' },
  ],
  steps: [
    { id: 'invalid-state', app: 'connectors', label: 'Reject invalid callback', run: () => refusal('/api/connect/google/callback?state=test-lab-invalid&code=test-lab-unused', 400, 'Invalid state refused') },
    { id: 'private-token', app: 'connectors', label: 'Protect connector credentials', run: () => refusal('/api/connect/google/access-token', 401, 'Credentials require sign-in') },
    { id: 'private-completion', app: 'connectors', label: 'Protect completion', run: () => refusal('/api/connect/google/complete?ticket=test-lab-unused', 401, 'Completion requires sign-in') },
  ],
}, {
  id: 'yahoo-mail-connector', title: 'Yahoo Mail connector (app password, read-only IMAP)', group: 'tool',
  description: 'Check that the Yahoo Mail credential stays behind sign-in. The linked suites drive the real IMAP client against a loopback responder: the closed address:app-password schema, the fixed imap.mail.yahoo.com:993 endpoint, a read-only EXAMINE with a bounded envelope FETCH, the caller-personal grant, and LOGIN refusal. They do not sign in to a real Yahoo mailbox.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/imap-mail-reader.spec.ts' },
    { level: 'unit', path: 'tests/unit/connector-yahoo.spec.ts' },
  ],
  steps: [
    { id: 'private-token', app: 'connectors', label: 'Protect the Yahoo credential', run: () => refusal('/api/connect/yahoo/access-token', 401, 'Yahoo credential requires sign-in') },
  ],
}, {
  id: 'espn-fantasy-league-reads', title: 'ESPN Fantasy league reads (fantasy-leagues kernel skill)', group: 'tool',
  description: 'Check that the ESPN Fantasy cookies stay behind sign-in. The linked suites drive the fantasy-leagues kernel skill, the one ESPN fantasy read client (ADR-146 D2), against a loopback host shaped like ESPN: both cookies on league reads only and none on the public feed, the fixed ESPN host under a hostile league id, refused, unavailable and unreachable kept apart, and espn_s2 absent from every log event and returned value; plus the skill contract that pins the client into the build. They do not contact ESPN or read a real league.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/fantasy-leagues-espn-client.spec.ts' },
    { level: 'unit', path: 'tests/unit/kernel-skills.spec.ts' },
  ],
  steps: [
    { id: 'private-token', app: 'connectors', label: 'Protect the ESPN Fantasy cookies', run: () => refusal('/api/connect/espn-fantasy/access-token', 401, 'ESPN Fantasy cookies require sign-in') },
  ],
}];
