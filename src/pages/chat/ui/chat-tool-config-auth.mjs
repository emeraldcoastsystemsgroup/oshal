/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted tool auth normalization and dynamic field rendering from chat config modal script
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added OAuth access token support for token-gated GitHub and GitLab tool activation in standalone chat
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Defaulted OAuth flow normalization so PAT-based repo tool config still satisfies backend schema validation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added centralized runtime field rendering so required tool endpoint fields are visible in Tools settings
 */

import { renderToolRuntimeFields } from '/chat-assets/chat-tool-config-specs.mjs';

const AUTH_TYPES = ['none', 'api_key', 'bearer', 'basic', 'oauth2', 'certificate', 'vault', 'aws', 'gcp', 'azure', 'kubeconfig'];
const OAUTH_FLOWS = ['authorization_code', 'client_credentials', 'device_code', 'pkce'];

/**
 * @description Resolves the default auth type for a tool based on auth group metadata.
 * @param {Record<string, unknown>} tool Tool association entry from API.
 * @returns {string} Default auth type.
 */
export function getDefaultToolAuthType(tool) {
  const authGroup = readString(tool?.tool?.authGroup);
  const authByGroup = {
    aws: 'aws',
    gcp: 'gcp',
    azure: 'azure',
    github: 'oauth2',
    gitlab: 'oauth2',
    kubernetes: 'kubeconfig',
    vault: 'vault',
    terraform: 'api_key',
  };
  return authByGroup[authGroup] || 'none';
}

/**
 * @description Normalizes raw tool config into a predictable auth/config object shape.
 * @param {Record<string, unknown>} tool Tool association entry from API.
 * @param {unknown} rawConfig Raw tool config payload.
 * @returns {Record<string, unknown>} Normalized tool config.
 */
export function normalizeToolConfig(tool, rawConfig) {
  const config = asRecord(rawConfig);
  const auth = asRecord(config.auth);
  return {
    auth: {
      type: readString(auth.type) || getDefaultToolAuthType(tool),
      enabled: Boolean(auth.enabled),
      apiKey: readString(auth.apiKey),
      bearerToken: readString(auth.bearerToken),
      basic: normalizeBasicAuth(auth.basic),
      oauth2: normalizeOauth2Auth(auth.oauth2),
      certificate: normalizeCertificateAuth(auth.certificate),
      vault: normalizeVaultAuth(auth.vault),
      aws: normalizeAwsAuth(auth.aws),
      gcp: normalizeGcpAuth(auth.gcp),
      azure: normalizeAzureAuth(auth.azure),
      kubeconfig: normalizeKubeconfigAuth(auth.kubeconfig),
    },
    env: asRecord(config.env),
    endpoint: asRecord(config.endpoint),
    metadata: asRecord(config.metadata),
  };
}

/**
 * @description Builds a short auth summary string for switch-framework rows.
 * @param {Record<string, unknown>} config Normalized tool config.
 * @returns {string} Auth summary.
 */
export function getToolAuthSummary(config) {
  const auth = asRecord(config?.auth);
  const authType = readString(auth.type) || 'none';
  return auth.enabled ? `${authType} · enabled` : `${authType} · disabled`;
}

/**
 * @description Renders tool auth field markup for a specific tool profile.
 * @param {{ tool: Record<string, unknown>, config: Record<string, unknown>, escapeHtml: (value: string) => string }} params Render context.
 * @returns {string} HTML string for tool auth fields.
 */
export function getToolAuthFields(params) {
  const tool = asRecord(params.tool);
  const config = asRecord(params.config);
  const escapeHtml = params.escapeHtml;
  const auth = asRecord(config.auth);
  const authType = readString(auth.type) || getDefaultToolAuthType(tool);
  const fields = [buildAuthBaseFields(tool, auth, authType, escapeHtml)];

  const renderer = getTypeRenderer(authType);
  if (renderer) {
    fields.push(renderer(tool, auth, escapeHtml));
  }

  fields.push(renderToolRuntimeFields({ tool, config, escapeHtml }));

  return fields.join('');
}

/**
 * @description Returns a deep-cloned config object with a leaf path value updated.
 * @param {Record<string, unknown>} config Existing config object.
 * @param {string} path Dot-separated path.
 * @param {unknown} rawValue Value to assign.
 * @returns {Record<string, unknown>} Updated config object.
 */
export function setConfigValue(config, path, rawValue) {
  const nextConfig = JSON.parse(JSON.stringify(config || {}));
  const segments = path.split('.');
  let current = nextConfig;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!isRecord(current[key])) {
      current[key] = {};
    }
    current = current[key];
  }

  current[segments[segments.length - 1]] = rawValue;
  return nextConfig;
}

function normalizeBasicAuth(value) {
  const basic = asRecord(value);
  return {
    username: readString(basic.username),
    password: readString(basic.password),
  };
}

