/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from google-workspace-cli.js (1000-line cap decomposition): OAuth + service-account token plumbing, loopback auth-code flow, and the GoogleWorkspaceAuthManager profile store
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  sanitizeProfileName,
  ensureParentDirectory,
  base64UrlEncode,
  addQueryParams,
  readIntegerOption,
  readResponsePayload,
  stringifyErrorPayload,
} = require('./cli-utils');

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function normalizeOAuthTokenResponse(payload, refreshToken) {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || '',
    expiresAt: Date.now() + (Number(payload.expires_in || 3600) * 1000),
  };
}

function openBrowser(url) {
  const platform = process.platform;
  const commands = {
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '', url]],
    linux: ['xdg-open', [url]],
  };
  const [command, args] = commands[platform] || commands.linux;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', () => resolve(false));
    child.unref();
    resolve(true);
  });
}

/**
 * @description Builds a signed RS256 JWT assertion for the Google
 * service-account token grant, optionally impersonating a subject via
 * domain-wide delegation.
 * @param {object} params Assertion inputs.
 * @param {object} params.serviceAccount Parsed service-account JSON (client_email + private_key).
 * @param {string} [params.subject] Optional user to impersonate.
 * @param {string[]} params.scopes OAuth scopes to request.
 * @param {string} params.tokenUrl Token endpoint used as the JWT audience.
 * @returns {string} Signed JWT assertion string.
 */
