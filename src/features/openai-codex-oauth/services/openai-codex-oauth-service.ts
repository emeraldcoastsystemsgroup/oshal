/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Resolved encrypted-config-manager module path across repo-root tests, ts-node source runs, and compiled container runtime layouts
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bound OAuth redirect URIs to the initiating request origin and persisted redirectUri with pending state so callbacks return to the same runtime that started auth
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Mirrored OpenAI Codex OAuth credentials into the shared swarm config seed so Docker workers can consume the same login after callback completion
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Changed default OpenAI Codex redirect URI to /auth/callback for compatibility with upstream Cline OAuth flow
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of OpenAI Codex OAuth service with PKCE, token exchange, refresh, and encrypted credential persistence
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Aligned default OpenAI Codex redirect URI to localhost:1455 callback and added APP_URL host derivation with callback-port override support
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Returned callback user id from completeAuthorization to enable centralized save-time runtime credential sync
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis pub/sub broadcast for OpenAI Codex credentials — bot containers auto-import on auth callback without relying on Windows bind mount propagation
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Gate swarm-wide credential propagation (shared config-seed mirror + Redis broadcast) to OPERATORS ONLY. Per-user encrypted storage is unchanged and always runs; only the platform-default mirror is restricted. Previously ANY authenticated user's Codex import overwrote /app/config-seed/secrets.json (the api inline/default codex credential), so a guest's ChatGPT plan became the platform default — a billing/abuse hole once a deployment has >1 user. A single-operator local swarm still propagates (operator is on the allowlist).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'openai-codex-oauth-service' });

const OPENAI_CODEX_AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const OPENAI_CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_CODEX_SCOPES = 'openid profile email offline_access';
const OPENAI_CODEX_CREDENTIALS_KEY = 'openAiCodexOauthCredentials';
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface PendingAuthorization {
  codeVerifier: string;
  redirectUri: string;
  userId: string;
  expiresAt: number;
}

interface OpenAiCodexCredentials {
  type: 'openai-codex';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  email?: string;
  accountId?: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  email?: string;
}

interface OpenAiCodexAuthorizationResult {
  userId: string;
  credentials: OpenAiCodexCredentials;
}

interface SecretsManagerLike {
  loadSecrets(userId?: string | null): Record<string, unknown>;
  saveSecrets(secretsData: Record<string, unknown>, userId?: string | null): void;
}

/**
 * @description Service that implements OpenAI Codex OAuth with PKCE for the OSHAL settings UI.
 * Handles authorization URL generation, callback token exchange, token refresh, and credential storage.
 */
export class OpenAiCodexOAuthService {
  private pendingAuthorizations: Map<string, PendingAuthorization>;
  private secretsManager: SecretsManagerLike;
  private clientId: string;
  private redirectUri: string;

  /**
   * @description Constructs the OpenAI Codex OAuth service with environment-aware configuration.
   * @param configOutputDir - Directory where settings and encrypted secrets are persisted
   * @param encryptionKey - Optional encryption key for secrets-at-rest
   * @returns New OpenAiCodexOAuthService instance
   */
  constructor(
    configOutputDir: string = process.env.CONFIG_OUTPUT_DIR || './output',
    encryptionKey: string | null = process.env.ENCRYPTION_KEY || null,
  ) {
    this.pendingAuthorizations = new Map<string, PendingAuthorization>();
    this.secretsManager = this.createSecretsManager(configOutputDir, encryptionKey);
    this.clientId = process.env.OPENAI_CODEX_CLIENT_ID || OPENAI_CODEX_DEFAULT_CLIENT_ID;
    this.redirectUri = this.resolveRedirectUri();

    logger.info(
      {
        configOutputDir,
        hasEncryptionKey: !!encryptionKey,
        redirectUri: this.redirectUri,
      },
      'OpenAI Codex OAuth service initialized',
    );
  }

  /**
   * @description Creates a new PKCE authorization URL and stores pending state for callback validation.
   * @param userId - Authenticated OSHAL user identifier used for per-user credential persistence
   * @returns Authorization URL that the browser should open for OpenAI account sign-in
   */
  startAuthorization(userId: string): string {
    const startedAt = Date.now();
    logger.info({ userId }, 'Starting OpenAI Codex authorization flow');

    this.pruneExpiredAuthorizations();

    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);
    const state = this.generateState();
    const redirectUri = this.resolveAuthorizationRedirectUri();

