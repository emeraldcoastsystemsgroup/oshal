/**
 * Assisted provider onboarding runner.
 *
 * This is intentionally NOT an unattended account-creation bot. It opens the
 * provider registration/token pages in the operator's own debuggable Chrome and
 * records progress. Human-only steps stay human: sign-up, MFA, app-review
 * attestations, legal terms, client-secret copy/paste, and billing enrollment.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { chromium, type Browser, type Page } from 'playwright';

type ProviderKind = 'oauth-app' | 'token' | 'operator-cli' | 'oshal-connect';
type RunMode = 'guided' | 'open-only';
type Target = 'registration' | 'oshal-connect';
type TaskStatus = 'opened' | 'done' | 'blocked' | 'skip';

interface ProviderTask {
  id: string;
  label: string;
  kind: ProviderKind;
  url: string;
  notes: string[];
  redirectPath?: string;
  envVars?: string[];
}

interface CliOptions {
  baseUrl: string;
  batchSize: number;
  cdpUrl: string;
  dwellMs: number;
  manifest?: string;
  mode: RunMode;
  providers: string[];
  reportPath: string;
  screenshotDir?: string;
  target: Target;
}

interface ReportEntry {
  id: string;
  label: string;
  kind: ProviderKind;
  url: string;
  status: TaskStatus;
  notes: string[];
  openedAt: string;
  screenshot?: string;
}

const DEFAULT_CDP_URL = 'http://localhost:9222';

const TASKS: ProviderTask[] = [
  oauth('google', 'Google Gmail + Calendar', 'https://console.cloud.google.com/apis/credentials', '/api/connect/google/callback', ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'], 'Usually reuses the OSHAL login OAuth client.'),
  oauth('gcp', 'Google Cloud', 'https://console.cloud.google.com/apis/credentials', '/api/connect/gcp/callback', ['GCP_CLIENT_ID', 'GCP_CLIENT_SECRET'], 'Restricted cloud scopes may require Google verification for non-owner users.'),
  oauth('google-home', 'Google Nest Device Access', 'https://console.nest.google.com/device-access', '/api/connect/google-home/callback', ['GOOGLE_HOME_CLIENT_ID', 'GOOGLE_HOME_CLIENT_SECRET', 'GOOGLE_HOME_PROJECT_ID'], 'Requires the one-time Google Device Access project setup.'),
  oauth('smartthings', 'SmartThings OAuth-In', 'https://developer.smartthings.com/', '/api/connect/smartthings/callback', ['SMARTTHINGS_CLIENT_ID', 'SMARTTHINGS_CLIENT_SECRET'], 'Create an OAuth-In app or use the checked-in SmartThings app definition.'),
  oauth('spotify', 'Spotify', 'https://developer.spotify.com/dashboard', '/api/connect/spotify/callback', ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'], 'Dev mode requires adding tester accounts in Spotify user management.'),
  oauth('github', 'GitHub OAuth App', 'https://github.com/settings/developers', '/api/connect/github/callback', ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'], 'OAuth app registration, not a GitHub App.'),
  oauth('dropbox', 'Dropbox App Console', 'https://www.dropbox.com/developers/apps', '/api/connect/dropbox/callback', ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'], 'Needs offline access for refresh tokens.'),
  oauth('slack', 'Slack App', 'https://api.slack.com/apps', '/api/connect/slack/callback', ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'], 'Use user token scopes for the personal feed.'),
  oauth('linkedin', 'LinkedIn Developer App', 'https://www.linkedin.com/developers/apps', '/api/connect/linkedin/callback', ['LINKEDIN_CLIENT_ID', 'LINKEDIN_PRIMARY_CLIENT_SECRET'], 'Posting requires w_member_social approval.'),
  oauth('twitter', 'X Developer Portal', 'https://developer.x.com/en/portal/dashboard', '/api/connect/twitter/callback', ['X_CLIENT_ID', 'X_CLIENT_SECRECT'], 'PKCE OAuth 2.0; typo var X_CLIENT_SECRECT is tolerated by existing code.'),
  oauth('facebook', 'Meta Login App', 'https://developers.facebook.com/apps/', '/auth/facebook/callback', ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'], 'Public profile/login connector only.'),
  oauth('meta-business', 'Meta Business / Pages App', 'https://developers.facebook.com/apps/', '/api/connect/meta-business/callback', ['META_APPID_OSHAL_BUSINESS', 'META_APPSECRET_OSHAL_BUSINESS'], 'Pages publishing requires Meta app review.'),
  oauth('outlook', 'Microsoft Entra App Registration', 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', '/api/connect/outlook/callback', ['AZURE_EMAIL_APPLICATION_ID', 'OUTLOOK_CLIENT_VALUE'], 'OUTLOOK_CLIENT_VALUE is the secret value, not the secret id.'),
  oauth('square', 'Square Developer App', 'https://developer.squareup.com/apps', '/api/connect/square/callback', ['SQUARE_CLIENT_ID', 'SQUARE_CLIENT_SECRET'], 'Sandbox by default unless SQUARE_ENV=production.'),
  oauth('paypal', 'PayPal Developer App', 'https://developer.paypal.com/dashboard/applications/sandbox', '/api/connect/paypal/callback', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'], 'Sandbox by default unless PAYPAL_ENV=production.'),
  token('tmdb', 'TMDB', 'https://www.themoviedb.org/settings/api', 'Paste a v3 API key or v4 read token on /utilities.'),
  token('jira', 'Jira API Token', 'https://id.atlassian.com/manage-profile/security/api-tokens', 'Store email + API token for HTTP Basic.'),
  token('walmart', 'Walmart Affiliate / Marketplace', 'https://developer.walmart.com/', 'Current flow is affiliate/deep-link config, not consumer checkout automation.'),
  token('uber', 'Uber Eats Config', 'https://developer.uber.com/', 'No third-party consumer Eats order API; OSHAL uses deep-link handoff.'),
  token('uber-rides', 'Uber Rides Config', 'https://developer.uber.com/', 'Rides request is deep-link handoff, not silent booking.'),
  token('gitlab', 'GitLab Personal Access Token', 'https://gitlab.com/-/user_settings/personal_access_tokens', 'Use least-privilege project/repo scopes.'),
  token('zoom', 'Zoom Marketplace', 'https://marketplace.zoom.us/', 'Create app or generate account-level credential as needed.'),
  token('calendly', 'Calendly API/Webhooks', 'https://calendly.com/integrations/api_webhooks', 'Token-based connector in current hub.'),
  token('hubspot', 'HubSpot Private Apps', 'https://app.hubspot.com/private-apps', 'Private-app token path.'),
  token('asana', 'Asana Developer Apps', 'https://app.asana.com/0/my-apps', 'Personal token or app credential path.'),
  token('airtable', 'Airtable Tokens', 'https://airtable.com/create/tokens', 'PAT path.'),
  token('stripe', 'Stripe API Keys', 'https://dashboard.stripe.com/apikeys', 'Use test keys unless explicitly validating live payments.'),
  token('sendgrid', 'SendGrid API Keys', 'https://app.sendgrid.com/settings/api_keys', 'Use restricted API key scopes.'),
  token('openai', 'OpenAI API Keys', 'https://platform.openai.com/api-keys', 'BYOK LLM provider path.'),
  token('sentry', 'Sentry Auth Tokens', 'https://sentry.io/settings/account/api/auth-tokens/', 'PAT path.'),
  token('vercel', 'Vercel Tokens', 'https://vercel.com/account/tokens', 'PAT path.'),
  token('netlify', 'Netlify Personal Access Tokens', 'https://app.netlify.com/user/applications#personal-access-tokens', 'PAT path.'),
  token('figma', 'Figma Personal Access Tokens', 'https://www.figma.com/developers/api#access-tokens', 'PAT path.'),
  token('todoist', 'Todoist Developer Token', 'https://todoist.com/app/settings/integrations/developer', 'PAT path.'),
  token('pinterest', 'Pinterest Apps', 'https://developers.pinterest.com/apps/', 'Developer app/token path.'),
  token('shippo', 'Shippo API', 'https://apps.goshippo.com/settings/api', 'API token path.'),
  token('raindrop', 'Raindrop Integrations', 'https://app.raindrop.io/settings/integrations', 'Token path.'),
  token('monzo', 'Monzo Developer', 'https://developers.monzo.com/', 'Developer token path.'),
  token('buttondown', 'Buttondown API', 'https://buttondown.com/settings/api', 'API token path.'),
  token('postmark', 'Postmark API Tokens', 'https://postmarkapp.com/support/article/1008-what-are-the-account-and-server-api-tokens', 'Server/account token path.'),
  token('unsplash', 'Unsplash Applications', 'https://unsplash.com/oauth/applications', 'Developer app/token path.'),
  token('oura', 'Oura Personal Access Tokens', 'https://cloud.ouraring.com/personal-access-tokens', 'PAT path.'),
  token('fitbit', 'Fitbit Developer Apps', 'https://dev.fitbit.com/apps', 'Developer app path.'),
  token('whoop', 'WHOOP Developer', 'https://developer.whoop.com/', 'Developer app path.'),
  token('strava', 'Strava API Settings', 'https://www.strava.com/settings/api', 'Developer app path.'),
];

void main().catch((error) => {
  console.error(`ERROR assisted onboarding crashed: ${(error as Error).message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const tasks = selectTasks(options);
  if (tasks.length === 0) throw new Error('No provider tasks selected.');
  if (options.mode === 'open-only' && !options.screenshotDir) {
    await openTasksWithCdpHttp(tasks, options);
    return;
  }
  const browser = await connectToChrome(options.cdpUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const report: ReportEntry[] = [];
  console.log(`Opening ${tasks.length} provider onboarding task(s) in ${options.mode} mode.`);
  console.log('Safety: this runner opens pages and records status only; it never fills or submits third-party forms.');

  for (let index = 0; index < tasks.length; index += options.batchSize) {
    const batch = tasks.slice(index, index + options.batchSize);
    for (const task of batch) {
      const url = urlFor(task, options);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((error) => {
        console.warn(`WARN ${task.id}: navigation issue: ${(error as Error).message}`);
      });
      const screenshot = options.screenshotDir
        ? await captureScreenshot(page, options.screenshotDir, task.id)
        : undefined;
      const status = options.mode === 'guided'
        ? await promptStatus(task, url)
        : 'opened';
      report.push({
        id: task.id,
        label: task.label,
        kind: task.kind,
        url,
        status,
        notes: notesFor(task, options),
        openedAt: new Date().toISOString(),
        screenshot,
      });
      if (options.mode === 'guided' && status === 'done') {
        await page.close().catch(() => {});
      }
    }
    if (options.mode === 'open-only' && index + options.batchSize < tasks.length) {
      await sleep(options.dwellMs);
    }
  }

  await writeReport(options.reportPath, report);
  console.log(`Report: ${path.relative(process.cwd(), path.resolve(options.reportPath)).replace(/\\/g, '/')}`);
}

async function openTasksWithCdpHttp(tasks: ProviderTask[], options: CliOptions): Promise<void> {
  const report: ReportEntry[] = [];
  console.log(`Opening ${tasks.length} provider onboarding task(s) through Chrome CDP HTTP.`);
  console.log('Safety: open-only mode creates tabs and records status only; it never attaches to page DOM.');
  for (let index = 0; index < tasks.length; index += options.batchSize) {
    const batch = tasks.slice(index, index + options.batchSize);
    await Promise.all(batch.map(async (task) => {
      const url = urlFor(task, options);
      const openedAt = new Date().toISOString();
      try {
        await openCdpTab(options.cdpUrl, url);
        report.push({
          id: task.id,
          label: task.label,
          kind: task.kind,
          url,
          status: 'opened',
          notes: notesFor(task, options),
          openedAt,
        });
      } catch (error) {
        report.push({
          id: task.id,
          label: task.label,
          kind: task.kind,
          url,
          status: 'blocked',
          notes: [...notesFor(task, options), `Open failed: ${error instanceof Error ? error.message : String(error)}`],
          openedAt,
        });
      }
    }));
    if (index + options.batchSize < tasks.length) await sleep(options.dwellMs);
  }
  await writeReport(options.reportPath, report);
  console.log(`Report: ${path.relative(process.cwd(), path.resolve(options.reportPath)).replace(/\\/g, '/')}`);
}

async function openCdpTab(cdpUrl: string, url: string): Promise<void> {
  const endpoint = `${trimSlash(cdpUrl)}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(endpoint, { method: 'PUT' });
  if (response.status === 405) response = await fetch(endpoint);
  if (!response.ok) throw new Error(`CDP open returned HTTP ${response.status}`);
}

async function connectToChrome(cdpUrl: string): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `Could not attach to Chrome at ${cdpUrl}. Launch it first:\n` +
      `  powershell -ExecutionPolicy Bypass -File scripts/launch-e2e-chrome.ps1\n` +
      `Then re-run this command. Original: ${(error as Error).message}`,
    );
  }
}

async function promptStatus(task: ProviderTask, url: string): Promise<TaskStatus> {
  console.log(`\n${task.id} - ${task.label}`);
  console.log(`URL: ${url}`);
  if (task.redirectPath) console.log(`Redirect path: ${task.redirectPath}`);
  if (task.envVars?.length) console.log(`Env vars: ${task.envVars.join(', ')}`);
  for (const note of task.notes) console.log(`- ${note}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Status after manual work [done/blocked/skip/opened]: ')).trim().toLowerCase();
    return answer === 'done' || answer === 'blocked' || answer === 'skip' ? answer : 'opened';
  } finally {
    rl.close();
  }
}

async function captureScreenshot(page: Page, dir: string, id: string): Promise<string> {
  mkdirSync(path.resolve(dir), { recursive: true });
  const file = path.resolve(dir, `${id}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return path.relative(process.cwd(), file).replace(/\\/g, '/');
}

async function writeReport(reportPath: string, entries: ReportEntry[]): Promise<void> {
  const resolved = path.resolve(reportPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const totals = entries.reduce<Record<TaskStatus, number>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1;
    return acc;
  }, { opened: 0, done: 0, blocked: 0, skip: 0 });
  writeFileSync(resolved, `${JSON.stringify({ generatedAt: new Date().toISOString(), totals, entries }, null, 2)}\n`, 'utf8');
}

function selectTasks(options: CliOptions): ProviderTask[] {
  const source = options.manifest ? loadManifest(options.manifest) : TASKS;
  if (options.providers.includes('all')) return source;
  const wanted = new Set(options.providers);
  return source.filter((task) => wanted.has(task.id));
}

function loadManifest(file: string): ProviderTask[] {
  const parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as ProviderTask[];
  if (!Array.isArray(parsed)) throw new Error('--manifest must be a JSON array of provider tasks.');
  return parsed.map((task) => {
    if (!task.id || !task.label || !task.kind || !task.url) throw new Error('manifest task missing id/label/kind/url.');
    return { ...task, notes: Array.isArray(task.notes) ? task.notes : [] };
  });
}

function urlFor(task: ProviderTask, options: CliOptions): string {
  if (options.target === 'registration') return task.url;
  if (task.kind === 'oauth-app') return `${trimSlash(options.baseUrl)}/api/connect/${encodeURIComponent(task.id)}/start`;
  return `${trimSlash(options.baseUrl)}/utilities`;
}

function notesFor(task: ProviderTask, options: CliOptions): string[] {
  return [
    ...task.notes,
    ...(task.redirectPath ? [`Redirect URI: ${trimSlash(options.baseUrl)}${task.redirectPath}`] : []),
    ...(task.envVars?.length ? [`Copy credentials into .env: ${task.envVars.join(', ')}`] : []),
  ];
}

function oauth(id: string, label: string, url: string, redirectPath: string, envVars: string[], note: string): ProviderTask {
  return {
    id,
    label,
    kind: 'oauth-app',
    url,
    redirectPath,
    envVars,
    notes: [
      'Use the business owner account unless the partner doc calls out an explicit exception.',
      'Do not let automation accept terms, complete MFA, or create paid resources.',
      note,
    ],
  };
}

function token(id: string, label: string, url: string, note: string): ProviderTask {
  return {
    id,
    label,
    kind: 'token',
    url,
    notes: [
      'Generate the token manually and paste it into OSHAL yourself; this runner does not read or store secrets.',
      note,
    ],
  };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: process.env.OSHAL_E2E_BASE_URL || process.env.APP_URL || 'https://oshal.agenticfederal.us',
    batchSize: 4,
    cdpUrl: process.env.OSHAL_E2E_CDP_URL || DEFAULT_CDP_URL,
    dwellMs: 10_000,
    mode: 'guided',
    providers: ['all'],
    reportPath: path.join('output', 'connectors', 'assisted-provider-onboarding-report.json'),
    target: 'registration',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--base-url') {
      options.baseUrl = requireValue(arg, next); index += 1;
    } else if (arg === '--batch-size') {
      options.batchSize = Number.parseInt(requireValue(arg, next), 10); index += 1;
    } else if (arg === '--cdp-url') {
      options.cdpUrl = requireValue(arg, next); index += 1;
    } else if (arg === '--dwell-ms') {
      options.dwellMs = Number.parseInt(requireValue(arg, next), 10); index += 1;
    } else if (arg === '--manifest') {
      options.manifest = requireValue(arg, next); index += 1;
    } else if (arg === '--mode') {
      options.mode = parseChoice<RunMode>(arg, requireValue(arg, next), ['guided', 'open-only']); index += 1;
    } else if (arg === '--providers') {
      options.providers = requireValue(arg, next).split(',').map((item) => item.trim()).filter(Boolean); index += 1;
    } else if (arg === '--report') {
      options.reportPath = requireValue(arg, next); index += 1;
    } else if (arg === '--screenshot-dir') {
      options.screenshotDir = requireValue(arg, next); index += 1;
    } else if (arg === '--target') {
      options.target = parseChoice<Target>(arg, requireValue(arg, next), ['registration', 'oshal-connect']); index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp(); process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) throw new Error('--batch-size must be positive.');
  if (!Number.isInteger(options.dwellMs) || options.dwellMs < 0) throw new Error('--dwell-ms must be zero or positive.');
  return options;
}

function parseChoice<T extends string>(flag: string, value: string, choices: T[]): T {
  if (!choices.includes(value as T)) throw new Error(`${flag} must be one of: ${choices.join(', ')}`);
  return value as T;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log([
    'Usage: npm run connectors:assisted-onboarding -- [options]',
    '',
    'Opens provider registration/connect pages in your CDP Chrome. Does not fill or submit forms.',
    '',
    'Options:',
    '  --providers <csv|all>        Provider ids to open. Default: all.',
    '  --target <registration|oshal-connect>  Open partner registration pages or OSHAL connect starts.',
    '  --mode <guided|open-only>    guided prompts for status; open-only opens pages and records opened.',
    '  --base-url <url>             OSHAL base URL for redirect notes/connect starts.',
    `  --cdp-url <url>              Chrome CDP endpoint. Default: ${DEFAULT_CDP_URL}`,
    '  --batch-size <n>             Pages opened before dwell pause in open-only mode. Default: 4.',
    '  --dwell-ms <n>               Pause between batches in open-only mode. Default: 10000.',
    '  --manifest <file>            JSON array of provider tasks instead of built-in curated list.',
    '  --screenshot-dir <dir>       Optional screenshot folder.',
    '  --report <file>              JSON report path.',
    '',
    'Before running, launch Chrome:',
    '  powershell -ExecutionPolicy Bypass -File scripts/launch-e2e-chrome.ps1',
  ].join('\n'));
}