function normalizeOauth2Auth(value) {
  const oauth2 = asRecord(value);
  const scopes = Array.isArray(oauth2.scopes)
    ? oauth2.scopes.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];

  return {
    // PAT-style tool setup still passes through the OAuth-shaped schema on the backend,
    // so we keep a valid default flow even when the user only fills the token field.
    flow: readString(oauth2.flow) || 'authorization_code',
    authorizeUrl: readString(oauth2.authorizeUrl),
    tokenUrl: readString(oauth2.tokenUrl),
    clientId: readString(oauth2.clientId),
    clientSecret: readString(oauth2.clientSecret),
    accessToken: readString(oauth2.accessToken),
    redirectUri: readString(oauth2.redirectUri),
    audience: readString(oauth2.audience),
    scopes,
  };
}

function normalizeCertificateAuth(value) {
  const cert = asRecord(value);
  return {
    certPem: readString(cert.certPem),
    keyPem: readString(cert.keyPem),
    caPem: readString(cert.caPem),
    passphrase: readString(cert.passphrase),
  };
}

function normalizeVaultAuth(value) {
  const vault = asRecord(value);
  return {
    address: readString(vault.address),
    namespace: readString(vault.namespace),
    mount: readString(vault.mount),
    secretPath: readString(vault.secretPath),
    roleId: readString(vault.roleId),
    secretId: readString(vault.secretId),
  };
}

function normalizeAwsAuth(value) {
  const aws = asRecord(value);
  return {
    profile: readString(aws.profile),
    region: readString(aws.region),
    accessKeyId: readString(aws.accessKeyId),
    secretAccessKey: readString(aws.secretAccessKey),
    sessionToken: readString(aws.sessionToken),
  };
}

function normalizeGcpAuth(value) {
  const gcp = asRecord(value);
  return {
    projectId: readString(gcp.projectId),
    serviceAccountJson: readString(gcp.serviceAccountJson),
  };
}

function normalizeAzureAuth(value) {
  const azure = asRecord(value);
  return {
    tenantId: readString(azure.tenantId),
    clientId: readString(azure.clientId),
    clientSecret: readString(azure.clientSecret),
    subscriptionId: readString(azure.subscriptionId),
  };
}

function normalizeKubeconfigAuth(value) {
  const kubeconfig = asRecord(value);
  return {
    path: readString(kubeconfig.path),
    context: readString(kubeconfig.context),
    namespace: readString(kubeconfig.namespace),
  };
}

function buildAuthBaseFields(tool, auth, authType, escapeHtml) {
  const toolId = escapeHtml(readString(tool.toolId));
  const authTypeOptions = AUTH_TYPES
    .map((option) => `<option value="${option}" ${authType === option ? 'selected' : ''}>${option}</option>`)
    .join('');

  return `
    <div class="tool-config-field">
      <label>Auth Type</label>
      <select class="config-select" data-tool-id="${toolId}" data-config-path="auth.type">
        ${authTypeOptions}
      </select>
    </div>
    <div class="tool-config-field">
      <label>Auth Enabled</label>
      <label class="auth-chip">
        <input type="checkbox" data-tool-id="${toolId}" data-config-path="auth.enabled" ${auth.enabled ? 'checked' : ''}>
        Enabled
      </label>
    </div>
  `;
}

function getTypeRenderer(authType) {
  const renderers = {
    api_key: renderApiKeyFields,
    bearer: renderBearerFields,
    basic: renderBasicFields,
    oauth2: renderOauth2Fields,
    certificate: renderCertificateFields,
    vault: renderVaultFields,
    aws: renderAwsFields,
    gcp: renderGcpFields,
    azure: renderAzureFields,
    kubeconfig: renderKubeconfigFields,
  };
  return renderers[authType] || null;
}

function renderApiKeyFields(tool, auth, escapeHtml) {
  return buildSingleInputField(tool, escapeHtml, {
    label: 'API Key',
    path: 'auth.apiKey',
    value: auth.apiKey,
    type: 'password',
    wide: true,
  });
}

function renderBearerFields(tool, auth, escapeHtml) {
  return buildSingleInputField(tool, escapeHtml, {
    label: 'Bearer Token',
    path: 'auth.bearerToken',
    value: auth.bearerToken,
    type: 'password',
    wide: true,
  });
}

function renderBasicFields(tool, auth, escapeHtml) {
  return [
    buildSingleInputField(tool, escapeHtml, {
      label: 'Username',
      path: 'auth.basic.username',
      value: auth?.basic?.username,
      type: 'text',
    }),
    buildSingleInputField(tool, escapeHtml, {
      label: 'Password',
      path: 'auth.basic.password',
      value: auth?.basic?.password,
      type: 'password',
    }),
  ].join('');
}

