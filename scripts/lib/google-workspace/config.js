/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from google-workspace-cli.js (1000-line cap decomposition): default scopes/endpoints, runtime config assembly from options+env, command aliases, and usage text
 */

const {
  resolveHomeDir,
  readStringOption,
  readIntegerOption,
  readArrayOption,
  coerceServiceAccountJson,
} = require('./cli-utils');

/**
 * @description Default Google Workspace OAuth scopes requested when neither
 * --scope options nor GOOGLE_SCOPES are provided.
 */
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/calendar',
];

/**
 * @description Default Google OAuth and per-service REST API base URLs; each is
 * individually overridable via env (used by the offline test suite to point at
 * a mock server).
 */
const DEFAULT_ENDPOINTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  gmailBaseUrl: 'https://gmail.googleapis.com',
  driveBaseUrl: 'https://www.googleapis.com/drive/v3',
  docsBaseUrl: 'https://docs.googleapis.com/v1',
  sheetsBaseUrl: 'https://sheets.googleapis.com/v4',
  slidesBaseUrl: 'https://slides.googleapis.com/v1',
  calendarBaseUrl: 'https://www.googleapis.com/calendar/v3',
};

const DEFAULT_REDIRECT_PORT = 8123;

/**
 * @description Builds the full runtime configuration for one CLI invocation by
 * layering parsed CLI options over environment variables and the defaults above
 * (profile, OAuth client, service account, scopes, endpoints).
 * @param {object} [options] Parsed CLI options.
 * @param {object} [env] Environment variable map (defaults to process.env).
 * @returns {object} Runtime config consumed by the auth manager and client.
 */
function buildRuntimeConfig(options = {}, env = process.env) {
  const scopes = readArrayOption(options.scope || options.scopes || env.GOOGLE_SCOPES);
  const homeDir = resolveHomeDir(options, env);
  return {
    homeDir,
    profile: readStringOption(options.profile)
      || readStringOption(env.GOG_ACCOUNT)
      || readStringOption(env.GOOGLE_ACCOUNT_EMAIL)
      || 'default',
    clientId: readStringOption(options.clientId) || readStringOption(env.GOOGLE_CLIENT_ID),
    clientSecret: readStringOption(options.clientSecret) || readStringOption(env.GOOGLE_CLIENT_SECRET),
    accountEmail: readStringOption(options.loginHint) || readStringOption(env.GOOGLE_ACCOUNT_EMAIL),
    redirectPort: readIntegerOption(options.redirectPort || env.GOOGLE_REDIRECT_PORT, DEFAULT_REDIRECT_PORT),
    serviceAccount: coerceServiceAccountJson(readStringOption(options.serviceAccountJson) || readStringOption(env.GOOGLE_SERVICE_ACCOUNT_JSON)),
    serviceAccountSubject: readStringOption(options.serviceAccountSubject) || readStringOption(env.GOOGLE_SERVICE_ACCOUNT_SUBJECT),
    scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES,
    endpoints: {
      authUrl: readStringOption(env.GOOGLE_OAUTH_AUTH_BASE_URL) || DEFAULT_ENDPOINTS.authUrl,
      tokenUrl: readStringOption(env.GOOGLE_OAUTH_TOKEN_URL) || DEFAULT_ENDPOINTS.tokenUrl,
      revokeUrl: readStringOption(env.GOOGLE_OAUTH_REVOKE_URL) || DEFAULT_ENDPOINTS.revokeUrl,
      gmailBaseUrl: readStringOption(env.GOOGLE_GMAIL_API_BASE_URL) || DEFAULT_ENDPOINTS.gmailBaseUrl,
      driveBaseUrl: readStringOption(env.GOOGLE_DRIVE_API_BASE_URL) || DEFAULT_ENDPOINTS.driveBaseUrl,
      docsBaseUrl: readStringOption(env.GOOGLE_DOCS_API_BASE_URL) || DEFAULT_ENDPOINTS.docsBaseUrl,
      sheetsBaseUrl: readStringOption(env.GOOGLE_SHEETS_API_BASE_URL) || DEFAULT_ENDPOINTS.sheetsBaseUrl,
      slidesBaseUrl: readStringOption(env.GOOGLE_SLIDES_API_BASE_URL) || DEFAULT_ENDPOINTS.slidesBaseUrl,
      calendarBaseUrl: readStringOption(env.GOOGLE_CALENDAR_API_BASE_URL) || DEFAULT_ENDPOINTS.calendarBaseUrl,
    },
  };
}

