/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Resynced openai-codex provider metadata to current upstream Cline model IDs and restored the GPT-5.x Codex variants the UI is supposed to mirror
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — comprehensive provider definitions ported from any-bot LLMProviderRegistry.js + Phase 1 ui-logic.js
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added GPT-5.3/5.2/5.1 Codex models and GPT-5/4.1 to openai-native so cockpit model dropdown matches any-bot parity
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Removed fictional gpt-5.x-codex model IDs from openai-codex; aligned with real OpenAI API model IDs matching Cline VS Code plugin
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Rewrote the PROVIDER_DEFINITIONS docstring: it quoted the two SOURCE files' provider counts (22 / 41), which readers kept mistaking for the total (actually 42). The public site's provider claim is now counted from this array by a deploy gate (scripts/site-apps-catalog.js), so the comment must not offer a competing number.
 */

import type { ProviderInfo, ModelInfo, ModelPricing, ModelCapabilities } from './provider-registry';

/**
 * @description Helper to create a ModelInfo with standard capabilities.
 * @param id - Model identifier
 * @param name - Display name
 * @param maxTokens - Maximum context window
 * @param inputPrice - Input price per million tokens
 * @param outputPrice - Output price per million tokens
 * @param caps - Optional capability overrides
 * @returns ModelInfo object
 */
function m(
  id: string, name: string, maxTokens: number,
  inputPrice: number, outputPrice: number,
  caps?: Partial<ModelCapabilities>,
): ModelInfo {
  return {
    id,
    name,
    maxTokens,
    pricing: { inputPerMillion: inputPrice, outputPerMillion: outputPrice },
    capabilities: {
      streaming: true,
      toolUse: true,
      vision: true,
      extendedThinking: false,
      promptCaching: false,
      ...caps,
    },
  };
}

/**
 * @description Every LLM provider the registry can offer — the merged union of any-bot's
 * LLMProviderRegistry.js and the Phase 1 ui-logic.js PROVIDER_CONFIG. Hosted vendors AND local
 * runtimes both live here: `ollama` / `lmstudio` / `litellm` are PROVIDERS, not harnesses — they
 * run under the cline harness. Adding an entry here is what makes it selectable in the cockpit.
 *
 * Count this array if you need the number — do NOT trust a comment. The previous docstring quoted
 * the two SOURCE files' counts ("22 providers", "41 providers"), which readers kept reading as the
 * total; public claims on the product site are made from this list, so the total must be counted,
 * never quoted from prose that can drift.
 */
