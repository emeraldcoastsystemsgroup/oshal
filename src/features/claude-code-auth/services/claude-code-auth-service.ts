/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Claude Code auth service for login/status/logout orchestration via Claude CLI
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added PKCE OAuth flow with callback handler, state management, and credential persistence
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Restored CLI login + added OAuth PKCE with correct scopes (openid profile email offline_access)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fixed startLogin() to use PKCE OAuth flow when redirectUri provided; fixed ANTHROPIC_SCOPES to Anthropic-specific scopes
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Removed dead resolveDefaultRedirectUri() — redirect URI is derived dynamically in routes layer
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | api_key env-var auth no longer counts as user-authenticated; buildUnavailableStatus() returns available:true so PKCE Sign In always appears
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | startLogin() accepts optional redirectUri param so /start route can pass request-derived callback URL for auto-callback OAuth flow
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Write OAuth credentials in claude CLI's native format at ~/.claude/.credentials.json (claudeAiOauth shape) so CLI subprocess auth works in containers without ANTHROPIC_API_KEY
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'claude-code-auth-service' });
const execFileAsync = promisify(execFileCallback);

const DEFAULT_BINARY = 'claude';
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const AUTH_URL_REGEX = /(https?:\/\/[^\s]+)/i;

// OAuth constants — must match the Claude Code CLI's registered client configuration.
// The redirect URI points to Anthropic's code-display page (not localhost) because
// the OAuth client only allows pre-registered URIs. The user copies the displayed
// auth code back into our UI.
const ANTHROPIC_AUTHORIZATION_ENDPOINT = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_ENDPOINT = 'https://claude.ai/oauth/token';
const ANTHROPIC_DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_REGISTERED_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface LoginProcessState {
  process: ChildProcessWithoutNullStreams;
  startedAt: number;
  authUrl: string | null;
  completed: boolean;
  stdout: string;
  stderr: string;
}

interface PendingOAuthState {
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type?: string;
}

/**
 * @description Normalized Claude Code authentication status payload for API routes.
 */
export interface ClaudeCodeAuthStatus {
  available: boolean;
  authenticated: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  loginInProgress: boolean;
  pendingAuthUrl: string | null;
}

/**
 * @description Start-login response payload for Claude Code authentication flows.
 */
export interface ClaudeCodeAuthStartResult {
  alreadyAuthenticated: boolean;
  loginInProgress: boolean;
  authUrl: string | null;
  oauthMode: boolean;
}

/**
 * @description OAuth callback result payload for Claude Code authentication completion.
 */
export interface ClaudeCodeAuthCallbackResult {
  authenticated: boolean;
  email: string | null;
}

/**
 * @description Portable credential payload used for cross-bot propagation.
 */
export interface ClaudeCodeCredentialPayload {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_at: number;
}

/**
 * @description Service wrapper around `claude auth` commands for status, login, and sign-out operations.
 */
export class ClaudeCodeAuthService {
  private readonly binaryPath: string;
  private readonly commandTimeoutMs: number;
  private activeLogin: LoginProcessState | null = null;
  private pendingOAuthStates: Map<string, PendingOAuthState> = new Map();

  /**
   * @description Creates a ClaudeCodeAuthService using environment overrides for binary path and timeouts.
   * @param binaryPath - Optional Claude CLI binary path override
   * @param commandTimeoutMs - Optional command timeout override in milliseconds
   */
  constructor(binaryPath?: string, commandTimeoutMs?: number) {
    this.binaryPath = this.resolveBinaryPath(binaryPath);
    this.commandTimeoutMs = this.resolveCommandTimeoutMs(commandTimeoutMs);
    logger.info({ binaryPath: this.binaryPath, commandTimeoutMs: this.commandTimeoutMs }, 'ClaudeCodeAuthService initialized');
  }

