/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from google-workspace-cli.js (1000-line cap decomposition): per-service command handlers (auth/gmail/drive/docs/sheets/slides/calendar/api) mapping positional actions + options onto client calls
 */

const {
  readBooleanOption,
  readIntegerOption,
  requireOption,
} = require('./cli-utils');

/**
 * @description Handles the `auth` command group (status | login | logout/revoke)
 * against the profile-scoped auth manager.
 * @param {object} auth GoogleWorkspaceAuthManager instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleAuthCommand(auth, positional, options) {
  const action = positional[0] || 'status';
  switch (action) {
    case 'status':
      return auth.getStatus();
    case 'login':
      return auth.loginInteractive({
        noOpen: readBooleanOption(options.noOpen) === true,
        redirectPort: options.redirectPort,
        timeoutMs: options.timeoutMs,
        loginHint: options.loginHint,
      });
    case 'logout':
    case 'revoke':
      return auth.revoke();
    default:
      throw new Error(`Unknown auth action "${action}".`);
  }
}

/**
 * @description Handles the `gmail` command group (list/search | get | send).
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleGmailCommand(client, positional, options) {
  const action = positional[0] || 'list';
  if (action === 'list' || action === 'search') {
    return client.gmailList({
      query: options.query || options.q,
      maxResults: readIntegerOption(options.maxResults, 10),
      includeSpamTrash: readBooleanOption(options.includeSpamTrash) === true,
      labelId: options.labelId,
    });
  }
  if (action === 'get') {
    return client.gmailGet(requireOption(positional[1], 'messageId'), {
      format: options.format,
    });
  }
  if (action === 'send') {
    return client.gmailSend({
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      bodyFile: options.bodyFile,
    });
  }
  throw new Error(`Unknown Gmail action "${action}".`);
}

/**
 * @description Handles the `drive` command group (list/search | download | export).
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleDriveCommand(client, positional, options) {
  const action = positional[0] || 'list';
  if (action === 'list' || action === 'search') {
    return client.driveList({
      query: options.query || options.q,
      pageSize: readIntegerOption(options.pageSize || options.maxResults, 20),
    });
  }
  if (action === 'download') {
    return client.driveDownload(requireOption(positional[1], 'fileId'), {
      out: options.out,
    });
  }
  if (action === 'export') {
    return client.driveExport(requireOption(positional[1], 'fileId'), {
      mimeType: options.mimeType,
      out: options.out,
    });
  }
  throw new Error(`Unknown Drive action "${action}".`);
}

/**
 * @description Handles the `docs` command group (create | get).
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleDocsCommand(client, positional, options) {
  const action = positional[0] || 'get';
  if (action === 'create') {
    return client.docsCreate({
      title: options.title,
      content: options.content,
    });
  }
  if (action === 'get') {
    return client.docsGet(requireOption(positional[1], 'documentId'));
  }
  throw new Error(`Unknown Docs action "${action}".`);
}

/**
 * @description Handles the `sheets` command group (create | get | update).
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleSheetsCommand(client, positional, options) {
  const action = positional[0] || 'get';
  if (action === 'create') {
    return client.sheetsCreate({
      title: options.title,
    });
  }
  if (action === 'get') {
    return client.sheetsGet(requireOption(positional[1], 'spreadsheetId'), {
      range: options.range,
    });
  }
  if (action === 'update') {
    return client.sheetsUpdate(requireOption(positional[1], 'spreadsheetId'), {
      range: options.range,
      values: options.values,
      valueInputOption: options.valueInputOption,
    });
  }
  throw new Error(`Unknown Sheets action "${action}".`);
}

/**
 * @description Handles the `slides` command group (create | get).
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleSlidesCommand(client, positional, options) {
  const action = positional[0] || 'get';
  if (action === 'create') {
    return client.slidesCreate({
      title: options.title,
    });
  }
  if (action === 'get') {
    return client.slidesGet(requireOption(positional[1], 'presentationId'));
  }
  throw new Error(`Unknown Slides action "${action}".`);
}

/**
 * @description Handles the `calendar` command group (list | create).
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleCalendarCommand(client, positional, options) {
  const action = positional[0] || 'list';
  if (action === 'list') {
    return client.calendarList({
      calendarId: options.calendarId,
      timeMin: options.timeMin,
      timeMax: options.timeMax,
      maxResults: readIntegerOption(options.maxResults, 20),
    });
  }
  if (action === 'create') {
    return client.calendarCreate({
      calendarId: options.calendarId,
      summary: options.summary,
      description: options.description,
      start: options.start,
      end: options.end,
    });
  }
  throw new Error(`Unknown Calendar action "${action}".`);
}

/**
 * @description Handles the `api` command group — a raw authenticated request
 * escape hatch for endpoints without a dedicated subcommand.
 * @param {object} client GoogleWorkspaceClient instance.
 * @param {string[]} positional Positional args after the command token.
 * @param {object} options Parsed CLI options.
 * @returns {Promise<object>} Command result payload.
 */
async function handleApiCommand(client, positional, options) {
  const action = positional[0] || 'request';
  if (action !== 'request') {
    throw new Error(`Unknown API action "${action}".`);
  }
  return client.apiRequest({
    method: options.method,
    url: options.url,
    body: options.body,
  });
}

module.exports = {
  handleAuthCommand,
  handleGmailCommand,
  handleDriveCommand,
  handleDocsCommand,
  handleSheetsCommand,
  handleSlidesCommand,
  handleCalendarCommand,
  handleApiCommand,
};
