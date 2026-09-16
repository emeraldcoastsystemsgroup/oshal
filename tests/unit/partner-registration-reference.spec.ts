/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for docs/partner-app-registration.md: the operator-facing registration reference must cover every connector the real PROVIDERS registry declares, name the variables real providerCreds()/redirectUri() calls actually resolve (probed, not transcribed), point every token-paste connector at its tokenHelpUrl, and carry only counts taken from the registry. The document previously listed 14 connectors out of the registry's full set and its env keys were hand-copied.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/app/routes/connector-provider-registry';
import {
  BEGIN_MARKER, END_MARKER, REGISTRY_FILE, authMode, credBranchEnv, envNamesInFunction,
  probeCreds, probeSentinel, readRepoFile, registrationRows, tokenRows,
} from '../../scripts/connectors/partner-registration-reference';
import { checkDoc, docIsCurrent, renderReferenceBlock } from '../../scripts/connectors/partner-registration-doc';

const doc = (): string => readRepoFile('docs/partner-app-registration.md').replace(/\r\n/g, '\n');
const credCandidates = (): string[] => envNamesInFunction(readRepoFile(REGISTRY_FILE), 'providerCreds');
/**
 * Windows resolves process.env case-insensitively, so a name that shares its spelling with another
 * candidate apart from case cannot be set independently here — those pairs are skipped rather than
 * asserted wrongly. On a Linux runner every candidate is distinct and nothing is skipped.
 */
const caseAmbiguous = (key: string, candidates: string[]): boolean =>
  candidates.filter((other) => other.toLowerCase() === key.toLowerCase()).length > 1;