  /**
   * @description Returns current Claude Code authentication status from `claude auth status --json`.
   * @returns Normalized authentication status payload
   */
  async getStatus(): Promise<ClaudeCodeAuthStatus> {
    const startedAt = Date.now();
    logger.info('Loading Claude Code auth status');

    try {
      const { stdout } = await this.runCommand(['auth', 'status', '--json']);
      const parsed = this.parseStatusPayload(stdout);
      const normalized = this.normalizeStatus(parsed);
      logger.info({ durationMs: Date.now() - startedAt, authenticated: normalized.authenticated }, 'Loaded Claude Code auth status');
      return normalized;
    } catch (error) {
      logger.warn({ err: error }, 'Claude CLI auth status failed — checking persisted OAuth credentials');
      return this.buildStatusFromPersistedCredentials();
    }
  }

  /**
   * @description Starts Claude Code login flow using PKCE OAuth. The redirect URI is
   * derived from the incoming request origin so the callback lands on the correct host/port
   * and the browser is redirected back automatically without requiring copy/paste.
   * @param email - Optional email hint (unused in PKCE flow, reserved for future use)
   * @param redirectUri - OAuth callback URI derived from the request origin; falls back to env var or Anthropic's display page
   * @returns Start-login result payload with the auth URL to open in a popup
   */
  async startLogin(email?: string, redirectUri?: string): Promise<ClaudeCodeAuthStartResult> {
    const startedAt = Date.now();
    logger.info({ email: email || null }, 'Starting Claude Code PKCE auth login flow');

    const status = await this.getStatus();
    if (status.authenticated && status.authMethod !== 'api_key') {
      return {
        alreadyAuthenticated: true,
        loginInProgress: false,
        authUrl: null,
        oauthMode: true,
      };
    }

    const effectiveRedirectUri = redirectUri || process.env.ANTHROPIC_OAUTH_REDIRECT_URI || ANTHROPIC_REGISTERED_REDIRECT_URI;
    const authUrl = this.startOAuthFlow(effectiveRedirectUri);
    logger.info({ durationMs: Date.now() - startedAt, authUrl, redirectUri: effectiveRedirectUri }, 'Claude Code PKCE OAuth flow started');
    return {
      alreadyAuthenticated: false,
      loginInProgress: false,
      authUrl,
      oauthMode: true,
    };
  }

  /**
   * @description Exchanges an auth code (pasted by the user from Anthropic's code-display page)
   * for OAuth tokens using the most recent pending PKCE state. After exchange, credentials
   * are persisted locally.
   * @param code - The auth code displayed by platform.claude.com after authentication
   * @returns Callback result with authentication status
   */
  async submitAuthCode(code: string): Promise<ClaudeCodeAuthCallbackResult> {
    logger.info('Submitting auth code for PKCE token exchange');

    // Find the most recent pending OAuth state for PKCE exchange
    this.pruneExpiredOAuthStates();
    const pendingEntry = Array.from(this.pendingOAuthStates.entries()).pop();
    if (!pendingEntry) {
      throw new Error('No pending OAuth session — please click Sign In first');
    }

    const [state, pending] = pendingEntry;
    this.pendingOAuthStates.delete(state);

    try {
      const tokenResponse = await this.exchangeOAuthCode(code, pending.codeVerifier, pending.redirectUri);
      const email = this.extractEmailFromToken(tokenResponse);
      this.persistOAuthCredentials(tokenResponse);
      logger.info({ email: email || null }, 'PKCE token exchange succeeded, credentials persisted');

      // Broadcast the saved key to every other bot in the swarm
      this.broadcastCredentials().catch((err) =>
        logger.warn({ err }, 'Credential broadcast to swarm failed (non-fatal)'),
      );

      return { authenticated: true, email: email || null };
    } catch (error) {
      logger.error({ err: error }, 'PKCE token exchange failed');
      throw error;
    }
  }

