const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { runCli } = require('../scripts/google-workspace-cli.js');

const registeredTests = [];

function test(name, fn) {
  registeredTests.push({ name, fn });
}

function createCaptureStream() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
      return true;
    },
    read() {
      return value;
    },
  };
}

function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-google-workspace-'));
  const profilePath = path.join(homeDir, 'profiles', 'default.json');
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify({
    oauthTokens: {
      refreshToken: 'refresh-token-1',
    },
  }, null, 2), 'utf8');
  return homeDir;
}

async function startMockGoogleServer(routes) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      headers: req.headers,
    });

    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Unhandled route ${key}` }));
      return;
    }

    const result = await handler({ req, res, url, body, requests });
    if (res.writableEnded) {
      return;
    }

    const statusCode = result?.statusCode || 200;
    const headers = result?.headers || { 'content-type': 'application/json' };
    const payload = result?.raw === true
      ? result.body
      : JSON.stringify(result?.body ?? {});

    res.writeHead(statusCode, headers);
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function buildEnv(baseUrl, homeDir) {
  return {
    ...process.env,
    OSHAL_GOOGLE_WORKSPACE_HOME: homeDir,
    GOOGLE_CLIENT_ID: 'client-id-1',
    GOOGLE_CLIENT_SECRET: 'client-secret-1',
    GOOGLE_OAUTH_TOKEN_URL: `${baseUrl}/token`,
    GOOGLE_GMAIL_API_BASE_URL: baseUrl,
    GOOGLE_DRIVE_API_BASE_URL: `${baseUrl}/drive/v3`,
    GOOGLE_DOCS_API_BASE_URL: `${baseUrl}/v1`,
    GOOGLE_SHEETS_API_BASE_URL: `${baseUrl}/v4`,
    GOOGLE_SLIDES_API_BASE_URL: `${baseUrl}/v1`,
    GOOGLE_CALENDAR_API_BASE_URL: `${baseUrl}/calendar/v3`,
  };
}

async function readRequestBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

function parseJsonOutput(stream) {
  return JSON.parse(stream.read().trim());
}

test('gmail list uses refresh-token auth and resolves metadata for inbox checks', async () => {
  const server = await startMockGoogleServer({
    'POST /token': async ({ body }) => {
      assert.match(body, /grant_type=refresh_token/);
      return {
        body: {
          access_token: 'access-token-1',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      };
    },
    'GET /gmail/v1/users/me/messages': async ({ url, req }) => {
      assert.equal(req.headers.authorization, 'Bearer access-token-1');
      assert.equal(url.searchParams.get('q'), 'is:unread');
      return {
        body: {
          resultSizeEstimate: 1,
          messages: [{ id: 'msg-1', threadId: 'thread-1' }],
        },
      };
    },
    'GET /gmail/v1/users/me/messages/msg-1': async ({ req }) => {
      assert.equal(req.headers.authorization, 'Bearer access-token-1');
      return {
        body: {
          id: 'msg-1',
          threadId: 'thread-1',
          labelIds: ['INBOX', 'UNREAD'],
          snippet: 'Please review the quarterly plan.',
          payload: {
            headers: [
              { name: 'From', value: 'Boss <boss@example.com>' },
              { name: 'Subject', value: 'Quarterly plan' },
              { name: 'Date', value: 'Tue, 31 Mar 2026 10:00:00 -0500' },
            ],
          },
        },
      };
    },
  });

  try {
    const stdout = createCaptureStream();
    await runCli(['gmail', 'list', '--query', 'is:unread', '--json'], {
      env: buildEnv(server.baseUrl, createTempHome()),
      stdout,
    });

    const payload = parseJsonOutput(stdout);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].subject, 'Quarterly plan');
    assert.equal(payload.messages[0].from, 'Boss <boss@example.com>');
  } finally {
    await server.close();
  }
});

test('docs create issues create and batchUpdate calls', async () => {
  const server = await startMockGoogleServer({
    'POST /token': async () => ({
      body: {
        access_token: 'access-token-2',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    }),
    'POST /v1/documents': async ({ body }) => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.title, 'Meeting Notes');
      return {
        body: {
          documentId: 'doc-1',
          title: 'Meeting Notes',
        },
      };
    },
    'POST /v1/documents/doc-1:batchUpdate': async ({ body }) => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.requests[0].insertText.text, 'Hello team');
      return {
        body: { documentId: 'doc-1' },
      };
    },
  });

  try {
    const stdout = createCaptureStream();
    await runCli(['docs', 'create', '--title', 'Meeting Notes', '--content', 'Hello team', '--json'], {
      env: buildEnv(server.baseUrl, createTempHome()),
      stdout,
    });

    const payload = parseJsonOutput(stdout);
    assert.equal(payload.documentId, 'doc-1');
    assert.match(payload.documentUrl, /docs\.google\.com/);
  } finally {
    await server.close();
  }
});

test('sheets update sends USER_ENTERED values payload', async () => {
  const server = await startMockGoogleServer({
    'POST /token': async () => ({
      body: {
        access_token: 'access-token-3',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    }),
    'PUT /v4/spreadsheets/sheet-1/values/Sheet1!A1%3AB2': async ({ url, body }) => {
      assert.equal(url.searchParams.get('valueInputOption'), 'USER_ENTERED');
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed.values, [['A', 'B'], ['1', '2']]);
      return {
        body: {
          updatedRange: 'Sheet1!A1:B2',
          updatedRows: 2,
        },
      };
    },
  });

  try {
    const stdout = createCaptureStream();
    await runCli(['sheets', 'update', 'sheet-1', '--range', 'Sheet1!A1:B2', '--values', '[["A","B"],["1","2"]]', '--json'], {
      env: buildEnv(server.baseUrl, createTempHome()),
      stdout,
    });

    const payload = parseJsonOutput(stdout);
    assert.equal(payload.updatedRange, 'Sheet1!A1:B2');
    assert.equal(payload.updatedRows, 2);
  } finally {
    await server.close();
  }
});

test('slides create returns presentation summary', async () => {
  const server = await startMockGoogleServer({
    'POST /token': async () => ({
      body: {
        access_token: 'access-token-4',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    }),
    'POST /v1/presentations': async ({ body }) => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.title, 'Quarterly Review');
      return {
        body: {
          presentationId: 'deck-1',
          title: 'Quarterly Review',
          slides: [{ objectId: 'slide-1', slideProperties: { layoutObjectId: 'layout-1' } }],
        },
      };
    },
  });

  try {
    const stdout = createCaptureStream();
    await runCli(['slides', 'create', '--title', 'Quarterly Review', '--json'], {
      env: buildEnv(server.baseUrl, createTempHome()),
      stdout,
    });

    const payload = parseJsonOutput(stdout);
    assert.equal(payload.presentationId, 'deck-1');
    assert.equal(payload.slideCount, 1);
  } finally {
    await server.close();
  }
});

test('drive export writes the exported file to disk', async () => {
  const server = await startMockGoogleServer({
    'POST /token': async () => ({
      body: {
        access_token: 'access-token-5',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    }),
    'GET /drive/v3/files/file-1/export': async ({ url }) => {
      assert.equal(url.searchParams.get('mimeType'), 'application/pdf');
      return {
        raw: true,
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from('PDF-DATA', 'utf8'),
      };
    },
  });

  try {
    const homeDir = createTempHome();
    const outputPath = path.join(homeDir, 'exports', 'doc.pdf');
    const stdout = createCaptureStream();
    await runCli(['drive', 'export', 'file-1', '--mime-type', 'application/pdf', '--out', outputPath, '--json'], {
      env: buildEnv(server.baseUrl, homeDir),
      stdout,
    });

    const payload = parseJsonOutput(stdout);
    assert.equal(payload.outputPath, outputPath);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'PDF-DATA');
  } finally {
    await server.close();
  }
});

test('calendar list returns items for scheduling workflows', async () => {
  const server = await startMockGoogleServer({
    'POST /token': async () => ({
      body: {
        access_token: 'access-token-6',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    }),
    'GET /calendar/v3/calendars/primary/events': async () => ({
      body: {
        items: [
          {
            id: 'event-1',
            summary: 'Planning Session',
            start: { dateTime: '2026-04-01T10:00:00-05:00' },
            end: { dateTime: '2026-04-01T11:00:00-05:00' },
          },
        ],
      },
    }),
  });

  try {
    const stdout = createCaptureStream();
    await runCli(['calendar', 'list', '--calendar-id', 'primary', '--json'], {
      env: buildEnv(server.baseUrl, createTempHome()),
      stdout,
    });

    const payload = parseJsonOutput(stdout);
    assert.equal(payload.items[0].summary, 'Planning Session');
  } finally {
    await server.close();
  }
});

async function runAllTests() {
  for (const entry of registeredTests) {
    await entry.fn();
    process.stdout.write(`ok - ${entry.name}\n`);
  }
}

if (require.main === module) {
  runAllTests().catch((error) => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runAllTests,
};
