/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from ui-logic.js (1000-line cap decomposition): provider settings/secrets field definitions + display names (PROVIDER_CONFIG, PROVIDER_DISPLAY_NAMES)
 */

/**
 * @description Provider catalog (part 1 of 2) for the Phase 1 API config UI:
 * per-provider settings/secrets field definitions and human-readable display
 * names. Field definitions sourced from Cline source: state-keys.ts + provider
 * handlers. Plain browser script — src/api has no static mount, so this file
 * is served concatenated AHEAD of ui-logic.js by the GET /ui-logic.js route in
 * src/app/server.ts; the <script src="ui-logic.js"> tags in ui.html /
 * index.html / chat.html keep working unchanged.
 * @module ui-provider-fields
 */

// =============================================================================
// PROVIDER-SPECIFIC CONFIGURATION FIELDS
// Each provider defines its settings (non-secret) and secrets (sensitive) fields
// Field types: text, password, checkbox, number
// =============================================================================

/**
 * @description Per-provider configuration field definitions. `settings` are
 * non-secret fields; `secrets` are sensitive fields rendered as password
 * inputs. Consumed by renderProviderConfigFields() in ui-logic.js and exposed
 * on window for the auth patch scripts appended after it.
 */
const PROVIDER_CONFIG = {
  anthropic: {
    settings: [
      { key: 'anthropicBaseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.anthropic.com' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'claude-sonnet-4-6' },
      { key: 'thinkingBudgetTokens', label: 'Thinking Budget Tokens', type: 'number', placeholder: '10000' },
    ],
    secrets: [
      { key: 'apiKey', label: 'Anthropic API Key', type: 'password', placeholder: 'sk-ant-api03-...' },
    ],
  },
  'claude-code': {
    settings: [
      { key: 'claudeCodePath', label: 'Claude Code CLI Path', type: 'text', placeholder: '/usr/local/bin/claude' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'claude-sonnet-4-6' },
    ],
    secrets: [
      { key: 'anthropicApiKey', label: 'Anthropic API Key', type: 'password', placeholder: 'sk-ant-...' },
    ],
  },
  openrouter: {
    settings: [
      { key: 'openRouterModelId', label: 'Model ID', type: 'text', placeholder: 'anthropic/claude-sonnet-4.5' },
      { key: 'openRouterBaseUrl', label: 'Base URL', type: 'text', placeholder: 'https://openrouter.ai/api/v1' },
      { key: 'openRouterProviderSorting', label: 'Provider Sorting', type: 'text', placeholder: 'price' },
      { key: 'reasoningEffort', label: 'Reasoning Effort', type: 'text', placeholder: 'medium' },
      { key: 'thinkingBudgetTokens', label: 'Thinking Budget Tokens', type: 'number', placeholder: '10000' },
    ],
    secrets: [
      { key: 'openRouterApiKey', label: 'OpenRouter API Key', type: 'password', placeholder: 'sk-or-v1-...' },
    ],
  },
  bedrock: {
    settings: [
      { key: 'awsRegion', label: 'AWS Region', type: 'text', placeholder: 'us-east-1' },
      { key: 'awsAuthentication', label: 'Authentication Method', type: 'text', placeholder: 'credentials' },
      { key: 'awsUseCrossRegionInference', label: 'Use Cross-Region Inference', type: 'checkbox' },
      { key: 'awsUseGlobalInference', label: 'Use Global Inference', type: 'checkbox' },
      { key: 'awsBedrockUsePromptCache', label: 'Use Prompt Cache', type: 'checkbox' },
      { key: 'awsBedrockEndpoint', label: 'Custom Endpoint', type: 'text', placeholder: 'https://bedrock-runtime...' },
      { key: 'awsUseProfile', label: 'Use AWS Profile', type: 'checkbox' },
      { key: 'awsProfile', label: 'AWS Profile Name', type: 'text', placeholder: 'default' },
    ],
    secrets: [
      { key: 'awsAccessKey', label: 'AWS Access Key', type: 'password', placeholder: 'AKIA...' },
      { key: 'awsSecretKey', label: 'AWS Secret Key', type: 'password', placeholder: 'wJalr...' },
      { key: 'awsSessionToken', label: 'AWS Session Token', type: 'password', placeholder: 'FwoG...' },
      { key: 'awsBedrockApiKey', label: 'Bedrock API Key', type: 'password', placeholder: 'Optional API key...' },
    ],
  },
  vertex: {
    settings: [
      { key: 'vertexProjectId', label: 'Google Cloud Project ID', type: 'text', placeholder: 'my-gcp-project' },
      { key: 'vertexRegion', label: 'Region', type: 'text', placeholder: 'us-central1' },
      { key: 'geminiBaseUrl', label: 'Gemini Base URL', type: 'text', placeholder: 'Optional override...' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'gemini-2.5-pro' },
      { key: 'thinkingBudgetTokens', label: 'Thinking Budget Tokens', type: 'number', placeholder: '10000' },
    ],
    secrets: [
      { key: 'vertexCredentials', label: 'Vertex Credentials (JSON)', type: 'password', placeholder: '{"type":"service_account",...}' },
      { key: 'geminiApiKey', label: 'Gemini API Key', type: 'password', placeholder: 'AIzaSy...' },
    ],
  },
  openai: {
    settings: [
      { key: 'openAiBaseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'openAiHeaders', label: 'Custom Headers (JSON)', type: 'text', placeholder: '{"X-Custom":"value"}' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'gpt-4o' },
    ],
    secrets: [
      { key: 'openAiApiKey', label: 'OpenAI API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  'openai-native': {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'gpt-4.1' },
      { key: 'reasoningEffort', label: 'Reasoning Effort', type: 'text', placeholder: 'medium' },
      { key: 'thinkingBudgetTokens', label: 'Thinking Budget Tokens', type: 'number', placeholder: '10000' },
    ],
    secrets: [
      { key: 'openAiNativeApiKey', label: 'OpenAI API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  'openai-codex': {
    settings: [
      { key: 'openAiCodexProjectId', label: 'Codex Project ID', type: 'text', placeholder: 'proj_...' },
      { key: 'openAiCodexBaseUrl', label: 'Codex Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
    ],
    secrets: [
      { key: 'openAiCodexApiKey', label: 'Codex API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  gemini: {
    settings: [
      { key: 'geminiBaseUrl', label: 'Base URL', type: 'text', placeholder: 'https://generativelanguage.googleapis.com' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'gemini-2.5-pro' },
      { key: 'thinkingBudgetTokens', label: 'Thinking Budget Tokens', type: 'number', placeholder: '10000' },
      { key: 'reasoningEffort', label: 'Reasoning Effort', type: 'text', placeholder: 'medium' },
    ],
    secrets: [
      { key: 'geminiApiKey', label: 'Gemini API Key', type: 'password', placeholder: 'AIzaSy...' },
    ],
  },
  ollama: {
    settings: [
      { key: 'ollamaBaseUrl', label: 'Ollama Base URL', type: 'text', placeholder: 'http://localhost:11434' },
      { key: 'ollamaModelId', label: 'Model ID', type: 'text', placeholder: 'llama3.3:70b' },
      { key: 'ollamaApiOptionsCtxNum', label: 'Context Size', type: 'text', placeholder: '8192' },
      { key: 'requestTimeoutMs', label: 'Request Timeout (ms)', type: 'number', placeholder: '60000' },
    ],
    secrets: [
      { key: 'ollamaApiKey', label: 'Ollama API Key (optional)', type: 'password', placeholder: 'Optional...' },
    ],
  },
  lmstudio: {
    settings: [
      { key: 'lmStudioBaseUrl', label: 'LM Studio Base URL', type: 'text', placeholder: 'http://localhost:1234' },
      { key: 'lmStudioModelId', label: 'Model ID', type: 'text', placeholder: 'loaded-model-name' },
      { key: 'lmStudioMaxTokens', label: 'Max Tokens', type: 'text', placeholder: '4096' },
    ],
    secrets: [],
  },
  litellm: {
    settings: [
      { key: 'liteLlmBaseUrl', label: 'LiteLLM Base URL', type: 'text', placeholder: 'http://localhost:4000' },
      { key: 'liteLlmUsePromptCache', label: 'Use Prompt Cache', type: 'checkbox' },
    ],
    secrets: [
      { key: 'liteLlmApiKey', label: 'LiteLLM API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  deepseek: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'deepseek-chat' },
    ],
    secrets: [
      { key: 'deepSeekApiKey', label: 'DeepSeek API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  qwen: {
    settings: [
      { key: 'qwenApiLine', label: 'API Line', type: 'text', placeholder: 'international' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'qwen3-coder-plus' },
    ],
    secrets: [
      { key: 'qwenApiKey', label: 'Qwen API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  'qwen-code': {
    settings: [
      { key: 'qwenCodeOauthPath', label: 'OAuth Path', type: 'text', placeholder: '~/.qwen/oauth.json' },
    ],
    secrets: [
      { key: 'qwenCodeApiKey', label: 'Qwen Code API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  mistral: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'devstral-2512' },
    ],
    secrets: [
      { key: 'mistralApiKey', label: 'Mistral API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  groq: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'llama-3.3-70b-versatile' },
    ],
    secrets: [
      { key: 'groqApiKey', label: 'Groq API Key', type: 'password', placeholder: 'gsk_...' },
    ],
  },
  xai: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'grok-3-beta' },
    ],
    secrets: [
      { key: 'xaiApiKey', label: 'xAI API Key', type: 'password', placeholder: 'xai-...' },
    ],
  },
  together: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'togetherApiKey', label: 'Together API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  fireworks: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
      { key: 'fireworksModelMaxCompletionTokens', label: 'Max Completion Tokens', type: 'number', placeholder: '4096' },
      { key: 'fireworksModelMaxTokens', label: 'Max Tokens', type: 'number', placeholder: '16384' },
    ],
    secrets: [
      { key: 'fireworksApiKey', label: 'Fireworks API Key', type: 'password', placeholder: 'fw_...' },
    ],
  },
  cerebras: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'cerebrasApiKey', label: 'Cerebras API Key', type: 'password', placeholder: 'csk-...' },
    ],
  },
  sambanova: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'Meta-Llama-3.3-70B-Instruct' },
    ],
    secrets: [
      { key: 'sambanovaApiKey', label: 'SambaNova API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  nebius: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'deepseek-ai/DeepSeek-V3' },
    ],
    secrets: [
      { key: 'nebiusApiKey', label: 'Nebius API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  moonshot: {
    settings: [
      { key: 'moonshotApiLine', label: 'API Line', type: 'text', placeholder: 'international' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'kimi-k2.5' },
    ],
    secrets: [
      { key: 'moonshotApiKey', label: 'Moonshot API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  zai: {
    settings: [
      { key: 'zaiApiLine', label: 'API Line', type: 'text', placeholder: 'international' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'glm-4.7' },
    ],
    secrets: [
      { key: 'zaiApiKey', label: 'Z AI API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  huggingface: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'huggingFaceApiKey', label: 'Hugging Face API Key', type: 'password', placeholder: 'hf_...' },
    ],
  },
  asksage: {
    settings: [
      { key: 'asksageApiUrl', label: 'AskSage API URL', type: 'text', placeholder: 'https://api.asksage.ai' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'asksageApiKey', label: 'AskSage API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  'huawei-cloud-maas': {
    settings: [
      { key: 'huaweiCloudMaasModelId', label: 'Model ID', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'huaweiCloudMaasApiKey', label: 'Huawei Cloud API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  'vercel-ai-gateway': {
    settings: [
      { key: 'vercelAiGatewayBaseUrl', label: 'Gateway Base URL', type: 'text', placeholder: 'https://gateway.vercel.ai' },
      { key: 'vercelAiGatewayModelId', label: 'Model ID', type: 'text', placeholder: 'model-id' },
      { key: 'vercelAiGatewayProviderId', label: 'Provider ID', type: 'text', placeholder: 'anthropic' },
    ],
    secrets: [
      { key: 'vercelAiGatewayApiKey', label: 'Gateway API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  oca: {
    settings: [
      { key: 'ocaBaseUrl', label: 'OCA Base URL', type: 'text', placeholder: 'https://api.oca.ai' },
      { key: 'ocaModelId', label: 'Model ID', type: 'text', placeholder: 'model-id' },
      { key: 'ocaReasoningEffort', label: 'Reasoning Effort', type: 'text', placeholder: 'medium' },
      { key: 'ocaUsePromptCache', label: 'Use Prompt Cache', type: 'checkbox' },
      { key: 'ocaMode', label: 'Mode', type: 'text', placeholder: 'internal' },
    ],
    secrets: [
      { key: 'ocaApiKey', label: 'OCA API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  aihubmix: {
    settings: [
      { key: 'aihubmixBaseUrl', label: 'AIHubMix Base URL', type: 'text', placeholder: 'https://api.aihubmix.com' },
      { key: 'aihubmixModelId', label: 'Model ID', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'aihubmixApiKey', label: 'AIHubMix API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  minimax: {
    settings: [
      { key: 'minimaxApiLine', label: 'API Line', type: 'text', placeholder: 'international' },
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'minimaxApiKey', label: 'MiniMax API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  hicap: {
    settings: [
      { key: 'hicapBaseUrl', label: 'HiCap Base URL', type: 'text', placeholder: 'https://api.hicap.ai' },
      { key: 'hicapModelId', label: 'Model ID', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'hicapApiKey', label: 'HiCap API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  nousResearch: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'nousResearchApiKey', label: 'Nous Research API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  doubao: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'doubaoApiKey', label: 'Doubao API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  requesty: {
    settings: [
      { key: 'requestyBaseUrl', label: 'Requesty Base URL', type: 'text', placeholder: 'https://router.requesty.ai/v1' },
      { key: 'requestyModelId', label: 'Model ID', type: 'text', placeholder: 'model-id' },
      { key: 'reasoningEffort', label: 'Reasoning Effort', type: 'text', placeholder: 'medium' },
      { key: 'thinkingBudgetTokens', label: 'Thinking Budget Tokens', type: 'number', placeholder: '10000' },
    ],
    secrets: [
      { key: 'requestyApiKey', label: 'Requesty API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  dify: {
    settings: [
      { key: 'difyBaseUrl', label: 'Dify Base URL', type: 'text', placeholder: 'https://api.dify.ai/v1' },
      { key: 'difyWorkflowId', label: 'Workflow ID', type: 'text', placeholder: 'wf_...' },
    ],
    secrets: [
      { key: 'difyApiKey', label: 'Dify API Key', type: 'password', placeholder: 'app-...' },
    ],
  },
  baseten: {
    settings: [
      { key: 'apiModelId', label: 'Model ID Override', type: 'text', placeholder: 'model-id' },
    ],
    secrets: [
      { key: 'basetenApiKey', label: 'Baseten API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  'vscode-lm': {
    settings: [
      { key: 'vsCodeLmModelSelector', label: 'Model Selector (JSON)', type: 'text', placeholder: '{"vendor":"copilot","family":"gpt-4o"}' },
    ],
    secrets: [],
  },
  cline: {
    settings: [
      { key: 'clineAccountId', label: 'Cline Account ID', type: 'text', placeholder: 'Account ID...' },
    ],
    secrets: [
      { key: 'clineApiKey', label: 'Cline API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
};
window.PROVIDER_CONFIG = PROVIDER_CONFIG;

/**
 * @description Human-readable display names per provider key, exposed on
 * window for the auth patch scripts appended after this file.
 */
const PROVIDER_DISPLAY_NAMES = {
  anthropic: 'Anthropic',
  'claude-code': 'Claude Code',
  openrouter: 'OpenRouter',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  openai: 'OpenAI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  gemini: 'Google Gemini',
  'openai-native': 'OpenAI Native',
  'openai-codex': 'OpenAI Codex',
  requesty: 'Requesty',
  together: 'Together AI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  'qwen-code': 'Qwen Code',
  doubao: 'Doubao',
  mistral: 'Mistral AI',
  'vscode-lm': 'VS Code Language Models',
  cline: 'Cline',
  litellm: 'LiteLLM',
  moonshot: 'Moonshot AI',
  nebius: 'Nebius AI Studio',
  fireworks: 'Fireworks AI',
  asksage: 'AskSage',
  xai: 'xAI',
  sambanova: 'SambaNova',
  cerebras: 'Cerebras',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  'huawei-cloud-maas': 'Huawei Cloud MaaS',
  dify: 'Dify',
  baseten: 'Baseten',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  zai: 'Z AI',
  oca: 'OCA',
  aihubmix: 'AIHubMix',
  minimax: 'MiniMax',
  hicap: 'HiCap',
  nousResearch: 'Nous Research',
};
window.PROVIDER_DISPLAY_NAMES = PROVIDER_DISPLAY_NAMES;

// Display provider count and keys in the output div for debugging
document.addEventListener('DOMContentLoaded', function() {
  const output = document.getElementById('output');
  if (output) {
    const keys = Object.keys(PROVIDER_CONFIG);
    output.innerHTML += `<pre>Provider count: ${keys.length}\nProviders: ${keys.join(', ')}</pre>`;
  }
});
