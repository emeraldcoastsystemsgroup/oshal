/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from google-workspace-cli.js (1000-line cap decomposition): the authenticated GoogleWorkspaceClient (Gmail/Drive/Docs/Sheets/Slides/Calendar REST calls) plus message/document/presentation extraction helpers
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  joinUrl,
  addQueryParams,
  readResponsePayload,
  stringifyErrorPayload,
  requireOption,
  readStringOption,
  parseJsonInput,
  ensureParentDirectory,
  base64UrlEncode,
  base64UrlDecode,
} = require('./cli-utils');

/**
 * @description Authenticated Google Workspace REST client. Wraps fetch with
 * bearer-token injection from the auth manager and exposes one method per CLI
 * operation (Gmail list/get/send, Drive list/download/export, Docs, Sheets,
 * Slides, Calendar, and a raw api request escape hatch).
 */
class GoogleWorkspaceClient {
  constructor(config) {
    this.config = config;
    this.auth = config.auth;
  }

  async request(options) {
    const accessToken = await this.auth.getAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    };

    let body = options.body;
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(addQueryParams(options.url, options.query), {
      method: options.method || 'GET',
      headers,
      body,
    });

    if (options.raw === true) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        throw new Error(`Google API request failed (${response.status}): ${buffer.toString('utf8')}`);
      }
      return buffer;
    }

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new Error(`Google API request failed (${response.status}): ${stringifyErrorPayload(payload)}`);
    }
    return payload;
  }

  async gmailList(options = {}) {
    const list = await this.request({
      url: joinUrl(this.config.endpoints.gmailBaseUrl, '/gmail/v1/users/me/messages'),
      query: {
        q: options.query,
        maxResults: options.maxResults || 10,
        includeSpamTrash: options.includeSpamTrash === true ? 'true' : undefined,
        labelIds: options.labelId ? [options.labelId] : undefined,
      },
    });

    const messages = Array.isArray(list.messages) ? list.messages : [];
    const detailedMessages = [];
    for (const message of messages) {
      // Metadata calls keep list output useful for "check mail" workflows.
      // eslint-disable-next-line no-await-in-loop
      const detail = await this.gmailGet(message.id, { format: 'metadata' });
      detailedMessages.push(detail);
    }

    return {
      resultSizeEstimate: list.resultSizeEstimate || detailedMessages.length,
      nextPageToken: list.nextPageToken || null,
      messages: detailedMessages,
    };
  }

  async gmailGet(messageId, options = {}) {
    const format = options.format || 'full';
    const payload = await this.request({
      url: joinUrl(this.config.endpoints.gmailBaseUrl, `/gmail/v1/users/me/messages/${messageId}`),
      query: {
        format,
        metadataHeaders: format === 'metadata' ? ['From', 'To', 'Subject', 'Date'] : undefined,
      },
    });

    const headers = mapGmailHeaders(payload.payload?.headers || []);
    return {
      id: payload.id,
      threadId: payload.threadId,
      labelIds: payload.labelIds || [],
      snippet: payload.snippet || '',
      subject: headers.subject || '',
      from: headers.from || '',
      to: headers.to || '',
      date: headers.date || '',
      text: extractGmailText(payload.payload),
      historyId: payload.historyId || null,
      internalDate: payload.internalDate || null,
      sizeEstimate: payload.sizeEstimate || null,
    };
  }

  async gmailSend(options) {
    const to = requireOption(options.to, 'to');
    const subject = requireOption(options.subject, 'subject');
    const body = options.bodyFile
      ? fs.readFileSync(path.resolve(options.bodyFile), 'utf8')
      : requireOption(options.body, 'body');

    const mimeLines = [
      `To: ${to}`,
      options.cc ? `Cc: ${options.cc}` : null,
      options.bcc ? `Bcc: ${options.bcc}` : null,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].filter((line) => line !== null);

    return this.request({
      method: 'POST',
      url: joinUrl(this.config.endpoints.gmailBaseUrl, '/gmail/v1/users/me/messages/send'),
      body: { raw: base64UrlEncode(mimeLines.join('\r\n')) },
    });
  }

  async driveList(options = {}) {
    return this.request({
      url: joinUrl(this.config.endpoints.driveBaseUrl, '/files'),
      query: {
        q: options.query,
        pageSize: options.pageSize || 20,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken',
      },
    });
  }

  async driveDownload(fileId, options = {}) {
    const buffer = await this.request({
      url: joinUrl(this.config.endpoints.driveBaseUrl, `/files/${fileId}`),
      query: { alt: 'media' },
      raw: true,
    });
    const outputPath = options.out ? path.resolve(options.out) : null;
    if (outputPath) {
      ensureParentDirectory(outputPath);
      fs.writeFileSync(outputPath, buffer);
    }
    return {
      fileId,
      bytes: buffer.length,
      outputPath,
    };
  }

  async driveExport(fileId, options = {}) {
    const mimeType = requireOption(options.mimeType, 'mimeType');
    const buffer = await this.request({
      url: joinUrl(this.config.endpoints.driveBaseUrl, `/files/${fileId}/export`),
      query: { mimeType },
      raw: true,
    });
    const outputPath = options.out ? path.resolve(options.out) : null;
    if (outputPath) {
      ensureParentDirectory(outputPath);
      fs.writeFileSync(outputPath, buffer);
    }
    return {
      fileId,
      mimeType,
      bytes: buffer.length,
      outputPath,
    };
  }

  async docsCreate(options = {}) {
    const title = requireOption(options.title, 'title');
    const document = await this.request({
      method: 'POST',
      url: joinUrl(this.config.endpoints.docsBaseUrl, '/documents'),
      body: { title },
    });

    if (readStringOption(options.content)) {
      await this.request({
        method: 'POST',
        url: joinUrl(this.config.endpoints.docsBaseUrl, `/documents/${document.documentId}:batchUpdate`),
        body: {
          requests: [
            {
              insertText: {
                endOfSegmentLocation: {},
                text: options.content,
              },
            },
          ],
        },
      });
    }

    return {
      documentId: document.documentId,
      title: document.title,
      documentUrl: `https://docs.google.com/document/d/${document.documentId}/edit`,
    };
  }

  async docsGet(documentId) {
    const document = await this.request({
      url: joinUrl(this.config.endpoints.docsBaseUrl, `/documents/${documentId}`),
    });

    return {
      documentId: document.documentId,
      title: document.title,
      revisionId: document.revisionId || null,
      text: extractDocumentText(document),
    };
  }

  async sheetsCreate(options = {}) {
    const title = requireOption(options.title, 'title');
    const spreadsheet = await this.request({
      method: 'POST',
      url: joinUrl(this.config.endpoints.sheetsBaseUrl, '/spreadsheets'),
      body: { properties: { title } },
    });

    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      title: spreadsheet.properties?.title || title,
      spreadsheetUrl: spreadsheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheet.spreadsheetId}/edit`,
    };
  }

  async sheetsGet(spreadsheetId, options = {}) {
    const range = readStringOption(options.range) || 'A1:Z50';
    return this.request({
      url: joinUrl(this.config.endpoints.sheetsBaseUrl, `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`),
    });
  }

  async sheetsUpdate(spreadsheetId, options = {}) {
    const range = requireOption(options.range, 'range');
    const values = typeof options.values === 'string'
      ? parseJsonInput(options.values, 'values')
      : options.values;
    if (!Array.isArray(values)) {
      throw new Error('Option "values" must parse to a two-dimensional array.');
    }

    return this.request({
      method: 'PUT',
      url: joinUrl(this.config.endpoints.sheetsBaseUrl, `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`),
      query: {
        valueInputOption: readStringOption(options.valueInputOption) || 'USER_ENTERED',
        includeValuesInResponse: 'true',
      },
      body: { range, majorDimension: 'ROWS', values },
    });
  }

  async slidesCreate(options = {}) {
    const title = requireOption(options.title, 'title');
    const presentation = await this.request({
      method: 'POST',
      url: joinUrl(this.config.endpoints.slidesBaseUrl, '/presentations'),
      body: { title },
    });

    return summarizePresentation(presentation);
  }

  async slidesGet(presentationId) {
    const presentation = await this.request({
      url: joinUrl(this.config.endpoints.slidesBaseUrl, `/presentations/${presentationId}`),
    });
    return summarizePresentation(presentation);
  }

  async calendarList(options = {}) {
    const calendarId = readStringOption(options.calendarId) || 'primary';
    const now = new Date();
    const timeMin = readStringOption(options.timeMin) || now.toISOString();
    const timeMax = readStringOption(options.timeMax)
      || new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000)).toISOString();

    return this.request({
      url: joinUrl(this.config.endpoints.calendarBaseUrl, `/calendars/${encodeURIComponent(calendarId)}/events`),
      query: {
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: options.maxResults || 20,
      },
    });
  }

  async calendarCreate(options = {}) {
    const calendarId = readStringOption(options.calendarId) || 'primary';
    const summary = requireOption(options.summary, 'summary');
    const start = requireOption(options.start, 'start');
    const end = requireOption(options.end, 'end');

    return this.request({
      method: 'POST',
      url: joinUrl(this.config.endpoints.calendarBaseUrl, `/calendars/${encodeURIComponent(calendarId)}/events`),
      body: {
        summary,
        description: readStringOption(options.description),
        start: { dateTime: start },
        end: { dateTime: end },
      },
    });
  }

  async apiRequest(options = {}) {
    const url = requireOption(options.url, 'url');
    const method = readStringOption(options.method) || 'GET';
    const body = readStringOption(options.body) ? parseJsonInput(options.body, 'body') : undefined;
    return this.request({
      method,
      url,
      body,
    });
  }
}

function mapGmailHeaders(headers) {
  const result = {};
  for (const header of headers) {
    if (!header || !header.name) {
      continue;
    }
    result[String(header.name).toLowerCase()] = header.value || '';
  }
  return result;
}

/**
 * @description Extracts the best-effort plain-text body from a Gmail message
 * payload, preferring text/plain parts and recursing through multipart trees.
 * @param {object} payload Gmail API message payload node.
 * @returns {string} Decoded message text (empty string when none found).
 */
function extractGmailText(payload) {
  if (!payload) {
    return '';
  }
  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return base64UrlDecode(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = extractGmailText(part);
      if (text) {
        return text;
      }
    }
  }
  if (payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }
  return '';
}

/**
 * @description Flattens a Google Docs document body (paragraphs, tables, table
 * of contents) into a single trimmed text string.
 * @param {object} document Google Docs API document resource.
 * @returns {string} Concatenated document text.
 */
function extractDocumentText(document) {
  const chunks = [];

  function visitStructuralElements(elements) {
    for (const element of elements || []) {
      if (element.paragraph?.elements) {
        for (const paragraphElement of element.paragraph.elements) {
          if (paragraphElement.textRun?.content) {
            chunks.push(paragraphElement.textRun.content);
          }
        }
      }
      if (element.table?.tableRows) {
        for (const row of element.table.tableRows) {
          for (const cell of row.tableCells || []) {
            visitStructuralElements(cell.content || []);
          }
        }
      }
      if (element.tableOfContents?.content) {
        visitStructuralElements(element.tableOfContents.content);
      }
    }
  }

  visitStructuralElements(document.body?.content || []);
  return chunks.join('').trim();
}

function summarizePresentation(presentation) {
  return {
    presentationId: presentation.presentationId,
    title: presentation.title || '',
    slideCount: Array.isArray(presentation.slides) ? presentation.slides.length : 0,
    slides: Array.isArray(presentation.slides)
      ? presentation.slides.map((slide) => ({
        objectId: slide.objectId,
        layout: slide.slideProperties?.layoutObjectId || null,
      }))
      : [],
    presentationUrl: presentation.presentationId
      ? `https://docs.google.com/presentation/d/${presentation.presentationId}/edit`
      : null,
  };
}

module.exports = {
  GoogleWorkspaceClient,
  extractGmailText,
  extractDocumentText,
};