  /**
   * @description Handles the OAuth PKCE callback by exchanging the authorization code for credentials.
   * @param state - OAuth state parameter for CSRF validation
   * @param code - OAuth authorization code from the callback redirect
   * @returns Callback result with authentication status
   */
  async handleOAuthCallback(state: string, code: string): Promise<ClaudeCodeAuthCallbackResult> {
    const startedAt = Date.now();
    logger.info({ stateLength: state.length }, 'Handling Claude Code OAuth callback');

    this.pruneExpiredOAuthStates();

    const pending = this.pendingOAuthStates.get(state);
    if (!pending) {
      logger.warn({ stateLength: state.length }, 'Claude Code OAuth callback state not found');
      throw new Error('Invalid or expired OAuth state');
    }

    this.pendingOAuthStates.delete(state);

    if (Date.now() > pending.expiresAt) {
      logger.warn('Claude Code OAuth callback state expired');
      throw new Error('OAuth authorization request expired');
    }

    const tokenResponse = await this.exchangeOAuthCode(code, pending.codeVerifier, pending.redirectUri);
    const email = this.extractEmailFromToken(tokenResponse);
    this.persistOAuthCredentials(tokenResponse);

    logger.info({ durationMs: Date.now() - startedAt, email: email || null }, 'Claude Code OAuth callback completed');
    return { authenticated: true, email: email || null };
  }

  /**
   * @description Signs out Claude Code authentication and clears any in-flight login process.
   * @returns Updated authentication status after sign-out attempt
   */
  async signOut(): Promise<ClaudeCodeAuthStatus> {
    const startedAt = Date.now();
    logger.info('Signing out Claude Code auth');

    this.terminateActiveLoginIfNeeded();
    this.clearPersistedOAuthCredentials();

    try {
      await this.runCommand(['auth', 'logout']);
    } catch (error) {
      logger.warn({ err: error }, 'Claude CLI logout failed — credentials cleared from local store');
    }

    const status = await this.getStatus();
    logger.info({ durationMs: Date.now() - startedAt, authenticated: status.authenticated }, 'Claude Code sign-out completed');
    return status;
  }

