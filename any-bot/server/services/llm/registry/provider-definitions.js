/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from LLMProviderRegistry.js (1000-line cap decomposition): the 24-entry PROVIDERS catalog (display metadata, required credential keys, Cline provider mapping, grouped model lists)
 */

/**
 * @description Full provider catalog keyed by provider id — the 22 Cline CLI
 * providers plus `cline-cli` (passthrough) and `claude-code` (direct binary).
 * Each entry carries display metadata (name/description/icon), the credential
 * env-var names it requires, the Cline provider mapping, and grouped model
 * lists with exactly one `default: true` model. Consumed by the agent-config
 * UI dropdowns and by the config builders in this directory.
 */
const PROVIDERS = {
  bedrock: {
    id: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Claude via AWS Bedrock (GovCloud + Standard)',
    icon: '☁️',
    requiresKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    clineProvider: 'bedrock',
    // Source: _reference/cline-source/src/shared/api.ts bedrockModels (29 models)
    // Default: claude-3-5-sonnet-20241022-v2:0 (GovCloud compatible)
    modelGroups: [
      {
        group: 'GovCloud (us-gov-west-1)',
        models: [
          { id: 'us-gov.anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2 (GovCloud) ⭐ Recommended', default: true },
          { id: 'us-gov.anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku (GovCloud) ⚡ Fast' },
          { id: 'us-gov.anthropic.claude-3-opus-20240229-v1:0', name: 'Claude 3 Opus (GovCloud) 🧠 Powerful' },
        ],
      },
      {
        group: 'Claude 4 (Standard)',
        models: [
          { id: 'claude-sonnet-4.5-20250929-v1:0', name: 'Claude Sonnet 4.5 ⭐ Latest' },
          { id: 'anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          { id: 'anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5 ⚡ Fast' },
          { id: 'anthropic.claude-opus-4-6-v1', name: 'Claude Opus 4.6 🧠 Powerful' },
        ],
      },
      {
        group: 'Claude 3.x (Standard)',
        models: [
          { id: 'anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude 3.7 Sonnet 🧠 Thinking' },
          { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2' },
          { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku ⚡ Fast' },
          { id: 'anthropic.claude-3-opus-20240229-v1:0', name: 'Claude 3 Opus 🧠 Powerful' },
        ],
      },
    ],
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Direct)',
    description: 'Direct Anthropic API — requires ANTHROPIC_API_KEY',
    icon: '🤖',
    requiresKeys: ['ANTHROPIC_API_KEY'],
    clineProvider: 'anthropic',
    // Source: _reference/cline-source/src/shared/api.ts anthropicModels (17 models)
    // Default: claude-3-5-sonnet-20241022
    modelGroups: [
      {
        group: 'Claude 4',
        models: [
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude Sonnet 4.5 ⭐ Latest', default: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 ⚡ Fast' },
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 🧠 Powerful' },
        ],
      },
      {
        group: 'Claude 3.x',
        models: [
          { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet 🧠 Extended Thinking' },
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet v2' },
          { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku ⚡ Fast' },
          { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus 🧠 Most Powerful' },
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku ⚡ Fastest' },
        ],
      },
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '100+ models via one API — requires OPENROUTER_API_KEY',
    icon: '🌐',
    requiresKeys: ['OPENROUTER_API_KEY'],
    clineProvider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelGroups: [
      {
        group: 'Anthropic (via OpenRouter)',
        models: [
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet ⭐ Recommended', default: true },
          { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku ⚡ Fast' },
          { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus 🧠 Powerful' },
        ],
      },
      {
        group: 'OpenAI (via OpenRouter)',
        models: [
          { id: 'openai/gpt-4o', name: 'GPT-4o' },
          { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini ⚡ Fast' },
          { id: 'openai/o1-preview', name: 'o1 Preview 🧠 Reasoning' },
          { id: 'openai/o1-mini', name: 'o1 Mini ⚡ Fast Reasoning' },
        ],
      },
      {
        group: 'Google (via OpenRouter)',
        models: [
          { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
          { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5 ⚡ Fast' },
          { id: 'google/gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Exp ⭐ New' },
        ],
      },
      {
        group: 'Meta Llama (via OpenRouter)',
        models: [
          { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
          { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B ⚡ Fast' },
          { id: 'meta-llama/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision' },
        ],
      },
      {
        group: 'Mistral (via OpenRouter)',
        models: [
          { id: 'mistralai/mistral-large', name: 'Mistral Large' },
          { id: 'mistralai/mistral-nemo', name: 'Mistral Nemo ⚡ Fast' },
          { id: 'mistralai/codestral-mamba', name: 'Codestral Mamba 💻 Code' },
        ],
      },
      {
        group: 'DeepSeek (via OpenRouter)',
        models: [
          { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 🧠 Reasoning' },
          { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
        ],
      },
    ],
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    description: 'Direct OpenAI API — requires OPENAI_API_KEY',
    icon: '🟢',
    requiresKeys: ['OPENAI_API_KEY'],
    clineProvider: 'openai',
    modelGroups: [
      {
        group: 'GPT-4o',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o ⭐ Recommended', default: true },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini ⚡ Fast' },
        ],
      },
      {
        group: 'o1 Reasoning',
        models: [
          { id: 'o1-preview', name: 'o1 Preview 🧠 Reasoning' },
          { id: 'o1-mini', name: 'o1 Mini ⚡ Fast Reasoning' },
        ],
      },
      {
        group: 'GPT-4 Turbo',
        models: [
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'gpt-4-turbo-preview', name: 'GPT-4 Turbo Preview' },
        ],
      },
      {
        group: 'GPT-3.5',
        models: [
          { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo ⚡ Fastest' },
        ],
      },
    ],
  },

  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    description: 'Local models via Ollama — no API key needed',
    icon: '🦙',
    requiresKeys: [],
    clineProvider: 'ollama',
    baseUrl: 'http://localhost:11434',
    modelGroups: [
      {
        group: 'Popular Models',
        models: [
          { id: 'llama3.1:70b', name: 'Llama 3.1 70B 🧠 Powerful', default: true },
          { id: 'llama3.1:8b', name: 'Llama 3.1 8B ⚡ Fast' },
          { id: 'mistral:7b', name: 'Mistral 7B' },
          { id: 'codellama:34b', name: 'CodeLlama 34B 💻 Code' },
          { id: 'deepseek-coder:33b', name: 'DeepSeek Coder 33B 💻 Code' },
          { id: 'phi3:14b', name: 'Phi-3 14B ⚡ Efficient' },
          { id: 'gemma2:27b', name: 'Gemma 2 27B' },
          { id: 'qwen2.5:72b', name: 'Qwen 2.5 72B' },
        ],
      },
    ],
    note: 'Models must be pulled first: ollama pull <model>',
  },

  'cline-cli': {
    id: 'cline-cli',
    name: 'Cline CLI (Auto)',
    description: 'Cline CLI uses its own provider config (~/.cline/config.json)',
    icon: '⚡',
    requiresKeys: [],
    clineProvider: null, // Uses whatever is in ~/.cline/config.json
    modelGroups: [
      {
        group: 'Current Config',
        models: [
          { id: 'auto', name: 'Use ~/.cline/config.json (current setting)', default: true },
        ],
      },
    ],
  },

  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code CLI',
    description: 'Anthropic Claude via official Claude Code CLI — auth via ~/.claude/ or ANTHROPIC_API_KEY',
    icon: '🟣',
    requiresKeys: [], // Auth via OAuth (~/.claude/) or ANTHROPIC_API_KEY env var
    clineProvider: null, // Not a Cline provider — uses claude binary directly
    modelGroups: [
      {
        group: 'Claude (via Claude Code CLI)',
        models: [
          { id: 'opus', name: 'Claude Opus 4.6 🧠 Most Powerful' },
          { id: 'sonnet', name: 'Claude Sonnet 4.5 ⭐ Default', default: true },
          { id: 'haiku', name: 'Claude Haiku 4.5 ⚡ Fast' },
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (full ID)' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (full ID)' },
        ],
      },
    ],
    note: 'Uses claude binary. Auth: volume mount ~/.claude/ (OAuth) or set ANTHROPIC_API_KEY env var.',
  },

  // ── ⭐ PHASE_62: New providers ─────────────────────────────────────────────

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google Gemini API — requires GEMINI_API_KEY',
    icon: '🔷',
    requiresKeys: ['GEMINI_API_KEY'],
    clineProvider: 'gemini',
    // Source: _reference/cline-source/src/shared/api.ts geminiModels (18 models)
    // Default: gemini-3.1-pro-preview
    modelGroups: [
      {
        group: 'Gemini 3',
        models: [
          { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview ⭐ Latest', default: true },
          { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview ⚡' },
        ],
      },
      {
        group: 'Gemini 2.5',
        models: [
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash ⚡' },
          { id: 'gemini-2.5-flash-lite-preview-06-17', name: 'Gemini 2.5 Flash Lite Preview' },
        ],
      },
      {
        group: 'Gemini 2.0',
        models: [
          { id: 'gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
          { id: 'gemini-2.0-flash-lite-preview-02-05', name: 'Gemini 2.0 Flash Lite Preview' },
          { id: 'gemini-2.0-pro-exp-02-05', name: 'Gemini 2.0 Pro Exp' },
          { id: 'gemini-2.0-flash-thinking-exp-01-21', name: 'Gemini 2.0 Flash Thinking Exp 🧠' },
        ],
      },
      {
        group: 'Gemini 1.5',
        models: [
          { id: 'gemini-1.5-pro-002', name: 'Gemini 1.5 Pro' },
          { id: 'gemini-1.5-flash-002', name: 'Gemini 1.5 Flash ⚡' },
        ],
      },
    ],
  },

  vertex: {
    id: 'vertex',
    name: 'Google Vertex AI',
    description: 'Google Cloud Vertex AI — requires GCP project + region',
    icon: '🌩️',
    requiresKeys: ['VERTEX_PROJECT_ID', 'VERTEX_REGION'],
    clineProvider: 'vertex',
    // Source: _reference/cline-source/src/shared/api.ts vertexModels
    // Default: gemini-3-pro-preview (vertexDefaultModelId)
    // ⭐ PHASE_63 FIX: Updated from old claude-3-5-sonnet-v2@20241022 to match real Cline source
    modelGroups: [
      {
        group: 'Gemini 3 on Vertex',
        models: [
          { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview ⭐ Default', default: true },
          { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview ⭐ Latest' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview ⚡' },
        ],
      },
      {
        group: 'Claude 4 on Vertex',
        models: [
          { id: 'claude-3-5-sonnet-v2@20241022', name: 'Claude 3.5 Sonnet v2 ⭐ Latest (GovCloud Compatible)' },
          { id: 'claude-sonnet-4@20250514', name: 'Claude Sonnet 4 (Commercial only)' },
          { id: 'claude-haiku-4-5@20251001', name: 'Claude Haiku 4.5 ⚡ Fast' },
          { id: 'claude-opus-4-5@20251101', name: 'Claude Opus 4.5 🧠 Powerful' },
          { id: 'claude-opus-4@20250514', name: 'Claude Opus 4' },
        ],
      },
      {
        group: 'Claude 3.x on Vertex',
        models: [
          { id: 'claude-3-7-sonnet@20250219', name: 'Claude 3.7 Sonnet 🧠 Thinking' },
          { id: 'claude-3-5-sonnet-v2@20241022', name: 'Claude 3.5 Sonnet v2' },
          { id: 'claude-3-5-haiku@20241022', name: 'Claude 3.5 Haiku ⚡ Fast' },
          { id: 'claude-3-opus@20240229', name: 'Claude 3 Opus 🧠 Powerful' },
        ],
      },
      {
        group: 'Gemini 2.x on Vertex',
        models: [
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash ⚡' },
          { id: 'gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
          { id: 'gemini-1.5-pro-002', name: 'Gemini 1.5 Pro' },
        ],
      },
    ],
  },

  azure: {
    id: 'azure',
    name: 'Azure OpenAI',
    description: 'Azure OpenAI Service — requires AZURE_API_KEY + endpoint',
    icon: '🔵',
    requiresKeys: ['AZURE_API_KEY', 'AZURE_ENDPOINT', 'AZURE_DEPLOYMENT_ID', 'AZURE_API_VERSION'],
    clineProvider: 'azure',
    modelGroups: [
      {
        group: 'GPT-4o',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o ⭐ Recommended', default: true },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini ⚡ Fast' },
        ],
      },
      {
        group: 'GPT-4',
        models: [
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'gpt-4', name: 'GPT-4' },
        ],
      },
    ],
  },

  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral AI API — requires MISTRAL_API_KEY',
    icon: '🌪️',
    requiresKeys: ['MISTRAL_API_KEY'],
    clineProvider: 'mistral',
    // Source: _reference/cline-source/src/shared/api.ts mistralModels (17 models)
    // Default: devstral-2512
    modelGroups: [
      {
        group: 'Devstral (Code)',
        models: [
          { id: 'devstral-2512', name: 'Devstral 2512 ⭐ Latest 💻 Code', default: true },
          { id: 'labs-devstral-small-2512', name: 'Devstral Small 2512 ⚡' },
        ],
      },
      {
        group: 'Mistral Large',
        models: [
          { id: 'mistral-large-2512', name: 'Mistral Large 2512' },
          { id: 'mistral-large-2411', name: 'Mistral Large 2411' },
          { id: 'pixtral-large-2411', name: 'Pixtral Large 2411 👁️' },
        ],
      },
      {
        group: 'Ministral',
        models: [
          { id: 'ministral-14b-2512', name: 'Ministral 14B 2512' },
          { id: 'ministral-8b-2410', name: 'Ministral 8B ⚡ Fast' },
          { id: 'ministral-3b-2410', name: 'Ministral 3B ⚡ Fastest' },
        ],
      },
      {
        group: 'Mistral Small/Medium',
        models: [
          { id: 'mistral-small-latest', name: 'Mistral Small Latest ⚡' },
          { id: 'mistral-medium-latest', name: 'Mistral Medium Latest' },
        ],
      },
    ],
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek API — requires DEEPSEEK_API_KEY',
    icon: '🔍',
    requiresKeys: ['DEEPSEEK_API_KEY'],
    clineProvider: 'deepseek',
    // Source: _reference/cline-source/src/shared/api.ts deepSeekModels (2 models)
    // Default: deepseek-chat
    modelGroups: [
      {
        group: 'DeepSeek Models',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek V3 Chat ⭐ Recommended', default: true },
          { id: 'deepseek-reasoner', name: 'DeepSeek R1 🧠 Reasoning' },
        ],
      },
    ],
  },

  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'xAI Grok API — requires XAI_API_KEY',
    icon: '✖️',
    requiresKeys: ['XAI_API_KEY'],
    clineProvider: 'xai',
    // Source: _reference/cline-source/src/shared/api.ts xaiModels (21 models)
    // Default: grok-4
    modelGroups: [
      {
        group: 'Grok 4',
        models: [
          { id: 'grok-4', name: 'Grok 4 ⭐ Latest', default: true },
          { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning ⚡' },
          { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning' },
          { id: 'grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Fast' },
        ],
      },
      {
        group: 'Grok 3',
        models: [
          { id: 'grok-3-beta', name: 'Grok 3 Beta' },
          { id: 'grok-3-fast-beta', name: 'Grok 3 Fast Beta ⚡' },
          { id: 'grok-3-mini-beta', name: 'Grok 3 Mini Beta' },
          { id: 'grok-3-mini-fast-beta', name: 'Grok 3 Mini Fast ⚡' },
        ],
      },
      {
        group: 'Grok Code',
        models: [
          { id: 'grok-code-fast-1', name: 'Grok Code Fast 1 💻' },
        ],
      },
    ],
  },

  groq: {
    id: 'groq',
    name: 'Groq',
    description: 'Groq ultra-fast inference — requires GROQ_API_KEY',
    icon: '⚡',
    requiresKeys: ['GROQ_API_KEY'],
    clineProvider: 'groq',
    // Source: _reference/cline-source/src/shared/api.ts groqModels (11 models)
    // Default: moonshotai/kimi-k2-instruct-0905
    modelGroups: [
      {
        group: 'Llama on Groq',
        models: [
          { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B ⭐ Latest', default: true },
          { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
          { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
          { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B ⚡ Fastest' },
        ],
      },
      {
        group: 'DeepSeek on Groq',
        models: [
          { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B 🧠' },
        ],
      },
      {
        group: 'Compound Beta',
        models: [
          { id: 'compound-beta', name: 'Compound Beta' },
          { id: 'compound-beta-mini', name: 'Compound Beta Mini ⚡' },
        ],
      },
    ],
  },

  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    description: 'Local models via LM Studio — no API key needed',
    icon: '🖥️',
    requiresKeys: [],
    clineProvider: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    modelGroups: [
      {
        group: 'Local Models',
        models: [
          { id: 'local-model', name: 'Use currently loaded model', default: true },
        ],
      },
    ],
    note: 'Start LM Studio and load a model first',
  },

  'openai-native': {
    id: 'openai-native',
    name: 'OpenAI Native',
    description: 'OpenAI API (native format) — requires OPENAI_API_KEY',
    icon: '🟩',
    requiresKeys: ['OPENAI_API_KEY'],
    clineProvider: 'openai-native',
    // Source: _reference/cline-source/src/shared/api.ts openAiNativeModels
    // Default: gpt-5.2 (openAiNativeDefaultModelId)
    // ⭐ PHASE_63 FIX: Updated from gpt-4o to match real Cline source (gpt-5.x series)
    modelGroups: [
      {
        group: 'GPT-5',
        models: [
          { id: 'gpt-5.2', name: 'GPT-5.2 ⭐ Default', default: true },
          { id: 'gpt-5.1', name: 'GPT-5.1' },
          { id: 'gpt-5-2025-08-07', name: 'GPT-5 (2025-08-07)' },
          { id: 'gpt-5-mini-2025-08-07', name: 'GPT-5 Mini ⚡ Fast' },
          { id: 'gpt-5-nano-2025-08-07', name: 'GPT-5 Nano ⚡ Fastest' },
        ],
      },
      {
        group: 'o4 / o3 Reasoning',
        models: [
          { id: 'o4-mini', name: 'o4 Mini 🧠 Reasoning ⚡' },
          { id: 'o3-mini', name: 'o3 Mini 🧠 Reasoning' },
        ],
      },
      {
        group: 'GPT-4o',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini ⚡ Fast' },
        ],
      },
    ],
  },

  together: {
    id: 'together',
    name: 'Together AI',
    description: 'Together AI — requires TOGETHER_API_KEY',
    icon: '🤝',
    requiresKeys: ['TOGETHER_API_KEY'],
    clineProvider: 'together',
    modelGroups: [
      {
        group: 'Llama Models',
        models: [
          { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo ⭐ Recommended', default: true },
          { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', name: 'Llama 3.1 8B Turbo ⚡ Fast' },
        ],
      },
      {
        group: 'DeepSeek on Together',
        models: [
          { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 🧠 Reasoning' },
        ],
      },
      {
        group: 'Mistral on Together',
        models: [
          { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B' },
        ],
      },
    ],
  },

  fireworks: {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Fireworks AI fast inference — requires FIREWORKS_API_KEY',
    icon: '🎆',
    requiresKeys: ['FIREWORKS_API_KEY'],
    clineProvider: 'fireworks',
    // Source: _reference/cline-source/src/shared/api.ts fireworksModels (5 models)
    // Default: accounts/fireworks/models/kimi-k2-instruct-0905
    modelGroups: [
      {
        group: 'Latest Models',
        models: [
          { id: 'accounts/fireworks/models/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct ⭐ Latest', default: true },
          { id: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B' },
          { id: 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B 💻' },
        ],
      },
      {
        group: 'DeepSeek on Fireworks',
        models: [
          { id: 'accounts/fireworks/models/deepseek-r1-0528', name: 'DeepSeek R1 0528 🧠' },
          { id: 'accounts/fireworks/models/deepseek-v3', name: 'DeepSeek V3' },
        ],
      },
    ],
  },

  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Cerebras ultra-fast inference — requires CEREBRAS_API_KEY',
    icon: '🧠',
    requiresKeys: ['CEREBRAS_API_KEY'],
    clineProvider: 'cerebras',
    // Source: _reference/cline-source/src/shared/api.ts cerebrasModels (3 models)
    // Default: zai-glm-4.7
    modelGroups: [
      {
        group: 'Cerebras Models',
        models: [
          { id: 'zai-glm-4.7', name: 'ZAI GLM 4.7 ⭐ Latest', default: true },
          { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
          { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen3 235B' },
        ],
      },
    ],
  },

  sambanova: {
    id: 'sambanova',
    name: 'SambaNova',
    description: 'SambaNova AI — requires SAMBANOVA_API_KEY',
    icon: '🔶',
    requiresKeys: ['SAMBANOVA_API_KEY'],
    clineProvider: 'sambanova',
    // Source: _reference/cline-source/src/shared/api.ts sambanovaModels (13 models)
    // Default: Meta-Llama-3.3-70B-Instruct
    modelGroups: [
      {
        group: 'Llama 4 on SambaNova',
        models: [
          { id: 'Llama-4-Maverick-17B-128E-Instruct', name: 'Llama 4 Maverick 17B ⭐ Latest', default: true },
          { id: 'Llama-4-Scout-17B-16E-Instruct', name: 'Llama 4 Scout 17B' },
        ],
      },
      {
        group: 'Llama 3 on SambaNova',
        models: [
          { id: 'Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
          { id: 'Meta-Llama-3.1-405B-Instruct', name: 'Llama 3.1 405B 🧠 Powerful' },
          { id: 'Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B ⚡ Fast' },
        ],
      },
      {
        group: 'DeepSeek on SambaNova',
        models: [
          { id: 'DeepSeek-R1', name: 'DeepSeek R1 🧠 Reasoning' },
          { id: 'DeepSeek-R1-Distill-Llama-70B', name: 'DeepSeek R1 Distill 70B' },
        ],
      },
    ],
  },

  nebius: {
    id: 'nebius',
    name: 'Nebius AI',
    description: 'Nebius AI Studio — requires NEBIUS_API_KEY',
    icon: '🌌',
    requiresKeys: ['NEBIUS_API_KEY'],
    clineProvider: 'nebius',
    // Source: _reference/cline-source/src/shared/api.ts nebiusModels (22 models)
    // Default: Qwen/Qwen2.5-32B-Instruct-fast
    modelGroups: [
      {
        group: 'DeepSeek on Nebius',
        models: [
          { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3 ⭐ Recommended', default: true },
          { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 🧠 Reasoning' },
          { id: 'deepseek-ai/DeepSeek-R1-fast', name: 'DeepSeek R1 Fast ⚡' },
        ],
      },
      {
        group: 'Llama on Nebius',
        models: [
          { id: 'meta-llama/Llama-3.3-70B-Instruct-fast', name: 'Llama 3.3 70B Fast ⚡' },
        ],
      },
      {
        group: 'Qwen on Nebius',
        models: [
          { id: 'Qwen/Qwen2.5-32B-Instruct-fast', name: 'Qwen 2.5 32B Fast ⚡' },
          { id: 'Qwen/Qwen2.5-Coder-32B-Instruct-fast', name: 'Qwen 2.5 Coder 32B 💻' },
        ],
      },
    ],
  },

  asksage: {
    id: 'asksage',
    name: 'AskSage',
    description: 'AskSage AI (FedRAMP) — requires ASKSAGE_API_KEY',
    icon: '🏛️',
    requiresKeys: ['ASKSAGE_API_KEY'],
    clineProvider: 'asksage',
    // Source: _reference/cline-source/src/shared/api.ts askSageModels (8 models)
    // Default: claude-4-sonnet
    modelGroups: [
      {
        group: 'Claude via AskSage',
        models: [
          { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet ⭐ Latest', default: true },
          { id: 'claude-4.6-sonnet', name: 'Claude 4.6 Sonnet' },
          { id: 'claude-37-sonnet', name: 'Claude 3.7 Sonnet 🧠' },
          { id: 'claude-35-sonnet', name: 'Claude 3.5 Sonnet' },
        ],
      },
      {
        group: 'GPT via AskSage',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4o-gov', name: 'GPT-4o Gov 🏛️' },
          { id: 'gpt-4.1', name: 'GPT-4.1' },
        ],
      },
      {
        group: 'GovCloud via AskSage',
        models: [
          { id: 'aws-bedrock-claude-35-sonnet-gov', name: 'Claude 3.5 Sonnet GovCloud ☁️' },
        ],
      },
    ],
  },

  litellm: {
    id: 'litellm',
    name: 'LiteLLM Proxy',
    description: 'LiteLLM proxy server — requires base URL',
    icon: '🔀',
    requiresKeys: ['LITELLM_BASE_URL'],
    clineProvider: 'litellm',
    modelGroups: [
      {
        group: 'Proxy Models',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o (via proxy)', default: true },
          { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet (via proxy)' },
          { id: 'custom', name: 'Custom model ID' },
        ],
      },
    ],
  },

  requesty: {
    id: 'requesty',
    name: 'Requesty',
    description: 'Requesty AI router — requires REQUESTY_API_KEY',
    icon: '🔁',
    requiresKeys: ['REQUESTY_API_KEY'],
    clineProvider: 'requesty',
    modelGroups: [
      {
        group: 'Routed Models',
        models: [
          { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet ⭐ Recommended', default: true },
          { id: 'openai/gpt-4o', name: 'GPT-4o' },
          { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
        ],
      },
    ],
  },
};

module.exports = {
  PROVIDERS,
};