/**
 * @description Maps friendly command aliases (mail, excel, powerpoint, …) onto
 * their canonical service command names.
 * @param {string} command Raw command token from argv.
 * @returns {string} Canonical command name.
 */
function normalizeCommandAlias(command) {
  const aliases = {
    email: 'gmail',
    mail: 'gmail',
    excel: 'sheets',
    spreadsheet: 'sheets',
    powerpoint: 'slides',
    ppt: 'slides',
    presentation: 'slides',
  };
  return aliases[command] || command;
}

/**
 * @description Builds the multi-line usage/help text printed for the help
 * command and the bare invocation.
 * @returns {string} Usage text.
 */
function buildUsageText() {
  return [
    'oshal-google-workspace',
    '',
    'Repo-native Google Workspace CLI using official OAuth and REST APIs.',
    '',
    'Usage:',
    '  oshal-google-workspace version',
    '  oshal-google-workspace auth status [--json]',
    '  oshal-google-workspace auth login [--no-open] [--redirect-port 8123] [--profile work]',
    '  oshal-google-workspace auth revoke [--profile work]',
    '  oshal-google-workspace gmail list [--query "is:unread"] [--max-results 10] [--json]',
    '  oshal-google-workspace gmail get <messageId> [--format metadata|full] [--json]',
    '  oshal-google-workspace gmail send --to user@example.com --subject "Hello" --body "Message" [--json]',
    "  oshal-google-workspace drive list [--query \"mimeType contains 'folder'\"] [--json]",
    '  oshal-google-workspace drive export <fileId> --mime-type application/pdf --out output/report.pdf [--json]',
    '  oshal-google-workspace docs create --title "Notes" [--content "hello"] [--json]',
    '  oshal-google-workspace docs get <documentId> [--json]',
    '  oshal-google-workspace sheets create --title "Budget" [--json]',
    '  oshal-google-workspace sheets get <spreadsheetId> --range "Sheet1!A1:D10" [--json]',
    "  oshal-google-workspace sheets update <spreadsheetId> --range \"Sheet1!A1:B2\" --values '[[\"A\",\"B\"],[\"1\",\"2\"]]' [--json]",
    '  oshal-google-workspace slides create --title "Quarterly Review" [--json]',
    '  oshal-google-workspace slides get <presentationId> [--json]',
    '  oshal-google-workspace calendar list [--calendar-id primary] [--json]',
    '  oshal-google-workspace calendar create --summary "Meeting" --start 2026-04-01T10:00:00-05:00 --end 2026-04-01T11:00:00-05:00 [--json]',
    '  oshal-google-workspace api request --method GET --url https://www.googleapis.com/drive/v3/about?fields=user [--json]',
    '',
    'Aliases:',
    '  mail -> gmail, excel -> sheets, powerpoint -> slides',
    '',
    'Configuration:',
    '  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET for installed-app OAuth',
    '  GOOGLE_SERVICE_ACCOUNT_JSON and optional GOOGLE_SERVICE_ACCOUNT_SUBJECT for service-account mode',
    '  GOOGLE_ACCOUNT_EMAIL for login hint',
    '  GOG_ACCOUNT or --profile for the local token profile name',
    '  OSHAL_GOOGLE_WORKSPACE_HOME for token/config storage',
  ].join('\n');
}

module.exports = {
  DEFAULT_SCOPES,
  DEFAULT_ENDPOINTS,
  DEFAULT_REDIRECT_PORT,
  buildRuntimeConfig,
  normalizeCommandAlias,
  buildUsageText,
};