describe('partner-app registration reference covers the whole connector registry', () => {
  it('names every oauth/link provider, with its callback path and override variable', () => {
    const text = doc();
    const missing: string[] = [];
    for (const [id, def] of Object.entries(PROVIDERS)) {
      if (authMode(def) === 'token') continue;
      if (!text.includes(`(\`${id}\`)`)) missing.push(`${id}: not named`);
      else if (!text.includes(`\`${def.redirectPath}\``)) missing.push(`${id}: callback path absent`);
      else if (!text.includes(`\`${id.toUpperCase().replace(/-/g, '_')}_REDIRECT_URI\``)) {
        missing.push(`${id}: redirect override variable absent`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lists every token-paste connector and points at the page that issues its token', () => {
    const text = doc();
    const missing: string[] = [];
    for (const [id, def] of Object.entries(PROVIDERS)) {
      if (authMode(def) !== 'token') continue;
      if (!def.tokenHelpUrl) missing.push(`${id}: registry declares no tokenHelpUrl`);
      else if (!text.includes(`(\`${id}\`)`)) missing.push(`${id}: not named`);
      else if (!text.includes(def.tokenHelpUrl)) missing.push(`${id}: tokenHelpUrl absent`);
    }
    expect(missing).toEqual([]);
  });

  it('states the counts the registry holds, and backs each one with that many rows', () => {
    const text = doc();
    const oauthLink = Object.values(PROVIDERS).filter((d) => authMode(d) !== 'token').length;
    const paste = Object.values(PROVIDERS).filter((d) => authMode(d) === 'token').length;
    const block = text.slice(text.indexOf(BEGIN_MARKER), text.indexOf(END_MARKER));
    const summary = /\*\*(\d+) connectors are wired in the hub registry — (\d+) need a partner app registered \(Shape A or Link\) and (\d+) are token-paste only \(Shape B\)\.\*\*/
      .exec(block);
    expect(summary, 'the generated summary sentence is missing').not.toBeNull();
    expect([summary![1], summary![2], summary![3]].map(Number))
      .toEqual([oauthLink + paste, oauthLink, paste]);
    // A stated total nothing backs is the drift this replaces: count the rendered rows too.
    const rows = block.split('\n').filter((line) => /^\| .*\(`[a-z0-9-]+`\) \|/.test(line));
    expect(rows).toHaveLength(oauthLink + paste);
    expect(registrationRows()).toHaveLength(oauthLink);
    expect(tokenRows()).toHaveLength(paste);
  });
});

describe('the reference names the variables the connector code really resolves', () => {
  it('every rendered credential variable is one providerCreds() resolves to that field', () => {
    const candidates = credCandidates();
    const wrong: string[] = [];
    for (const row of registrationRows()) {
      for (const key of row.clientId) {
        if (probeCreds(row.id, candidates, [key]).clientId !== probeSentinel(key)) {
          wrong.push(`${row.id}: ${key} is not a client id`);
        }
      }
      for (const key of row.clientSecret) {
        if (probeCreds(row.id, candidates, [key]).clientSecret !== probeSentinel(key)) {
          wrong.push(`${row.id}: ${key} is not a client secret`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('omits no variable that providerCreds() honours for a provider', () => {
    const candidates = credCandidates();
    const branches = credBranchEnv(readRepoFile(REGISTRY_FILE));
    const rows = new Map(registrationRows().map((r) => [r.id, r]));
    const missing: string[] = [];
    for (const [id, keys] of Object.entries(branches)) {
      const row = rows.get(id);
      for (const key of keys) {
        const creds = probeCreds(id, candidates, [key]);
        const honoured = creds.clientId === probeSentinel(key) || creds.clientSecret === probeSentinel(key);
        if (!honoured) continue;
        if (!row) { missing.push(`${id}: honoured ${key} but the provider has no row`); continue; }
        if (!row.clientId.includes(key) && !row.clientSecret.includes(key)) missing.push(`${id}: ${key} absent`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('renders the precedence providerCreds() applies, not a guessed order', () => {
    const candidates = credCandidates();
    const wrong: string[] = [];
    for (const row of registrationRows()) {
      for (const field of ['clientId', 'clientSecret'] as const) {
        const keys = row[field];
        for (let i = 0; i + 1 < keys.length; i += 1) {
          const [first, next] = [keys[i], keys[i + 1]];
          if (caseAmbiguous(first, candidates) || caseAmbiguous(next, candidates)) continue;
          const resolved = probeCreds(row.id, candidates, [first, next])[field];
          if (resolved !== probeSentinel(first)) wrong.push(`${row.id}.${field}: ${next} beats ${first}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every credential probe restores the environment it borrowed', () => {
    const key = credCandidates()[0];
    const before = process.env[key];
    process.env[key] = 'operator-value';
    probeCreds('google', credCandidates(), [key]);
    expect(process.env[key]).toBe('operator-value');
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  });
});

describe('the reference cannot drift from the registry unnoticed', () => {
  it('the committed document already matches what the registry renders', () => {
    const result = checkDoc();
    expect(result.reason ?? 'no drift').toBe('no drift');
    expect(result.current).toBe(true);
  });

  it('an edited credential variable inside the block is caught as drift', () => {
    const block = renderReferenceBlock();
    const edited = doc().replace('`SLACK_CLIENT_ID`', '`SLACK_APP_ID`');
    expect(edited).not.toBe(doc());
    expect(docIsCurrent(edited, block).current).toBe(false);
  });

  it('a hand-typed connector count inside the block is caught as drift', () => {
    const block = renderReferenceBlock();
    const typed = doc().replace(/\*\*\d+ connectors are wired/, '**47 connectors are wired');
    expect(typed).not.toBe(doc());
    expect(docIsCurrent(typed, block).current).toBe(false);
  });

  it('a document that lost the generated markers fails with a reason, not a crash', () => {
    const block = renderReferenceBlock();
    const stripped = doc().replace(BEGIN_MARKER, '').replace(END_MARKER, '');
    const verdict = docIsCurrent(stripped, block);
    expect(verdict.current).toBe(false);
    expect(verdict.reason).toContain('generated-block markers');
  });
});