  /**
   * @description Reads persisted OAuth credentials for cross-bot propagation.
   * Claude CLI stores credentials on Linux as `{"claudeAiOauth":{"accessToken":...,"refreshToken":...,"expiresAt":...,"scopes":[...]}}`.
   * This method accepts both that canonical format and the legacy flat `{access_token,...}` shape.
   * @returns Credential payload when valid credentials exist; otherwise null
   */
  getCredentials(): ClaudeCodeCredentialPayload | null {
    const credentialsPath = this.resolveClaudeCredentialsPath();
    if (!credentialsPath || !fs.existsSync(credentialsPath)) return null;
    try {
      const raw = fs.readFileSync(credentialsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Canonical CLI format: { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes } }
      const oauth = (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === 'object')
        ? parsed.claudeAiOauth as Record<string, unknown>
        : null;
      const accessToken = oauth
        ? (typeof oauth.accessToken === 'string' ? oauth.accessToken : '')
        : (typeof parsed.access_token === 'string' ? parsed.access_token : '');
      if (accessToken.length === 0) return null;
      const refreshToken = oauth
        ? (typeof oauth.refreshToken === 'string' ? oauth.refreshToken : null)
        : (typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null);
      const expiresAt = oauth
        ? (typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0)
        : (typeof parsed.expires_at === 'number' ? parsed.expires_at : 0);
      if (expiresAt > 0 && Date.now() > expiresAt) return null;
      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
        expires_at: expiresAt,
      };
    } catch (error) {
      logger.warn({ err: error }, 'Failed to read Claude Code credentials for export');
      return null;
    }
  }

  /**
   * @description Imports OAuth credentials from another bot (swarm propagation).
   * Writes the canonical claude CLI format so the subprocess can authenticate from the file alone.
   * @param payload - Credential payload from the source bot
   */
  importCredentials(payload: ClaudeCodeCredentialPayload): void {
    const credentialsPath = this.resolveClaudeCredentialsPath();
    if (!credentialsPath) {
      throw new Error('Cannot resolve credentials path — HOME directory not available');
    }
    try {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
      const fileContents = {
        claudeAiOauth: {
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token,
          expiresAt: payload.expires_at,
          scopes: ['user:inference', 'user:profile'],
        },
      };
      fs.writeFileSync(credentialsPath, JSON.stringify(fileContents, null, 2), 'utf-8');
      fs.chmodSync(credentialsPath, 0o600);
      logger.info({ credentialsPath }, 'Claude Code credentials imported from swarm propagation');
    } catch (error) {
      logger.error({ err: error, credentialsPath }, 'Failed to import Claude Code credentials');
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Swarm credential broadcast (Redis pub/sub)
  // ---------------------------------------------------------------------------

  private static readonly CREDENTIAL_CHANNEL = 'swarm.credentials.update';

  /**
   * @description Publishes the saved key to Redis so every other bot picks it up.
   */
  private async broadcastCredentials(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || process.env.SWARM_MODE !== 'container') return;

    const credentials = this.getCredentials();
    if (!credentials) return;

    const pub = new Redis(redisUrl);
    try {
      const receivers = await pub.publish(
        ClaudeCodeAuthService.CREDENTIAL_CHANNEL,
        JSON.stringify(credentials),
      );
      logger.info({ receivers }, 'Broadcast credentials to swarm');
    } finally {
      pub.disconnect();
    }
  }

  /**
   * @description Call once on bot startup. Subscribes to the credential broadcast channel
   * and auto-imports any keys published by other bots.
   */
  static async subscribeToBroadcast(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || process.env.SWARM_MODE !== 'container') return;

    const sub = new Redis(redisUrl);
    const svc = new ClaudeCodeAuthService();

    await sub.subscribe(ClaudeCodeAuthService.CREDENTIAL_CHANNEL);
    logger.info('Subscribed to swarm credential broadcast channel');

    sub.on('message', (_channel: string, message: string) => {
      try {
        const payload = JSON.parse(message) as ClaudeCodeCredentialPayload;
        if (!payload.access_token) return;
        svc.importCredentials(payload);
        logger.info('Received credential broadcast — key saved');
      } catch (err) {
        logger.warn({ err }, 'Failed to process credential broadcast');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // OAuth PKCE methods
  // ---------------------------------------------------------------------------

  /**
   * @description Generates a PKCE authorization URL and stores the pending state for callback validation.
   * @param redirectUri - The URI Anthropic should redirect back to after authorization
   * @returns Authorization URL to open in a browser popup
   */
  private startOAuthFlow(redirectUri: string): string {
    this.pruneExpiredOAuthStates();
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    this.pendingOAuthStates.set(state, { codeVerifier, redirectUri, expiresAt: Date.now() + AUTHORIZATION_TTL_MS });

    const authEndpoint = process.env.ANTHROPIC_AUTH_ENDPOINT || ANTHROPIC_AUTHORIZATION_ENDPOINT;
    const clientId = process.env.ANTHROPIC_OAUTH_CLIENT_ID || ANTHROPIC_DEFAULT_CLIENT_ID;
    const scopes = process.env.ANTHROPIC_OAUTH_SCOPES || ANTHROPIC_SCOPES;

    const params = new URLSearchParams({
      code: 'true',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      state,
      scope: scopes,
    });

    return `${authEndpoint}?${params.toString()}`;
  }

  /**
   * @description Exchanges an authorization code for OAuth tokens via the Anthropic token endpoint.
   * @param code - Authorization code from the callback
   * @param codeVerifier - PKCE code verifier matching the original challenge
   * @param redirectUri - Redirect URI used in the original authorization request
   * @returns Anthropic token response payload
   */
  private async exchangeOAuthCode(code: string, codeVerifier: string, redirectUri: string): Promise<AnthropicTokenResponse> {
    const tokenEndpoint = process.env.ANTHROPIC_TOKEN_ENDPOINT || ANTHROPIC_TOKEN_ENDPOINT;
    const clientId = process.env.ANTHROPIC_OAUTH_CLIENT_ID || ANTHROPIC_DEFAULT_CLIENT_ID;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    logger.info({ tokenEndpoint, redirectUri }, 'Exchanging Claude Code OAuth authorization code');

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      logger.error({ status: response.status, payload }, 'Claude Code OAuth token exchange failed');
      throw new Error(`Claude Code OAuth token exchange failed (${response.status})`);
    }

    return {
      access_token: payload.access_token as string,
      refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
      id_token: typeof payload.id_token === 'string' ? payload.id_token : undefined,
      expires_in: payload.expires_in as number,
      token_type: typeof payload.token_type === 'string' ? payload.token_type : undefined,
    };
  }

  /**
   * @description Persists OAuth credentials to ~/.claude/credentials.json for subsequent requests.
   * @param tokenResponse - Token response from the Anthropic token endpoint
   */
  private persistOAuthCredentials(tokenResponse: AnthropicTokenResponse): void {
    const credentialsPath = this.resolveClaudeCredentialsPath();
    if (!credentialsPath) return;
    try {
      // Canonical claude CLI v2+ format — the CLI reads this exact structure on Linux
      // when the macOS/Linux keychain is unavailable (e.g. inside Docker containers).
      const fileContents = {
        claudeAiOauth: {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token || null,
          expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
          scopes: ['user:inference', 'user:profile'],
        },
      };
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
      fs.writeFileSync(credentialsPath, JSON.stringify(fileContents, null, 2), 'utf-8');
      fs.chmodSync(credentialsPath, 0o600);
      logger.info({ credentialsPath }, 'Claude Code OAuth credentials persisted');
    } catch (error) {
      logger.error({ err: error, credentialsPath }, 'Failed to persist Claude Code OAuth credentials');
    }
  }

  /**
   * @description Removes persisted OAuth credentials file on sign-out.
   */
  private clearPersistedOAuthCredentials(): void {
    const credentialsPath = this.resolveClaudeCredentialsPath();
    if (!credentialsPath || !fs.existsSync(credentialsPath)) return;
    try {
      fs.unlinkSync(credentialsPath);
      logger.info({ credentialsPath }, 'Claude Code OAuth credentials cleared');
    } catch (error) {
      logger.warn({ err: error }, 'Failed to clear Claude Code OAuth credentials');
    }
  }

  /**
   * @description Reads persisted OAuth credentials and returns authenticated status when valid.
   * @returns Authentication status derived from stored credentials
   */
  private buildStatusFromPersistedCredentials(): ClaudeCodeAuthStatus {
    const creds = this.getCredentials();
    if (!creds) return this.buildUnavailableStatus();
    return {
      available: true, authenticated: true, authMethod: 'oauth', apiProvider: null,
      email: null, orgId: null, orgName: null, subscriptionType: null,
      loginInProgress: false, pendingAuthUrl: null,
    };
  }

  /**
   * @description Extracts email claim from an Anthropic id_token JWT payload.
   * @param tokenResponse - Token response that may contain an id_token
   * @returns Email string when present in id_token claims; otherwise null
   */
  private extractEmailFromToken(tokenResponse: AnthropicTokenResponse): string | null {
    if (!tokenResponse.id_token) return null;
    try {
      const parts = tokenResponse.id_token.split('.');
      if (parts.length !== 3) return null;
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
      return typeof claims.email === 'string' ? claims.email : null;
    } catch { return null; }
  }

  /**
   * @description Resolves the credentials file path from env override or default ~/.claude/.credentials.json.
   * The dot-prefixed filename is the format claude CLI v2+ reads on Linux when the keychain is unavailable.
   * @returns Absolute credentials file path or null when home directory cannot be determined
   */
  private resolveClaudeCredentialsPath(): string | null {
    const explicit = process.env.CLAUDE_CODE_CREDENTIALS_PATH;
    if (explicit && explicit.trim().length > 0) return explicit.trim();
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    return homeDir ? path.join(homeDir, '.claude', '.credentials.json') : null;
  }

  /**
   * @description Removes expired entries from the pending OAuth states map.
   */
  private pruneExpiredOAuthStates(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingOAuthStates.entries()) {
      if (pending.expiresAt <= now) this.pendingOAuthStates.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // CLI login methods
  // ---------------------------------------------------------------------------

  /**
   * @description Spawns `claude auth login` and waits briefly for a browser auth URL in its output.
   * @param email - Optional email hint
   * @returns Start-login result with discovered auth URL when available
   */
  private async startLoginProcess(email?: string): Promise<ClaudeCodeAuthStartResult> {
    const args = this.buildLoginArgs(email);
    const child = spawn(this.binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const state = this.createLoginState(child);
    this.activeLogin = state;
    this.attachLoginListeners(state);

    const authUrl = await this.waitForAuthUrl(state);
    return {
      alreadyAuthenticated: false,
      loginInProgress: !state.completed,
      authUrl,
      oauthMode: false,
    };
  }

  /**
   * @description Runs a Claude CLI command and captures stdout/stderr.
   * @param args - Command arguments for the Claude binary
   * @returns Command output payload
   */
  private async runCommand(args: string[]): Promise<CommandResult> {
    logger.info({ binaryPath: this.binaryPath, args }, 'Running Claude auth command');

    try {
      const result = await execFileAsync(this.binaryPath, args, {
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
        maxBuffer: 1024 * 1024,
      });

      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    } catch (error) {
      logger.error({ err: error, args }, 'Claude auth command failed');
      throw error;
    }
  }

  /**
   * @description Attaches stream/process listeners so auth URL and completion metadata are tracked.
   * @param state - Active login process state
   */
  private attachLoginListeners(state: LoginProcessState): void {
    state.process.stdout.on('data', (chunk: Buffer) => this.handleLoginChunk(state, chunk.toString(), 'stdout'));
    state.process.stderr.on('data', (chunk: Buffer) => this.handleLoginChunk(state, chunk.toString(), 'stderr'));
    state.process.on('error', (error: Error) => {
      logger.error({ err: error }, 'Claude auth login process errored');
      this.completeLoginState(state);
    });
    state.process.on('close', (code: number | null) => {
      logger.info({ code }, 'Claude auth login process closed');
      this.completeLoginState(state);
    });
  }

  /**
   * @description Updates login process state from stream chunks and extracts first auth URL.
   * @param state - Active login process state
   * @param chunk - Stream chunk text
   * @param stream - Source stream label
   */
  private handleLoginChunk(state: LoginProcessState, chunk: string, stream: 'stdout' | 'stderr'): void {
    if (stream === 'stdout') {
      state.stdout += chunk;
    } else {
      state.stderr += chunk;
    }

    const urlMatch = chunk.match(AUTH_URL_REGEX);
    if (urlMatch && !state.authUrl) {
      state.authUrl = urlMatch[1];
      logger.info({ authUrl: state.authUrl }, 'Detected Claude auth login URL');
    }

    logger.info({ stream, chunk: chunk.slice(0, 240) }, 'Claude auth login process output');
  }

  /**
   * @description Waits briefly for the login command to emit an auth URL before returning to caller.
   * @param state - Active login process state
   * @returns Auth URL when discovered within wait window; otherwise null
   */
  private async waitForAuthUrl(state: LoginProcessState): Promise<string | null> {
    const deadline = Date.now() + 3000;

    while (!state.authUrl && !state.completed && Date.now() < deadline) {
      await this.delay(150);
    }

    return state.authUrl;
  }

  /**
   * @description Marks login state complete and clears active reference when it belongs to this process.
   * @param state - Active login process state
   */
  private completeLoginState(state: LoginProcessState): void {
    state.completed = true;
    if (this.activeLogin === state) {
      this.activeLogin = null;
    }
  }

  /**
   * @description Terminates in-flight login process if one is still active.
   */
  private terminateActiveLoginIfNeeded(): void {
    if (!this.activeLogin || this.activeLogin.completed) {
      return;
    }

    try {
      this.activeLogin.process.kill('SIGTERM');
      logger.info({ pid: this.activeLogin.process.pid }, 'Terminated active Claude auth login process');
    } catch (error) {
      logger.error({ err: error }, 'Failed to terminate active Claude auth login process');
    }
  }

  /**
   * @description Creates initial login process state object.
   * @param process - Spawned child process
   * @returns Initialized login process state
   */
  private createLoginState(process: ChildProcessWithoutNullStreams): LoginProcessState {
    return {
      process,
      startedAt: Date.now(),
      authUrl: null,
      completed: false,
      stdout: '',
      stderr: '',
    };
  }

  /**
   * @description Parses JSON output from `claude auth status --json`.
   * @param payload - Raw command stdout
   * @returns Parsed JSON object
   */
  private parseStatusPayload(payload: string): Record<string, unknown> {
    if (!payload || payload.trim().length === 0) {
      throw new Error('Claude auth status returned empty output');
    }

    return JSON.parse(payload) as Record<string, unknown>;
  }

  /**
   * @description Normalizes command status payload into API response shape.
   * @param payload - Parsed command payload
   * @returns Normalized status
   */
  private normalizeStatus(payload: Record<string, unknown>): ClaudeCodeAuthStatus {
    const active = this.activeLogin;
    // api_key means the CLI is using ANTHROPIC_API_KEY env var — that is a system credential,
    // not a user OAuth session. The user must complete PKCE login to be considered authenticated.
    const authenticated = payload.loggedIn === true && payload.authMethod !== 'api_key';

    return {
      available: true,
      authenticated,
      authMethod: this.readOptionalString(payload.authMethod),
      apiProvider: this.readOptionalString(payload.apiProvider),
      email: this.readOptionalString(payload.email),
      orgId: this.readOptionalString(payload.orgId),
      orgName: this.readOptionalString(payload.orgName),
      subscriptionType: this.readOptionalString(payload.subscriptionType),
      loginInProgress: !!active && !active.completed,
      pendingAuthUrl: active?.authUrl || null,
    };
  }

  /**
   * @description Builds unavailable status payload when Claude CLI is missing or command fails.
   * @returns Unavailable status payload
   */
  private buildUnavailableStatus(): ClaudeCodeAuthStatus {
    const active = this.activeLogin;
    return {
      // The claude CLI may be absent but PKCE OAuth does not require it.
      // Always report available:true so the Sign In button is rendered.
      available: true,
      authenticated: false,
      authMethod: null,
      apiProvider: null,
      email: null,
      orgId: null,
      orgName: null,
      subscriptionType: null,
      loginInProgress: !!active && !active.completed,
      pendingAuthUrl: active?.authUrl || null,
    };
  }

  /**
   * @description Builds argument list for `claude auth login` command.
   * @param email - Optional email hint
   * @returns CLI argument list
   */
  private buildLoginArgs(email?: string): string[] {
    const args = ['auth', 'login'];
    const normalizedEmail = this.readOptionalString(email);

    if (normalizedEmail) {
      args.push('--email', normalizedEmail);
    }

    return args;
  }

  /**
   * @description Resolves binary path from explicit config and environment variables.
   * @param binaryPath - Optional explicit binary path
   * @returns Normalized binary path
   */
  private resolveBinaryPath(binaryPath?: string): string {
    return this.readOptionalString(binaryPath)
      || this.readOptionalString(process.env.CLAUDE_CODE_BINARY)
      || this.readOptionalString(process.env.CLAUDE_CODE_PATH)
      || DEFAULT_BINARY;
  }

  /**
   * @description Resolves command timeout override with numeric validation.
   * @param timeoutMs - Optional explicit timeout override
   * @returns Normalized timeout in milliseconds
   */
  private resolveCommandTimeoutMs(timeoutMs?: number): number {
    if (Number.isInteger(timeoutMs) && (timeoutMs as number) > 0) {
      return timeoutMs as number;
    }

    const envTimeout = parseInt(process.env.CLAUDE_CODE_AUTH_TIMEOUT_MS || '', 10);
    return Number.isInteger(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /**
   * @description Converts unknown values into optional non-empty strings.
   * @param value - Unknown candidate value
   * @returns Trimmed string when present; otherwise null
   */
  private readOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * @description Delay helper used by auth URL polling.
   * @param ms - Delay duration in milliseconds
   * @returns Promise resolved after delay elapses
   */
  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}