function renderOauth2Fields(tool, auth, escapeHtml) {
  const flow = readString(auth?.oauth2?.flow);
  const flowOptions = OAUTH_FLOWS
    .map((option) => `<option value="${option}" ${flow === option ? 'selected' : ''}>${option}</option>`)
    .join('');

  return [
    buildSelectField(tool, escapeHtml, 'Flow', 'auth.oauth2.flow', flowOptions),
    buildSingleInputField(tool, escapeHtml, { label: 'Access Token / PAT', path: 'auth.oauth2.accessToken', value: auth?.oauth2?.accessToken, type: 'password' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Client ID', path: 'auth.oauth2.clientId', value: auth?.oauth2?.clientId, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Client Secret', path: 'auth.oauth2.clientSecret', value: auth?.oauth2?.clientSecret, type: 'password' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Token URL', path: 'auth.oauth2.tokenUrl', value: auth?.oauth2?.tokenUrl, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, {
      label: 'Scopes (comma-separated)',
      path: 'auth.oauth2.scopes',
      value: Array.isArray(auth?.oauth2?.scopes) ? auth.oauth2.scopes.join(', ') : '',
      type: 'text',
      wide: true,
    }),
  ].join('');
}

function renderCertificateFields(tool, auth, escapeHtml) {
  return [
    buildTextareaField(tool, escapeHtml, {
      label: 'Client Certificate PEM',
      path: 'auth.certificate.certPem',
      value: auth?.certificate?.certPem,
      wide: true,
    }),
    buildTextareaField(tool, escapeHtml, {
      label: 'Client Key PEM',
      path: 'auth.certificate.keyPem',
      value: auth?.certificate?.keyPem,
      wide: true,
    }),
  ].join('');
}

function renderVaultFields(tool, auth, escapeHtml) {
  return [
    buildSingleInputField(tool, escapeHtml, { label: 'Vault Address', path: 'auth.vault.address', value: auth?.vault?.address, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Secret Path', path: 'auth.vault.secretPath', value: auth?.vault?.secretPath, type: 'text' }),
  ].join('');
}

function renderAwsFields(tool, auth, escapeHtml) {
  return [
    buildSingleInputField(tool, escapeHtml, { label: 'AWS Profile', path: 'auth.aws.profile', value: auth?.aws?.profile, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, { label: 'AWS Region', path: 'auth.aws.region', value: auth?.aws?.region, type: 'text' }),
  ].join('');
}

function renderGcpFields(tool, auth, escapeHtml) {
  return [
    buildSingleInputField(tool, escapeHtml, { label: 'GCP Project ID', path: 'auth.gcp.projectId', value: auth?.gcp?.projectId, type: 'text' }),
    buildTextareaField(tool, escapeHtml, {
      label: 'Service Account JSON',
      path: 'auth.gcp.serviceAccountJson',
      value: auth?.gcp?.serviceAccountJson,
      wide: true,
    }),
  ].join('');
}

function renderAzureFields(tool, auth, escapeHtml) {
  return [
    buildSingleInputField(tool, escapeHtml, { label: 'Tenant ID', path: 'auth.azure.tenantId', value: auth?.azure?.tenantId, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Client ID', path: 'auth.azure.clientId', value: auth?.azure?.clientId, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Client Secret', path: 'auth.azure.clientSecret', value: auth?.azure?.clientSecret, type: 'password' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Subscription ID', path: 'auth.azure.subscriptionId', value: auth?.azure?.subscriptionId, type: 'text' }),
  ].join('');
}

function renderKubeconfigFields(tool, auth, escapeHtml) {
  return [
    buildSingleInputField(tool, escapeHtml, { label: 'Kubeconfig Path', path: 'auth.kubeconfig.path', value: auth?.kubeconfig?.path, type: 'text' }),
    buildSingleInputField(tool, escapeHtml, { label: 'Kube Context', path: 'auth.kubeconfig.context', value: auth?.kubeconfig?.context, type: 'text' }),
  ].join('');
}

function buildSelectField(tool, escapeHtml, label, path, optionsHtml) {
  const toolId = escapeHtml(readString(tool.toolId));
  const safeLabel = escapeHtml(label);
  return `
    <div class="tool-config-field">
      <label>${safeLabel}</label>
      <select class="config-select" data-tool-id="${toolId}" data-config-path="${escapeHtml(path)}">
        ${optionsHtml}
      </select>
    </div>
  `;
}

function buildSingleInputField(tool, escapeHtml, options) {
  const toolId = escapeHtml(readString(tool.toolId));
  const wrapperClass = options.wide ? 'tool-config-field config-field-wide' : 'tool-config-field';
  return `
    <div class="${wrapperClass}">
      <label>${escapeHtml(options.label)}</label>
      <input class="config-input" type="${escapeHtml(options.type)}" data-tool-id="${toolId}" data-config-path="${escapeHtml(options.path)}" value="${escapeHtml(readString(options.value))}">
    </div>
  `;
}

function buildTextareaField(tool, escapeHtml, options) {
  const toolId = escapeHtml(readString(tool.toolId));
  const wrapperClass = options.wide ? 'tool-config-field config-field-wide' : 'tool-config-field';
  return `
    <div class="${wrapperClass}">
      <label>${escapeHtml(options.label)}</label>
      <textarea class="config-textarea tool-config-textarea" data-tool-id="${toolId}" data-config-path="${escapeHtml(options.path)}">${escapeHtml(readString(options.value))}</textarea>
    </div>
  `;
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