function createServiceAccountAssertion({ serviceAccount, subject, scopes, tokenUrl }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: tokenUrl,
    exp: now + 3600,
    iat: now,
  };
  if (subject) {
    claimSet.sub = subject;
  }
  const payload = base64UrlEncode(JSON.stringify(claimSet));
  const unsignedToken = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function waitForAuthorizationCode({ authorizationUrl, redirectPort, state, timeoutMs, openBrowserRequested }) {
  const authCodePromise = new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url || '/', `http://127.0.0.1:${redirectPort}`);
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');

        if (state !== returnedState) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('State mismatch. You can close this window.');
          server.close();
          reject(new Error('OAuth state mismatch.'));
          return;
        }

        if (error) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`Google authorization failed: ${error}`));
          return;
        }

        if (!code) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Missing authorization code.');
          server.close();
          reject(new Error('Google authorization response did not include a code.'));
          return;
        }

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<html><body><h2>Google Workspace CLI authenticated successfully.</h2><p>You can close this window.</p></body></html>');
        server.close();
        resolve(code);
      } catch (error) {
        reject(error);
      }
    });

    server.on('error', reject);
    server.listen(redirectPort, '127.0.0.1', async () => {
      process.stderr.write(`Authorize this Google Workspace CLI profile by visiting:\n${authorizationUrl}\n`);
      if (openBrowserRequested) {
        await openBrowser(authorizationUrl);
      }
    });
  });

  const timeoutPromise = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for Google OAuth callback after ${timeoutMs}ms.`)), timeoutMs);
  });

  return Promise.race([authCodePromise, timeoutPromise]);
}

/**
 * @description Manages Google Workspace credentials for one named profile:
 * persists tokens to <home>/profiles/<profile>.json, refreshes OAuth access
 * tokens, exchanges service-account JWT assertions, runs the interactive PKCE
 * login, and revokes/clears stored tokens.
 */
class GoogleWorkspaceAuthManager {
  constructor(config) {
    this.config = config;
    this.profile = sanitizeProfileName(config.profile);
    this.homeDir = config.homeDir;
    this.profilePath = path.join(this.homeDir, 'profiles', `${this.profile}.json`);
  }

  isServiceAccountConfigured() {
    return Boolean(this.config.serviceAccount);
  }

  isOAuthConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  isConfigured() {
    return this.isServiceAccountConfigured() || this.isOAuthConfigured();
  }
  loadProfile() {
    if (!fs.existsSync(this.profilePath)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.profilePath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to parse Google Workspace profile store at ${this.profilePath}: ${error.message}`);
    }
  }

  saveProfile(profile) {
    ensureParentDirectory(this.profilePath);
    fs.writeFileSync(this.profilePath, JSON.stringify(profile, null, 2), 'utf8');
  }

  clearProfile() {
    if (fs.existsSync(this.profilePath)) {
      fs.rmSync(this.profilePath, { force: true });
    }
  }

  async getStatus() {
    const profile = this.loadProfile();
    const status = {
      profile: this.profile,
      homeDir: this.homeDir,
      profilePath: this.profilePath,
      configured: this.isConfigured(),
      mode: this.isServiceAccountConfigured() ? 'service_account' : 'oauth',
      scopeCount: this.config.scopes.length,
      scopes: this.config.scopes,
      authorized: false,
    };

    if (this.isServiceAccountConfigured()) {
      status.authorized = true;
      status.clientEmail = this.config.serviceAccount.client_email;
      status.subject = this.config.serviceAccountSubject || null;
      return status;
    }

    const tokens = profile.oauthTokens || {};
    status.hasRefreshToken = Boolean(tokens.refreshToken);
    status.hasAccessToken = Boolean(tokens.accessToken);
    status.expiresAt = tokens.expiresAt || null;
    status.authorized = Boolean(tokens.refreshToken || tokens.accessToken);
    return status;
  }

  async getAccessToken() {
    if (this.isServiceAccountConfigured()) {
      return this.getServiceAccountAccessToken();
    }
    return this.getOAuthAccessToken();
  }

  async getOAuthAccessToken() {
    if (!this.isOAuthConfigured()) {
      throw new Error('OAuth client credentials are not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
    }

    const profile = this.loadProfile();
    const tokens = profile.oauthTokens || {};
    if (tokens.accessToken && tokens.expiresAt && Number(tokens.expiresAt) > Date.now() + 60_000) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new Error(`No refresh token is stored for profile "${this.profile}". Run "oshal-google-workspace auth login" first.`);
    }

    const refreshed = await this.refreshOAuthToken(tokens.refreshToken);
    const nextProfile = {
      ...profile,
      oauthTokens: {
        ...tokens,
        ...refreshed,
      },
      updatedAt: new Date().toISOString(),
    };
    this.saveProfile(nextProfile);
    return refreshed.accessToken;
  }

  async refreshOAuthToken(refreshToken) {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch(this.config.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new Error(`Google OAuth token refresh failed (${response.status}): ${stringifyErrorPayload(payload)}`);
    }

    return normalizeOAuthTokenResponse(payload, refreshToken);
  }

  async getServiceAccountAccessToken() {
    const profile = this.loadProfile();
    const cached = profile.serviceAccountTokens || {};
    if (cached.accessToken && cached.expiresAt && Number(cached.expiresAt) > Date.now() + 60_000) {
      return cached.accessToken;
    }

    const assertion = createServiceAccountAssertion({
      serviceAccount: this.config.serviceAccount,
      subject: this.config.serviceAccountSubject,
      scopes: this.config.scopes,
      tokenUrl: this.config.endpoints.tokenUrl,
    });

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await fetch(this.config.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new Error(`Google service-account token exchange failed (${response.status}): ${stringifyErrorPayload(payload)}`);
    }

    const normalized = {
      accessToken: payload.access_token,
      tokenType: payload.token_type,
      expiresAt: Date.now() + (Number(payload.expires_in || 3600) * 1000),
      scope: payload.scope || this.config.scopes.join(' '),
    };

    this.saveProfile({
      ...profile,
      serviceAccountTokens: normalized,
      updatedAt: new Date().toISOString(),
    });

    return normalized.accessToken;
  }

  async loginInteractive(options = {}) {
    if (this.isServiceAccountConfigured()) {
      throw new Error('Service-account mode does not require interactive login.');
    }
    if (!this.isOAuthConfigured()) {
      throw new Error('OAuth client credentials are not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
    }

    const redirectPort = readIntegerOption(options.redirectPort, this.config.redirectPort);
    const redirectUri = `http://127.0.0.1:${redirectPort}/oauth2callback`;
    const state = base64UrlEncode(crypto.randomBytes(32));
    const codeVerifier = base64UrlEncode(crypto.randomBytes(48));
    const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
    const timeoutMs = readIntegerOption(options.timeoutMs, AUTH_TIMEOUT_MS);
    const loginHint = options.loginHint || this.config.accountEmail;

    const authorizationUrl = addQueryParams(this.config.endpoints.authUrl, {
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      login_hint: loginHint,
    });

    const code = await waitForAuthorizationCode({
      authorizationUrl,
      redirectPort,
      state,
      timeoutMs,
      openBrowserRequested: options.noOpen !== true,
    });

    const response = await fetch(this.config.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new Error(`Google OAuth code exchange failed (${response.status}): ${stringifyErrorPayload(payload)}`);
    }

    const normalized = normalizeOAuthTokenResponse(payload, payload.refresh_token);
    const profile = this.loadProfile();
    this.saveProfile({
      ...profile,
      oauthTokens: normalized,
      updatedAt: new Date().toISOString(),
      loginHint: loginHint || null,
    });

    return {
      profile: this.profile,
      mode: 'oauth',
      authorized: true,
      scopes: this.config.scopes,
      expiresAt: normalized.expiresAt,
      hasRefreshToken: Boolean(normalized.refreshToken),
    };
  }

  async revoke() {
    const profile = this.loadProfile();
    const token = profile?.oauthTokens?.refreshToken || profile?.oauthTokens?.accessToken;
    if (token) {
      const response = await fetch(this.config.endpoints.revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
      if (!response.ok) {
        const payload = await readResponsePayload(response);
        throw new Error(`Google token revoke failed (${response.status}): ${stringifyErrorPayload(payload)}`);
      }
    }

    this.clearProfile();
    return {
      profile: this.profile,
      revoked: Boolean(token),
      cleared: true,
    };
  }
}

module.exports = {
  AUTH_TIMEOUT_MS,
  GoogleWorkspaceAuthManager,
  createServiceAccountAssertion,
};