export const PROVIDER_DEFINITIONS: ProviderInfo[] = [
  // ── Anthropic ──────────────────────────────────────────────
  {
    id: 'anthropic',
    displayName: 'Anthropic Direct',
    description: 'Direct Anthropic API access',
    defaultModelId: 'claude-sonnet-4-20250514',
    requiresApiKey: true,
    configKeys: ['anthropicApiKey'],
    models: [
      m('claude-sonnet-4-20250514', 'Claude Sonnet 4', 200000, 3, 15),
      m('claude-sonnet-4-6', 'Claude Sonnet 4.6', 200000, 3, 15),
      m('claude-opus-4-20250514', 'Claude Opus 4', 200000, 15, 75),
      m('claude-opus-4-6', 'Claude Opus 4.6', 200000, 15, 75),
      m('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 1, 5),
      m('claude-3-7-sonnet-20250219', 'Claude 3.7 Sonnet', 200000, 3, 15, { extendedThinking: true }),
      m('claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet v2', 200000, 3, 15),
      m('claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', 200000, 1, 5),
      m('claude-3-opus-20240229', 'Claude 3 Opus', 200000, 15, 75),
      m('claude-3-haiku-20240307', 'Claude 3 Haiku', 200000, 0.25, 1.25),
    ],
  },

  // ── Claude Code ────────────────────────────────────────────
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Claude Code — authenticate via OAuth or API key',
    defaultModelId: 'sonnet',
    requiresApiKey: true,
    configKeys: ['anthropicApiKey', 'claudeCodePath'],
    models: [
      m('sonnet', 'Claude Sonnet (default)', 200000, 0, 0),
      m('opus', 'Claude Opus', 200000, 0, 0),
      m('haiku', 'Claude Haiku', 200000, 0, 0),
    ],
  },

  // ── OpenRouter ─────────────────────────────────────────────
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    description: '100+ models via one API',
    defaultModelId: 'anthropic/claude-3.5-sonnet',
    requiresApiKey: true,
    configKeys: ['openRouterApiKey'],
    models: [
      m('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet', 200000, 3, 15),
      m('openai/gpt-4o', 'GPT-4o', 128000, 5, 15),
      m('google/gemini-pro-1.5', 'Gemini Pro 1.5', 1000000, 1.25, 5),
      m('deepseek/deepseek-r1', 'DeepSeek R1', 64000, 0.55, 2.19),
    ],
  },

  // ── AWS Bedrock ────────────────────────────────────────────
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    description: 'AWS Bedrock managed LLM access',
    defaultModelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
    requiresApiKey: false,
    configKeys: ['awsAccessKey', 'awsSecretKey', 'awsRegion', 'awsSessionToken', 'awsProfile'],
    models: [
      m('anthropic.claude-sonnet-4-20250514-v1:0', 'Claude Sonnet 4 (Bedrock)', 200000, 3, 15),
      m('anthropic.claude-3-5-sonnet-20241022-v2:0', 'Claude 3.5 Sonnet v2 (Bedrock)', 200000, 3, 15),
      m('anthropic.claude-3-5-haiku-20241022-v1:0', 'Claude 3.5 Haiku (Bedrock)', 200000, 1, 5),
      m('anthropic.claude-3-opus-20240229-v1:0', 'Claude 3 Opus (Bedrock)', 200000, 15, 75),
      m('anthropic.claude-3-7-sonnet-20250219-v1:0', 'Claude 3.7 Sonnet (Bedrock)', 200000, 3, 15),
    ],
  },

  // ── Google Vertex AI ───────────────────────────────────────
  {
    id: 'vertex',
    displayName: 'Google Vertex AI',
    description: 'Google Cloud Vertex AI',
    defaultModelId: 'gemini-3-pro-preview',
    requiresApiKey: false,
    configKeys: ['vertexProjectId', 'vertexRegion'],
    models: [
      m('gemini-3-pro-preview', 'Gemini 3 Pro Preview', 1000000, 1.25, 5),
      m('claude-3-5-sonnet-v2@20241022', 'Claude 3.5 Sonnet v2 (Vertex)', 200000, 3, 15),
      m('gemini-2.5-pro', 'Gemini 2.5 Pro', 1000000, 1.25, 5),
    ],
  },

  // ── OpenAI ─────────────────────────────────────────────────
  {
    id: 'openai',
    displayName: 'OpenAI',
    description: 'Direct OpenAI API',
    defaultModelId: 'gpt-4o',
    requiresApiKey: true,
    configKeys: ['openAiApiKey'],
    models: [
      m('gpt-4o', 'GPT-4o', 128000, 5, 15),
      m('gpt-4o-mini', 'GPT-4o Mini', 128000, 0.15, 0.6),
      m('o1-preview', 'o1 Preview', 128000, 15, 60),
      m('gpt-4-turbo', 'GPT-4 Turbo', 128000, 10, 30),
      m('gpt-3.5-turbo', 'GPT-3.5 Turbo', 16385, 0.5, 1.5),
    ],
  },

  // ── OpenAI Native ──────────────────────────────────────────
  {
    id: 'openai-native',
    displayName: 'OpenAI Native',
    description: 'OpenAI API (native format)',
    defaultModelId: 'gpt-5.2',
    requiresApiKey: true,
    configKeys: ['openAiNativeApiKey'],
    models: [
      m('gpt-5.2', 'GPT-5.2', 128000, 10, 30),
      m('gpt-5.1', 'GPT-5.1', 128000, 10, 30),
      m('gpt-5', 'GPT-5', 128000, 10, 30),
      m('gpt-4.1', 'GPT-4.1', 128000, 5, 15),
      m('o4-mini', 'o4 Mini', 128000, 5, 15),
      m('gpt-4o', 'GPT-4o', 128000, 5, 15),
    ],
  },

  // ── OpenAI Codex ───────────────────────────────────────────
  {
    id: 'openai-codex',
    displayName: 'OpenAI Codex',
    description: 'OpenAI Codex — ChatGPT/OpenAI account OAuth sign-in. No manual API key required.',
    defaultModelId: 'gpt-5.3-codex',
    requiresApiKey: false,
    configKeys: [],
    models: [
      m('gpt-5.4', 'GPT-5.4', 400000, 0, 0),
      m('gpt-5.3-codex', 'GPT-5.3 Codex', 400000, 0, 0),
      m('gpt-5.2-codex', 'GPT-5.2 Codex', 400000, 0, 0),
      m('gpt-5.1-codex-max', 'GPT-5.1 Codex Max', 400000, 0, 0),
      m('gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', 400000, 0, 0),
      m('gpt-5.2', 'GPT-5.2', 400000, 0, 0),
    ],
  },

  // ── Google Gemini ──────────────────────────────────────────
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    description: 'Google Gemini API',
    defaultModelId: 'gemini-3.1-pro-preview',
    requiresApiKey: true,
    configKeys: ['geminiApiKey'],
    models: [
      m('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1000000, 1.25, 5),
      m('gemini-2.5-pro', 'Gemini 2.5 Pro', 1000000, 1.25, 5),
      m('gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000, 0.075, 0.3),
      m('gemini-2.0-flash-001', 'Gemini 2.0 Flash', 1000000, 0.075, 0.3),
    ],
  },

  // ── Ollama ─────────────────────────────────────────────────
  {
    id: 'ollama',
    displayName: 'Ollama (Local)',
    description: 'Local models via Ollama',
    defaultModelId: 'llama3.1:70b',
    requiresApiKey: false,
    configKeys: ['ollamaBaseUrl', 'ollamaModelId', 'ollamaApiOptionsCtxNum'],
    models: [
      m('llama3.1:70b', 'Llama 3.1 70B', 128000, 0, 0),
      m('llama3.1:8b', 'Llama 3.1 8B', 128000, 0, 0),
      m('mistral:7b', 'Mistral 7B', 32768, 0, 0),
      m('codellama:34b', 'CodeLlama 34B', 16384, 0, 0),
    ],
  },

  // ── LM Studio ─────────────────────────────────────────────
  {
    id: 'lmstudio',
    displayName: 'LM Studio (Local)',
    description: 'Local models via LM Studio',
    defaultModelId: 'local-model',
    requiresApiKey: false,
    configKeys: ['lmStudioBaseUrl', 'lmStudioModelId'],
    models: [
      m('local-model', 'Use currently loaded model', 128000, 0, 0),
    ],
  },

  // ── LiteLLM ────────────────────────────────────────────────
  {
    id: 'litellm',
    displayName: 'LiteLLM Proxy',
    description: 'LiteLLM proxy server',
    defaultModelId: 'gpt-4o',
    requiresApiKey: false,
    configKeys: ['liteLlmBaseUrl'],
    models: [
      m('gpt-4o', 'GPT-4o (via proxy)', 128000, 0, 0),
      m('claude-3-5-sonnet', 'Claude 3.5 Sonnet (via proxy)', 200000, 0, 0),
    ],
  },

  // ── DeepSeek ───────────────────────────────────────────────
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    description: 'DeepSeek API',
    defaultModelId: 'deepseek-chat',
    requiresApiKey: true,
    configKeys: ['deepSeekApiKey'],
    models: [
      m('deepseek-chat', 'DeepSeek V3 Chat', 64000, 0.27, 1.1),
      m('deepseek-reasoner', 'DeepSeek R1', 64000, 0.55, 2.19),
    ],
  },

  // ── Qwen ───────────────────────────────────────────────────
  {
    id: 'qwen',
    displayName: 'Qwen',
    description: 'Alibaba Qwen models',
    defaultModelId: 'qwen-max',
    requiresApiKey: true,
    configKeys: ['qwenApiKey'],
    models: [
      m('qwen-max', 'Qwen Max', 32768, 0, 0),
      m('qwen-plus', 'Qwen Plus', 32768, 0, 0),
    ],
  },

  // ── Qwen Code ──────────────────────────────────────────────
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    description: 'Alibaba Qwen code models',
    defaultModelId: 'qwen-coder-plus-latest',
    requiresApiKey: true,
    configKeys: ['qwenApiKey'],
    models: [
      m('qwen-coder-plus-latest', 'Qwen Coder Plus', 131072, 0, 0),
    ],
  },

  // ── Mistral ────────────────────────────────────────────────
  {
    id: 'mistral',
    displayName: 'Mistral AI',
    description: 'Mistral AI API',
    defaultModelId: 'devstral-2512',
    requiresApiKey: true,
    configKeys: ['mistralApiKey'],
    models: [
      m('devstral-2512', 'Devstral 2512', 128000, 0.2, 0.6),
      m('mistral-large-2512', 'Mistral Large', 128000, 2, 6),
      m('mistral-small-latest', 'Mistral Small', 32768, 0.2, 0.6),
    ],
  },

  // ── Groq ───────────────────────────────────────────────────
  {
    id: 'groq',
    displayName: 'Groq',
    description: 'Groq ultra-fast inference',
    defaultModelId: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    requiresApiKey: true,
    configKeys: ['groqApiKey'],
    models: [
      m('meta-llama/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick 17B', 128000, 0, 0),
      m('llama-3.3-70b-versatile', 'Llama 3.3 70B', 128000, 0, 0),
      m('llama-3.1-8b-instant', 'Llama 3.1 8B', 128000, 0, 0),
    ],
  },

  // ── xAI (Grok) ─────────────────────────────────────────────
  {
    id: 'xai',
    displayName: 'xAI (Grok)',
    description: 'xAI Grok API',
    defaultModelId: 'grok-4',
    requiresApiKey: true,
    configKeys: ['xaiApiKey'],
    models: [
      m('grok-4', 'Grok 4', 128000, 3, 15),
      m('grok-3-beta', 'Grok 3 Beta', 128000, 3, 15),
      m('grok-code-fast-1', 'Grok Code Fast 1', 128000, 0, 0),
    ],
  },

  // ── Together AI ────────────────────────────────────────────
  {
    id: 'together',
    displayName: 'Together AI',
    description: 'Together AI inference',
    defaultModelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresApiKey: true,
    configKeys: ['togetherApiKey'],
    models: [
      m('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo', 128000, 0, 0),
      m('deepseek-ai/DeepSeek-R1', 'DeepSeek R1', 64000, 0, 0),
    ],
  },

  // ── Fireworks AI ───────────────────────────────────────────
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    description: 'Fireworks AI fast inference',
    defaultModelId: 'accounts/fireworks/models/kimi-k2-instruct-0905',
    requiresApiKey: true,
    configKeys: ['fireworksApiKey'],
    models: [
      m('accounts/fireworks/models/kimi-k2-instruct-0905', 'Kimi K2 Instruct', 128000, 0, 0),
      m('accounts/fireworks/models/deepseek-v3', 'DeepSeek V3', 64000, 0, 0),
    ],
  },

  // ── Cerebras ───────────────────────────────────────────────
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    description: 'Cerebras ultra-fast inference',
    defaultModelId: 'zai-glm-4.7',
    requiresApiKey: true,
    configKeys: ['cerebrasApiKey'],
    models: [
      m('zai-glm-4.7', 'ZAI GLM 4.7', 128000, 0, 0),
      m('gpt-oss-120b', 'GPT OSS 120B', 128000, 0, 0),
    ],
  },

  // ── SambaNova ──────────────────────────────────────────────
  {
    id: 'sambanova',
    displayName: 'SambaNova',
    description: 'SambaNova AI inference',
    defaultModelId: 'Llama-4-Maverick-17B-128E-Instruct',
    requiresApiKey: true,
    configKeys: ['sambaNovaApiKey'],
    models: [
      m('Llama-4-Maverick-17B-128E-Instruct', 'Llama 4 Maverick 17B', 128000, 0, 0),
      m('Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 128000, 0, 0),
      m('DeepSeek-R1', 'DeepSeek R1', 64000, 0, 0),
    ],
  },

  // ── Nebius ─────────────────────────────────────────────────
  {
    id: 'nebius',
    displayName: 'Nebius AI',
    description: 'Nebius AI Studio',
    defaultModelId: 'deepseek-ai/DeepSeek-V3',
    requiresApiKey: true,
    configKeys: ['nebiusApiKey'],
    models: [
      m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3', 64000, 0, 0),
      m('deepseek-ai/DeepSeek-R1', 'DeepSeek R1', 64000, 0, 0),
    ],
  },

  // ── Moonshot ───────────────────────────────────────────────
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    description: 'Moonshot AI (Kimi)',
    defaultModelId: 'moonshot-v1-128k',
    requiresApiKey: true,
    configKeys: ['moonshotApiKey'],
    models: [
      m('moonshot-v1-128k', 'Moonshot v1 128K', 128000, 0, 0),
    ],
  },

  // ── ZAI ────────────────────────────────────────────────────
  {
    id: 'zai',
    displayName: 'ZAI',
    description: 'ZAI inference',
    defaultModelId: 'zai-default',
    requiresApiKey: true,
    configKeys: ['zaiApiKey'],
    models: [
      m('zai-default', 'ZAI Default', 128000, 0, 0),
    ],
  },

  // ── HuggingFace ────────────────────────────────────────────
  {
    id: 'huggingface',
    displayName: 'HuggingFace',
    description: 'HuggingFace Inference API',
    defaultModelId: 'hf-default',
    requiresApiKey: true,
    configKeys: ['huggingfaceApiKey'],
    models: [
      m('hf-default', 'HuggingFace Default', 128000, 0, 0),
    ],
  },

  // ── AskSage ────────────────────────────────────────────────
  {
    id: 'asksage',
    displayName: 'AskSage',
    description: 'AskSage AI (FedRAMP)',
    defaultModelId: 'claude-4-sonnet',
    requiresApiKey: true,
    configKeys: ['asksageApiKey'],
    models: [
      m('claude-4-sonnet', 'Claude 4 Sonnet', 200000, 0, 0),
      m('gpt-4o', 'GPT-4o', 128000, 0, 0),
      m('gpt-4o-gov', 'GPT-4o Gov', 128000, 0, 0),
    ],
  },

  // ── Huawei Cloud MaaS ──────────────────────────────────────
  {
    id: 'huawei-cloud-maas',
    displayName: 'Huawei Cloud MaaS',
    description: 'Huawei Cloud Model-as-a-Service',
    defaultModelId: 'huawei-default',
    requiresApiKey: true,
    configKeys: ['huaweiApiKey'],
    models: [
      m('huawei-default', 'Huawei Default', 128000, 0, 0),
    ],
  },

  // ── Vercel AI Gateway ──────────────────────────────────────
  {
    id: 'vercel-ai-gateway',
    displayName: 'Vercel AI Gateway',
    description: 'Vercel AI Gateway proxy',
    defaultModelId: 'vercel-default',
    requiresApiKey: true,
    configKeys: ['vercelApiKey'],
    models: [
      m('vercel-default', 'Vercel Default', 128000, 0, 0),
    ],
  },

  // ── OCA ────────────────────────────────────────────────────
  {
    id: 'oca',
    displayName: 'OCA',
    description: 'OCA AI inference',
    defaultModelId: 'oca-default',
    requiresApiKey: true,
    configKeys: ['ocaApiKey'],
    models: [
      m('oca-default', 'OCA Default', 128000, 0, 0),
    ],
  },

  // ── AIHubMix ───────────────────────────────────────────────
  {
    id: 'aihubmix',
    displayName: 'AIHubMix',
    description: 'AIHubMix aggregator',
    defaultModelId: 'aihubmix-default',
    requiresApiKey: true,
    configKeys: ['aihubmixApiKey'],
    models: [
      m('aihubmix-default', 'AIHubMix Default', 128000, 0, 0),
    ],
  },

  // ── MiniMax ────────────────────────────────────────────────
  {
    id: 'minimax',
    displayName: 'MiniMax',
    description: 'MiniMax AI',
    defaultModelId: 'minimax-default',
    requiresApiKey: true,
    configKeys: ['minimaxApiKey'],
    models: [
      m('minimax-default', 'MiniMax Default', 128000, 0, 0),
    ],
  },

  // ── HiCap ─────────────────────────────────────────────────
  {
    id: 'hicap',
    displayName: 'HiCap',
    description: 'HiCap AI inference',
    defaultModelId: 'hicap-default',
    requiresApiKey: true,
    configKeys: ['hicapApiKey'],
    models: [
      m('hicap-default', 'HiCap Default', 128000, 0, 0),
    ],
  },

  // ── NousResearch ───────────────────────────────────────────
  {
    id: 'nousResearch',
    displayName: 'Nous Research',
    description: 'Nous Research models',
    defaultModelId: 'nous-default',
    requiresApiKey: true,
    configKeys: ['nousResearchApiKey'],
    models: [
      m('nous-default', 'Nous Default', 128000, 0, 0),
    ],
  },

  // ── Doubao ─────────────────────────────────────────────────
  {
    id: 'doubao',
    displayName: 'Doubao',
    description: 'ByteDance Doubao models',
    defaultModelId: 'doubao-default',
    requiresApiKey: true,
    configKeys: ['doubaoApiKey'],
    models: [
      m('doubao-default', 'Doubao Default', 128000, 0, 0),
    ],
  },

  // ── Requesty ───────────────────────────────────────────────
  {
    id: 'requesty',
    displayName: 'Requesty',
    description: 'Requesty AI router',
    defaultModelId: 'anthropic/claude-3-5-sonnet-20241022',
    requiresApiKey: true,
    configKeys: ['requestyApiKey'],
    models: [
      m('anthropic/claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', 200000, 3, 15),
      m('openai/gpt-4o', 'GPT-4o', 128000, 5, 15),
    ],
  },

  // ── Dify ───────────────────────────────────────────────────
  {
    id: 'dify',
    displayName: 'Dify',
    description: 'Dify AI platform',
    defaultModelId: 'dify-default',
    requiresApiKey: true,
    configKeys: ['difyApiKey'],
    models: [
      m('dify-default', 'Dify Default', 128000, 0, 0),
    ],
  },

  // ── Baseten ────────────────────────────────────────────────
  {
    id: 'baseten',
    displayName: 'Baseten',
    description: 'Baseten inference platform',
    defaultModelId: 'baseten-default',
    requiresApiKey: true,
    configKeys: ['basetenApiKey'],
    models: [
      m('baseten-default', 'Baseten Default', 128000, 0, 0),
    ],
  },

  // ── VS Code LM ────────────────────────────────────────────
  {
    id: 'vscode-lm',
    displayName: 'VS Code LM',
    description: 'VS Code Language Model API',
    defaultModelId: 'vscode-lm-default',
    requiresApiKey: false,
    configKeys: ['vsCodeLmModelSelector'],
    models: [
      m('vscode-lm-default', 'VS Code LM Default', 128000, 0, 0),
    ],
  },

  // ── Cline CLI ──────────────────────────────────────────────
  {
    id: 'cline',
    displayName: 'Cline CLI',
    description: 'Cline CLI auto-configuration',
    defaultModelId: 'auto',
    requiresApiKey: false,
    configKeys: [],
    models: [
      m('auto', 'Use ~/.cline/config.json', 200000, 0, 0),
    ],
  },

  // ── Azure OpenAI (not in ApiProvider enum but in any-bot) ──
  // Note: Azure is handled through openai provider with azure config
];