    this.pendingAuthorizations.set(state, {
      codeVerifier,
      redirectUri,
      userId,
      expiresAt: startedAt + AUTHORIZATION_TTL_MS,
    });

    const authUrl = this.buildAuthorizationUrl(codeChallenge, state, redirectUri);
    logger.info({ userId, durationMs: Date.now() - startedAt, redirectUri }, 'OpenAI Codex authorization URL generated');
    return authUrl;
  }

  /**
   * @description Completes the OAuth callback by validating state, exchanging code for tokens, and saving credentials.
   * @param state - OAuth state parameter returned from OpenAI
   * @param code - OAuth authorization code returned from OpenAI
   * @returns Callback result containing persisted credentials and authenticated user id
   */
  async completeAuthorization(state: string, code: string): Promise<OpenAiCodexAuthorizationResult> {
    const startedAt = Date.now();
    logger.info({ stateLength: state.length }, 'Completing OpenAI Codex authorization flow');

    const pending = this.pendingAuthorizations.get(state);
    if (!pending) {
      logger.warn({ stateLength: state.length }, 'OpenAI Codex callback state not found');
      throw new Error('Invalid or expired OAuth state');
    }

    this.pendingAuthorizations.delete(state);

    if (Date.now() > pending.expiresAt) {
      logger.warn({ userId: pending.userId }, 'OpenAI Codex callback state expired');
      throw new Error('OAuth authorization request expired');
    }

    const tokenResponse = await this.exchangeAuthorizationCode(code, pending.codeVerifier, pending.redirectUri);
    const credentials = this.buildCredentials(tokenResponse);
    this.writeCredentials(pending.userId, credentials);

    logger.info(
      {
        userId: pending.userId,
        durationMs: Date.now() - startedAt,
        expiresAt: credentials.expiresAt,
      },
      'OpenAI Codex authorization flow completed',
    );

    return {
      userId: pending.userId,
      credentials,
    };
  }

  /**
   * @description Returns a valid access token for the user, refreshing if expired.
   * Used by lightweight API calls that need the OAuth token without Cline CLI overhead.
   * @param userId - Authenticated OSHAL user identifier
   * @returns Access token string, or null if not authenticated
   */
  async getAccessToken(userId: string): Promise<string | null> {
    const stored = this.readCredentials(userId);
    if (!stored) return null;
    const active = this.isTokenExpired(stored) ? await this.refreshCredentials(stored) : stored;
    if (!active) return null;
    if (active !== stored) this.writeCredentials(userId, active);
    return active.accessToken;
  }

  /**
   * @description Returns the current OpenAI Codex OAuth status for a user and refreshes tokens when needed.
   * @param userId - Authenticated OSHAL user identifier
   * @returns Authentication status with optional account metadata and expiry details
   */
  async getStatus(userId: string): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    logger.info({ userId }, 'Loading OpenAI Codex OAuth status');

    try {
      const stored = this.readCredentials(userId);
      if (!stored) {
        logger.info({ userId, durationMs: Date.now() - startedAt }, 'No OpenAI Codex credentials found');
        return { authenticated: false };
      }

      const activeCredentials = this.isTokenExpired(stored)
        ? await this.refreshCredentials(stored)
        : stored;

      if (!activeCredentials) {
        this.deleteCredentials(userId);
        logger.warn({ userId }, 'OpenAI Codex credentials expired and refresh failed');
        return { authenticated: false };
      }

      this.writeCredentials(userId, activeCredentials);
      logger.info({ userId, durationMs: Date.now() - startedAt }, 'OpenAI Codex OAuth status loaded');

      return {
        authenticated: true,
        email: activeCredentials.email || null,
        accountId: activeCredentials.accountId || null,
        expiresAt: activeCredentials.expiresAt,
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to load OpenAI Codex OAuth status');
      return { authenticated: false };
    }
  }

  /**
   * @description Deletes stored OpenAI Codex OAuth credentials for a user.
   * @param userId - Authenticated OSHAL user identifier
   * @returns Void when sign-out persistence is complete
   */
  signOut(userId: string): void {
    logger.info({ userId }, 'Signing out OpenAI Codex credentials');
    this.deleteCredentials(userId);
  }

  /**
   * @description Imports credentials directly from a `codex login` artifact, bypassing the
   * localhost:1455 OAuth redirect that only completes when the Codex CLI / remote client is
   * running on the same machine as the browser. Hosted users paste/upload the `~/.codex/auth.json`
   * that the CLI already wrote (Windows: `C:\\Users\\<you>\\.codex\\auth.json`).
   *
   * Accepts the native CLI shape (`{ tokens: { access_token, refresh_token, id_token, account_id } }`)
   * or a flat token object. Expiry is derived from the JWT `exp` claim; refresh handles the rest.
   *
   * @param userId - Authenticated OSHAL user identifier used for per-user credential persistence
   * @param rawAuthJson - The auth.json contents as a string or parsed object
   * @returns Persisted credentials (sans secrets in logs)
   */
  importCredentialsFromCodexCli(userId: string, rawAuthJson: unknown): OpenAiCodexCredentials {
    const startedAt = Date.now();
    logger.info({ userId }, 'Importing OpenAI Codex credentials from codex CLI auth.json');

    const parsed = this.parseAuthJsonInput(rawAuthJson);
    const tokens = this.extractTokenBag(parsed);

    const accessToken = this.readOptionalStringField(tokens.access_token) || this.readOptionalStringField(tokens.accessToken);
    const refreshToken = this.readOptionalStringField(tokens.refresh_token) || this.readOptionalStringField(tokens.refreshToken);
    const idToken = this.readOptionalStringField(tokens.id_token) || this.readOptionalStringField(tokens.idToken);

    if (!accessToken || !refreshToken) {
      throw new Error(
        'auth.json is missing access_token/refresh_token. Run `codex login` first, then upload ~/.codex/auth.json (it is created after a successful login).',
      );
    }

    const claimSource = idToken || accessToken;
    const claims = this.parseJwtClaims(claimSource);
    const expiresAt = this.resolveExpiryFromClaims(claims);
    const accountId = this.extractAccountId(claimSource)
      || this.readOptionalStringField(tokens.account_id)
      || this.readOptionalStringField(tokens.accountId);

    const credentials: OpenAiCodexCredentials = {
      type: 'openai-codex',
      accessToken,
      refreshToken,
      expiresAt,
      idToken,
      email: this.readEmailFromClaims(claims) || this.readOptionalStringField(tokens.email),
      accountId,
    };

    this.writeCredentials(userId, credentials);
    logger.info({ userId, durationMs: Date.now() - startedAt, expiresAt, hasAccountId: !!accountId }, 'Imported OpenAI Codex credentials from CLI auth.json');
    return credentials;
  }

  /**
   * @description Parses the uploaded auth.json input into an object, accepting a JSON string or object.
   * @param rawAuthJson - Raw auth.json contents
   * @returns Parsed object
   */
  private parseAuthJsonInput(rawAuthJson: unknown): Record<string, unknown> {
    if (typeof rawAuthJson === 'string') {
      const trimmed = rawAuthJson.trim();
      if (trimmed.length === 0) {
        throw new Error('No auth.json content provided.');
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('auth.json did not parse to an object.');
        }
        return parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error('auth.json is not valid JSON. Copy the file contents exactly as `codex login` wrote them.');
      }
    }

    if (rawAuthJson && typeof rawAuthJson === 'object' && !Array.isArray(rawAuthJson)) {
      return rawAuthJson as Record<string, unknown>;
    }

    throw new Error('No auth.json content provided.');
  }

  /**
   * @description Returns the token-bearing object, handling both the nested CLI shape
   * (`{ tokens: {...} }`) and a flat token object.
   * @param parsed - Parsed auth.json object
   * @returns Object containing the token fields
   */
  private extractTokenBag(parsed: Record<string, unknown>): Record<string, unknown> {
    const nested = parsed.tokens;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return parsed;
  }

  /**
   * @description Resolves credential expiry from JWT `exp` claims, falling back to a short window
   * so a near-immediate refresh repopulates a precise expiry when the claim is absent.
   * @param claims - Decoded JWT claims, when available
   * @returns Absolute expiry timestamp in milliseconds
   */
  private resolveExpiryFromClaims(claims: Record<string, unknown> | undefined): number {
    if (claims && typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
      return claims.exp * 1000;
    }
    return Date.now() + 60 * 60 * 1000;
  }

  /**
   * @description Extracts the account email from decoded JWT claims when present.
   * @param claims - Decoded JWT claims
   * @returns Email string or undefined
   */
  private readEmailFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
    if (!claims) return undefined;
    const direct = this.readOptionalStringField(claims.email);
    if (direct) return direct;
    const profile = claims['https://api.openai.com/profile'];
    if (profile && typeof profile === 'object') {
      return this.readOptionalStringField((profile as Record<string, unknown>).email);
    }
    return undefined;
  }

  /**
   * @description Creates the encrypted secrets manager instance used for credential persistence.
   * @param configOutputDir - Output directory for settings/secrets
   * @param encryptionKey - Optional encryption key for secrets-at-rest
   * @returns Encrypted config manager instance with load/save helpers
   */
  private createSecretsManager(configOutputDir: string, encryptionKey: string | null): SecretsManagerLike {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EncryptedConfigManager } = require(this.resolveEncryptedConfigManagerModulePath());
    return new EncryptedConfigManager(configOutputDir, encryptionKey);
  }

  /**
   * @description Resolves the encrypted-config-manager module path across direct source execution,
   * compiled container runtime, and repo-root test execution.
   *
   * @returns Absolute module path suitable for CommonJS require.
   */
  private resolveEncryptedConfigManagerModulePath(): string {
    const candidates = [
      path.resolve(process.cwd(), 'src/api/encrypted-config-manager'),
      path.resolve(process.cwd(), 'control-plane/OSHAL/src/api/encrypted-config-manager'),
      path.resolve(__dirname, '../../../api/encrypted-config-manager'),
      path.resolve(__dirname, '../../../../src/api/encrypted-config-manager'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(`${candidate}.js`) || fs.existsSync(`${candidate}.ts`)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  /**
   * @description Resolves the OAuth redirect URI from environment variables with a safe localhost default.
   * @returns Redirect URI used for OpenAI Codex authorization and token exchange
   */
  private resolveRedirectUri(): string {
    const explicitRedirectUri = process.env.OPENAI_CODEX_REDIRECT_URI;
    if (explicitRedirectUri && explicitRedirectUri.trim().length > 0) {
      return explicitRedirectUri.trim();
    }

    const callbackPort = process.env.OPENAI_CODEX_CALLBACK_PORT || '1455';
    const appUrl = process.env.APP_URL;

    if (appUrl && appUrl.trim().length > 0) {
      try {
        const derivedUrl = new URL(appUrl.trim());
        derivedUrl.port = callbackPort;
        derivedUrl.pathname = '/auth/callback';
        derivedUrl.search = '';
        derivedUrl.hash = '';
        return derivedUrl.toString();
      } catch (error) {
        logger.error({ err: error, appUrl }, 'Failed to derive OpenAI Codex redirect URI from APP_URL');
      }
    }

    return OPENAI_CODEX_DEFAULT_REDIRECT_URI;
  }

  /**
   * @description Returns the service-level redirect URI for authorization requests.
   * The redirect URI MUST match what is registered with the upstream OAuth provider
   * (OpenAI client allowlist), so request-origin overrides are intentionally avoided.
   *
   * @returns Redirect URI for this authorization attempt
   */
  private resolveAuthorizationRedirectUri(): string {
    return this.redirectUri;
  }

  /**
   * @description Removes expired pending OAuth states to limit memory growth and replay window.
   * @returns Void after pruning stale pending authorization entries
   */
  private pruneExpiredAuthorizations(): void {
    const now = Date.now();

    for (const [state, pending] of this.pendingAuthorizations.entries()) {
      if (pending.expiresAt <= now) {
        this.pendingAuthorizations.delete(state);
      }
    }
  }

  /**
   * @description Generates a PKCE code verifier suitable for OpenAI OAuth authorization requests.
   * @returns Base64url-encoded PKCE code verifier
   */
  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * @description Computes the SHA-256 PKCE code challenge from a verifier.
   * @param codeVerifier - PKCE code verifier generated for the authorization request
   * @returns Base64url-encoded SHA-256 PKCE challenge
   */
  private generateCodeChallenge(codeVerifier: string): string {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  }

  /**
   * @description Generates a random state parameter used for OAuth CSRF protection.
   * @returns Hex-encoded random state value
   */
  private generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * @description Builds the full OpenAI authorization URL with PKCE and Codex-specific parameters.
   * @param codeChallenge - PKCE code challenge
   * @param state - CSRF protection state value
   * @returns OpenAI authorization URL for browser redirect
   */
  private buildAuthorizationUrl(codeChallenge: string, state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: OPENAI_CODEX_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      state,
      codex_cli_simplified_flow: 'true',
      originator: 'cline',
    });

    return `${OPENAI_CODEX_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  /**
   * @description Exchanges an OAuth authorization code for OpenAI access and refresh tokens.
   * @param code - OAuth authorization code from callback
   * @param codeVerifier - PKCE code verifier tied to the original auth request
   * @returns Parsed OpenAI token response payload
   */
  private async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const response = await fetch(OPENAI_CODEX_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });

    const payload = await response.json();
    if (!response.ok) {
      logger.error({ status: response.status }, 'OpenAI Codex token exchange failed');
      throw new Error('OpenAI Codex token exchange failed');
    }

    return this.parseTokenResponse(payload, true);
  }

  /**
   * @description Refreshes expired OAuth tokens using the stored refresh token.
   * @param credentials - Stored credentials containing the refresh token
   * @returns Refreshed credential object or null when refresh fails
   */
  private async refreshCredentials(credentials: OpenAiCodexCredentials): Promise<OpenAiCodexCredentials | null> {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: credentials.refreshToken,
      });

      const response = await fetch(OPENAI_CODEX_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(30000),
      });

      const payload = await response.json();
      if (!response.ok) {
        logger.warn({ status: response.status }, 'OpenAI Codex token refresh returned non-success');
        return null;
      }

      const refreshed = this.parseTokenResponse(payload, false);
      return this.buildCredentials(refreshed, credentials);
    } catch (error) {
      logger.error({ err: error }, 'OpenAI Codex token refresh failed');
      return null;
    }
  }

  /**
   * @description Parses and validates OpenAI token response fields required by this service.
   * @param payload - Raw response body from token exchange or refresh call
   * @param refreshTokenRequired - Whether refresh_token is mandatory for this operation
   * @returns Normalized OAuth token payload
   */
  private parseTokenResponse(payload: unknown, refreshTokenRequired: boolean): OAuthTokenResponse {
    if (!payload || typeof payload !== 'object') {
      throw new Error('OpenAI token response was not a valid object');
    }

    const data = payload as Record<string, unknown>;
    const accessToken = this.readStringField(data.access_token, 'access_token');
    const expiresIn = this.readNumberField(data.expires_in, 'expires_in');
    const refreshToken = this.readOptionalStringField(data.refresh_token);

    if (refreshTokenRequired && !refreshToken) {
      throw new Error('OpenAI token response did not include refresh_token');
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: this.readOptionalStringField(data.id_token),
      expires_in: expiresIn,
      email: this.readOptionalStringField(data.email),
    };
  }

  /**
   * @description Converts token response fields into persisted credential shape with expiry and account metadata.
   * @param tokenResponse - Token response from authorization exchange or refresh
   * @param existing - Existing stored credentials used as fallback for optional fields
   * @returns Persistable OpenAI Codex credential record
   */
  private buildCredentials(
    tokenResponse: OAuthTokenResponse,
    existing?: OpenAiCodexCredentials,
  ): OpenAiCodexCredentials {
    const expiresAt = Date.now() + tokenResponse.expires_in * 1000;
    const accountId = this.extractAccountId(tokenResponse.id_token || tokenResponse.access_token);

    return {
      type: 'openai-codex',
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || existing?.refreshToken || '',
      expiresAt,
      idToken: tokenResponse.id_token || existing?.idToken,
      email: tokenResponse.email || existing?.email,
      accountId: accountId || existing?.accountId,
    };
  }

  /**
   * @description Extracts the ChatGPT account identifier from a JWT token payload, when present.
   * @param jwt - JWT token string potentially containing ChatGPT account claims
   * @returns ChatGPT account ID or undefined when claim is not present
   */
  private extractAccountId(jwt: string): string | undefined {
    const claims = this.parseJwtClaims(jwt);
    if (!claims || typeof claims !== 'object') {
      return undefined;
    }

    const directAccountId = this.readOptionalStringField(claims.chatgpt_account_id);
    if (directAccountId) {
      return directAccountId;
    }

    const openAiAuthClaims = claims['https://api.openai.com/auth'];
    if (openAiAuthClaims && typeof openAiAuthClaims === 'object') {
      return this.readOptionalStringField((openAiAuthClaims as Record<string, unknown>).chatgpt_account_id);
    }

    const organizations = claims.organizations;
    if (Array.isArray(organizations) && organizations.length > 0) {
      const firstOrg = organizations[0];
      if (firstOrg && typeof firstOrg === 'object') {
        return this.readOptionalStringField((firstOrg as Record<string, unknown>).id);
      }
    }

    return undefined;
  }

  /**
   * @description Parses JWT payload claims using base64url decoding.
   * @param jwt - JWT token string
   * @returns Decoded claims object or undefined when token cannot be parsed
   */
  private parseJwtClaims(jwt: string): Record<string, unknown> | undefined {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return undefined;
    }

    try {
      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
      return JSON.parse(payload) as Record<string, unknown>;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse OpenAI JWT claims');
      return undefined;
    }
  }

  /**
   * @description Checks whether a credential record should be refreshed based on expiry buffer.
   * @param credentials - Stored credential record
   * @returns True when the token is expired or near expiry
   */
  private isTokenExpired(credentials: OpenAiCodexCredentials): boolean {
    return Date.now() >= (credentials.expiresAt - TOKEN_EXPIRY_BUFFER_MS);
  }

  /**
   * @description Loads and parses stored OpenAI Codex credentials for a user.
   * @param userId - Authenticated OSHAL user identifier
   * @returns Parsed credentials or null when no credentials are stored
   */
  private readCredentials(userId: string): OpenAiCodexCredentials | null {
    const secrets = this.secretsManager.loadSecrets(userId);
    const rawCredentials = secrets[OPENAI_CODEX_CREDENTIALS_KEY];

    if (typeof rawCredentials !== 'string' || rawCredentials.trim().length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawCredentials) as OpenAiCodexCredentials;
      if (!parsed.accessToken || !parsed.refreshToken || typeof parsed.expiresAt !== 'number') {
        logger.warn({ userId }, 'Stored OpenAI Codex credentials were incomplete');
        return null;
      }
      return parsed;
    } catch (error) {
      logger.error({ err: error, userId }, 'Stored OpenAI Codex credentials could not be parsed');
      return null;
    }
  }

  /**
   * @description Writes OpenAI Codex credentials into the encrypted secrets envelope for a user.
   *
   * Per-user storage ALWAYS happens (that copy is what gets bundled onto a bot node at runtime, in
   * the caller's private workspace — dedicated bot nodes do NOT read the shared seed). Swarm-wide
   * propagation — mirroring into the shared `/app/config-seed/secrets.json` and the Redis broadcast —
   * is **OPERATOR-ONLY**. That seed is what the API's own inline/concierge codex path and the api
   * default model resolve from; it is writable on the api container. Before this gate, any
   * authenticated user who imported their `~/.codex/auth.json` overwrote it, so a guest's ChatGPT
   * plan silently became the platform default — a billing/abuse hole the moment the deployment has
   * more than one user. A single-operator local swarm is unaffected: the operator IS on the
   * allowlist, so propagation still runs for them. (The Redis broadcast currently has no subscribers;
   * gating it is harmless and future-proofs it against re-subscription.)
   *
   * @param userId - Authenticated OSHAL user identifier
   * @param credentials - Credential record to persist
   * @returns Void after persisting credentials
   */
  private writeCredentials(userId: string, credentials: OpenAiCodexCredentials): void {
    const secrets = this.secretsManager.loadSecrets(userId);
    const updatedSecrets = {
      ...secrets,
      [OPENAI_CODEX_CREDENTIALS_KEY]: JSON.stringify(credentials),
    };
    this.secretsManager.saveSecrets(updatedSecrets, userId);

    if (!isOperatorIdentity(userId, credentials.email)) {
      logger.info(
        { userId },
        'Codex credentials stored for this user only — swarm-wide propagation is operator-only',
      );
      return;
    }

    this.writeSharedSeedCredentials(credentials);
    this.broadcastCodexCredentials(credentials).catch((err) => {
      logger.warn({ err }, 'Non-fatal: failed to broadcast credentials after write');
    });
  }

  /**
   * @description Deletes persisted OpenAI Codex credentials for a user.
   * @param userId - Authenticated OSHAL user identifier
   * @returns Void after deleting credentials from persisted secrets
   */
  private deleteCredentials(userId: string): void {
    const secrets = this.secretsManager.loadSecrets(userId);

    if (!(OPENAI_CODEX_CREDENTIALS_KEY in secrets)) {
      return;
    }

    const updatedSecrets = { ...secrets };
    delete updatedSecrets[OPENAI_CODEX_CREDENTIALS_KEY];
    this.secretsManager.saveSecrets(updatedSecrets, userId);
    this.removeSharedSeedCredentials();
  }

  /**
   * @description Mirrors OAuth credentials into the shared swarm seed so other Docker bots can consume them.
   * @param credentials - Credential record to persist for swarm-wide fallback use.
   * @returns Void after best-effort shared-seed update.
   */
  private writeSharedSeedCredentials(credentials: OpenAiCodexCredentials): void {
    const filePath = this.resolveSharedSeedPath();
    if (!filePath) {
      return;
    }

    try {
      const current = this.readSharedSeedSecrets(filePath);
      const next = {
        ...current,
        [OPENAI_CODEX_CREDENTIALS_KEY]: JSON.stringify(credentials),
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
      logger.info({ filePath }, 'Mirrored OpenAI Codex OAuth credentials into shared swarm seed');
    } catch (error) {
      // Issue #5: when /app/config-seed is mounted read-only (the standard
      // sandbox setup — operators don't want the container modifying host-
      // sourced secrets), the write fails with EROFS on every credential
      // refresh. The behaviour is correct (don't write to a read-only mount);
      // the noise is the warn-level log every ~30s. Demote to debug for that
      // specific errno so other write failures still surface.
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'EROFS') {
        logger.debug({ filePath }, 'Shared-seed credential mirror skipped — config-seed mount is read-only (expected)');
      } else {
        logger.warn({ err: error, filePath }, 'Failed to mirror OpenAI Codex OAuth credentials into shared swarm seed');
      }
    }
  }

  /**
   * @description Removes mirrored shared-seed OAuth credentials when the active user signs out.
   * @returns Void after best-effort shared-seed cleanup.
   */
  private removeSharedSeedCredentials(): void {
    const filePath = this.resolveSharedSeedPath();
    if (!filePath || !fs.existsSync(filePath)) {
      return;
    }

    try {
      const current = this.readSharedSeedSecrets(filePath);
      if (!(OPENAI_CODEX_CREDENTIALS_KEY in current)) {
        return;
      }
      const next = { ...current };
      delete next[OPENAI_CODEX_CREDENTIALS_KEY];
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
      logger.info({ filePath }, 'Removed OpenAI Codex OAuth credentials from shared swarm seed');
    } catch (error) {
      logger.warn({ err: error, filePath }, 'Failed to remove OpenAI Codex OAuth credentials from shared swarm seed');
    }
  }

  /**
   * @description Reads the shared swarm seed secrets JSON with object-only fallback semantics.
   * @param filePath - Shared seed file path.
   * @returns Parsed secrets object or empty object when missing/invalid.
   */
  private readSharedSeedSecrets(filePath: string): Record<string, unknown> {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch (error) {
      logger.warn({ err: error, filePath }, 'Failed to parse shared swarm seed secrets');
      return {};
    }
  }

  /**
   * @description Resolves the shared swarm seed secrets path from runtime env with a safe container default.
   * @returns Shared seed secrets path.
   */
  private resolveSharedSeedPath(): string {
    return process.env.OPENAI_CODEX_SHARED_SEED_PATH || '/app/config-seed/secrets.json';
  }

  // ---------------------------------------------------------------------------
  // Redis pub/sub credential broadcast (swarm-wide propagation)
  // ---------------------------------------------------------------------------

  private static readonly CODEX_CREDENTIAL_CHANNEL = 'swarm.codex-credentials.update';

  /**
   * @description Publishes OpenAI Codex credentials to Redis so every bot container picks them up.
   * Called after successful OAuth token exchange — supplements config-seed file propagation
   * which fails on Windows bind mounts.
   */
  private async broadcastCodexCredentials(credentials: OpenAiCodexCredentials): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || process.env.SWARM_MODE !== 'container') return;

    const pub = new Redis(redisUrl);
    try {
      const receivers = await pub.publish(
        OpenAiCodexOAuthService.CODEX_CREDENTIAL_CHANNEL,
        JSON.stringify(credentials),
      );
      logger.info({ receivers }, 'Broadcast OpenAI Codex credentials to swarm via Redis');
    } catch (err) {
      logger.warn({ err }, 'Failed to broadcast OpenAI Codex credentials via Redis');
    } finally {
      pub.disconnect();
    }
  }

  /**
   * @description Subscribes to OpenAI Codex credential broadcasts on bot startup.
   * Auto-imports credentials published by the API server after OAuth callback.
   * @param runtimeSyncService - Cline runtime sync service for writing credentials to local runtime
   */
  static async subscribeToBroadcast(runtimeSyncService?: { syncOpenAiCodexCredentials: (userId?: string | null) => boolean }): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || process.env.SWARM_MODE !== 'container') return;

    try {
      const sub = new Redis(redisUrl);
      await sub.subscribe(OpenAiCodexOAuthService.CODEX_CREDENTIAL_CHANNEL);
      logger.info('Subscribed to OpenAI Codex credential broadcast channel');

      sub.on('message', (_channel: string, message: string) => {
        try {
          const credentials = JSON.parse(message) as OpenAiCodexCredentials;
          if (!credentials.accessToken) return;

          // Write credentials to the shared seed file so the sync service can pick them up
          const seedPath = process.env.OPENAI_CODEX_SHARED_SEED_PATH || '/app/config-seed/secrets.json';
          let existing: Record<string, unknown> = {};
          if (fs.existsSync(seedPath)) {
            try { existing = JSON.parse(fs.readFileSync(seedPath, 'utf-8')) as Record<string, unknown>; } catch { /* ignore */ }
          }
          existing[OPENAI_CODEX_CREDENTIALS_KEY] = JSON.stringify(credentials);
          fs.mkdirSync(path.dirname(seedPath), { recursive: true });
          fs.writeFileSync(seedPath, JSON.stringify(existing, null, 2), 'utf-8');
          logger.info('Received OpenAI Codex credential broadcast — written to seed');

          // Trigger runtime sync if service is available
          if (runtimeSyncService) {
            runtimeSyncService.syncOpenAiCodexCredentials();
          }
        } catch (err) {
          // Same EROFS-on-read-only-mount demotion as writeSharedSeedCredentials.
          if ((err as NodeJS.ErrnoException).code === 'EROFS') {
            logger.debug('OpenAI Codex credential broadcast skipped — config-seed mount is read-only (expected)');
          } else {
            logger.warn({ err }, 'Failed to process OpenAI Codex credential broadcast');
          }
        }
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to subscribe to OpenAI Codex credential broadcast');
    }
  }

  /**
   * @description Reads an unknown payload field as string and throws when missing or invalid.
   * @param value - Unknown field value
   * @param fieldName - Field name used for validation error messages
   * @returns Parsed string value
   */
  private readStringField(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`OpenAI token response missing required field: ${fieldName}`);
    }
    return value;
  }

  /**
   * @description Reads an unknown payload field as number and throws when missing or invalid.
   * @param value - Unknown field value
   * @param fieldName - Field name used for validation error messages
   * @returns Parsed numeric value
   */
  private readNumberField(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`OpenAI token response missing required numeric field: ${fieldName}`);
    }
    return value;
  }

  /**
   * @description Reads an unknown payload field as optional string.
   * @param value - Unknown field value
   * @returns String value when valid; otherwise undefined
   */
  private readOptionalStringField(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    return value;
  }
}
