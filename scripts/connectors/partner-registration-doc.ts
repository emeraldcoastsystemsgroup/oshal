/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Render the registry-derived registration reference into docs/partner-app-registration.md between generated markers, and splice/compare it. The block carries every wired hub connector — the Shape A/Link table with probed credential and redirect variables, and the Shape B paste-only table with each provider's token help URL — plus counts taken from PROVIDERS so no total is ever typed.
 */

/**
 * Markdown rendering and in-place splicing of the partner-app registration reference.
 *
 * @module scripts/connectors/partner-registration-doc
 */
import {
  BEGIN_MARKER, DOC_FILE, END_MARKER, REGEN_COMMAND, REGISTRY_FILE, readRepoFile,
  registrationRows, tokenRows, type RegistrationRow, type TokenRow,
} from './partner-registration-reference';

const cell = (text: string): string => text.replace(/\|/g, '\\|');
const keys = (names: string[]): string => (names.length ? names.map((n) => `\`${n}\``).join(' → ') : '—');

/**
 * @description Render one Shape A / Link row. The redirect cell names the path appended to
 * `APP_URL` and, in brackets, every variable that replaces the whole URI when set.
 * @param row - a registration row
 * @returns the markdown table row
 */
function registrationLine(row: RegistrationRow): string {
  const override = row.overrides.length ? ` (override ${keys(row.overrides)})` : '';
  return `| ${cell(row.label)} (\`${row.id}\`) | ${row.shape} | \`${row.redirectPath}\`${override} `
    + `| ${keys(row.clientId)} | ${keys(row.clientSecret)} |`;
}

/**
 * @description Render one Shape B row — a connector with no partner app to register, only a token
 * the user pastes, and the exact page the registry points them at to create it.
 * @param row - a token row
 * @returns the markdown table row
 */
function tokenLine(row: TokenRow): string {
  return `| ${cell(row.label)} (\`${row.id}\`) | ${row.tokenHelpUrl || '—'} |`;
}

/**
 * @description Footnotes that the table columns cannot carry: an OAuth connector that also accepts a
 * pasted token, and a Link connector whose platform credentials live in its own route module.
 * @param rows - the registration rows
 * @returns one markdown bullet per note, empty when there are none
 */
function registrationNotes(rows: RegistrationRow[]): string[] {
  const notes: string[] = [];
  for (const row of rows) {
    if (row.tokenFallbackUrl) {
      notes.push(`- **${row.label}** also accepts a pasted token when the OAuth client is not configured `
        + `(\`allowTokenFallback\`) — the user creates it at ${row.tokenFallbackUrl}.`);
    }
    if (row.linkCreds) {
      notes.push(`- **${row.label}** is a Link connector: \`providerCreds()\` resolves nothing for it, and its `
        + `platform app credentials are read by \`${row.linkCreds.fn}()\` in \`${row.linkCreds.file}\` from `
        + `${row.linkCreds.env.map((n) => `\`${n}\``).join(', ')}.`);
    }
  }
  return notes;
}

/**
 * @description Render the whole generated block, markers included. Every number in it is counted
 * from `PROVIDERS`; nothing is transcribed.
 * @returns the markdown block with LF line endings
 */
export function renderReferenceBlock(): string {
  const registration = registrationRows();
  const tokens = tokenRows();
  const total = registration.length + tokens.length;
  const lines = [
    BEGIN_MARKER,
    `<!-- Generated from ${REGISTRY_FILE}. Do not edit between these markers: run \`${REGEN_COMMAND}\`. -->`,
    '',
    `**${total} connectors are wired in the hub registry — ${registration.length} need a partner app`
      + ` registered (Shape A or Link) and ${tokens.length} are token-paste only (Shape B).**`,
    '',
    '### Needs a partner app — Shape A (OAuth redirect) and Link',
    '',
    'The redirect column is the path appended to `APP_URL`; the bracketed variable replaces the whole',
    'callback URI when it is set. The credential columns list the variables `providerCreds()` honours,',
    'highest precedence first (`→` reads "falls back to").',
    '',
    '| Provider (id) | Shape | Redirect path | Client id env | Client secret env |',
    '|---|---|---|---|---|',
    ...registration.map(registrationLine),
    '',
    ...registrationNotes(registration),
    '',
    '### No partner app — Shape B, Personal Access Token paste only',
    '',
    `These ${tokens.length} connectors have no OAuth app to register: the user pastes a token on`,
    '`/utilities` (or the operator sets the connector env fallback). The link is the page the registry',
    'sends them to (`tokenHelpUrl`).',
    '',
    '| Provider (id) | Where the user creates the token |',
    '|---|---|',
    ...tokens.map(tokenLine),
    '',
    END_MARKER,
  ];
  return lines.join('\n');
}

/**
 * @description Replace the generated block in a document with freshly rendered content.
 * @param doc - the document text
 * @param block - the rendered block, markers included
 * @returns the document with the block replaced
 */
export function spliceBlock(doc: string, block: string): string {
  const start = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${DOC_FILE} is missing the generated-block markers`);
  }
  return doc.slice(0, start) + block + doc.slice(end + END_MARKER.length);
}

/**
 * @description Whether a document already carries the block the registry renders. A document with no
 * markers reports drift with a reason rather than throwing, so the guard that gates this reports a
 * readable failure instead of an import-time crash.
 * @param doc - the document text, LF line endings
 * @param block - the rendered block, markers included
 * @returns the verdict, plus why when the markers are missing
 */
export function docIsCurrent(doc: string, block: string): { current: boolean; reason?: string } {
  try {
    return { current: spliceBlock(doc, block) === doc };
  } catch (error) {
    return { current: false, reason: (error as Error).message };
  }
}

/**
 * @description Compare the document on disk against a freshly rendered block.
 * @returns the drift verdict, the rendered block, and the document as read
 */
export function checkDoc(): { current: boolean; block: string; doc: string; reason?: string } {
  const block = renderReferenceBlock();
  const doc = readRepoFile(DOC_FILE).replace(/\r\n/g, '\n');
  return { ...docIsCurrent(doc, block), block, doc };
}
