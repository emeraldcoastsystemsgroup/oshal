/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from ui-logic.js (1000-line cap decomposition): provider model catalogs + provider info blurbs (PROVIDER_MODELS, PROVIDER_INFO)
 */

/**
 * @description Provider catalog (part 2 of 2) for the Phase 1 API config UI:
 * selectable model lists and provider info blurbs. Plain browser script,
 * served concatenated between ui-provider-fields.js and ui-logic.js by the
 * GET /ui-logic.js route in src/app/server.ts.
 * @module ui-provider-models
 */

/**
 * @description Selectable model lists per provider (based on Cline source
 * code). Consumed by handleProviderChange() in ui-logic.js to populate the
 * model dropdowns.
 */
const PROVIDER_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5 (2025-09-29)' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
    { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet' },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3' },
    { id: 'qwen/qwen3-coder', name: 'Qwen 3 Coder' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
  ],
  'openai-native': [
    { id: 'gpt-5.2', name: 'GPT-5.2' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'o3', name: 'O3' },
    { id: 'o3-mini', name: 'O3 Mini' },
    { id: 'o1', name: 'O1' },
  ],
  'openai-codex': [
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
  ],
  gemini: [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro-002', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash-002', name: 'Gemini 1.5 Flash' },
  ],
  bedrock: [
    { id: 'anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'anthropic.claude-opus-4-6-v1', name: 'Claude Opus 4.6' },
    { id: 'amazon.nova-premier-v1:0', name: 'Amazon Nova Premier' },
    { id: 'amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
    { id: 'deepseek.r1-v1:0', name: 'DeepSeek R1' },
  ],
  vertex: [
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' },
  ],
  qwen: [
    { id: 'qwen3-coder-plus', name: 'Qwen 3 Coder Plus' },
    { id: 'qwen3-235b-a22b', name: 'Qwen 3 235B' },
    { id: 'qwen3-32b', name: 'Qwen 3 32B' },
    { id: 'qwen3-30b-a3b', name: 'Qwen 3 30B' },
    { id: 'qwen-max-latest', name: 'Qwen Max Latest' },
    { id: 'qwen-plus-latest', name: 'Qwen Plus Latest' },
  ],
  mistral: [
    { id: 'devstral-2512', name: 'Devstral 2512' },
    { id: 'mistral-large-2512', name: 'Mistral Large 2512' },
    { id: 'ministral-14b-2512', name: 'Ministral 14B' },
    { id: 'codestral-2501', name: 'Codestral 2501' },
  ],
  groq: [
    { id: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct' },
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B' },
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
  ],
  xai: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning' },
    { id: 'grok-3-beta', name: 'Grok 3 Beta' },
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
  ],
  ollama: [
    { id: 'llama3.3:70b', name: 'Llama 3.3 70B' },
    { id: 'llama3.2:latest', name: 'Llama 3.2 Latest' },
    { id: 'qwen2.5:latest', name: 'Qwen 2.5 Latest' },
    { id: 'deepseek-v3:latest', name: 'DeepSeek V3 Latest' },
    { id: 'codellama:latest', name: 'Code Llama Latest' },
  ],
  litellm: [
    { id: 'anthropic/claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
    { id: 'gemini/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ],
  cerebras: [
    { id: 'zai-glm-4.7', name: 'ZAI GLM 4.7' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen 3 235B' },
  ],
  sambanova: [
    { id: 'Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
    { id: 'DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'DeepSeek-V3', name: 'DeepSeek V3' },
  ],
  nebius: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen 3 Coder 480B' },
  ],
  baseten: [
    { id: 'zai-org/GLM-4.6', name: 'GLM 4.6' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2' },
  ],
  moonshot: [
    { id: 'kimi-k2.5', name: 'Kimi K2.5' },
    { id: 'kimi-k2-0905-preview', name: 'Kimi K2 Preview' },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
  ],
  zai: [
    { id: 'glm-5', name: 'GLM 5' },
    { id: 'glm-4.7', name: 'GLM 4.7' },
    { id: 'glm-4.6', name: 'GLM 4.6' },
    { id: 'glm-4.5', name: 'GLM 4.5' },
  ],
  'claude-code': [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
    { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  ],
  'qwen-code': [
    { id: 'qwen3-coder-plus', name: 'Qwen 3 Coder Plus' },
    { id: 'qwen3-coder', name: 'Qwen 3 Coder' },
  ],
  together: [
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen 2.5 72B Turbo' },
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct' },
    { id: 'accounts/fireworks/models/deepseek-v3', name: 'DeepSeek V3' },
    { id: 'accounts/fireworks/models/deepseek-r1', name: 'DeepSeek R1' },
    { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B' },
  ],
  huggingface: [
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B' },
    { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi K2 Instruct' },
    { id: 'deepseek-ai/DeepSeek-V3-0324', name: 'DeepSeek V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'deepseek-ai/DeepSeek-R1-0528', name: 'DeepSeek R1 0528' },
    { id: 'meta-llama/Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B' },
  ],
  asksage: [
    { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet' },
    { id: 'claude-4-opus', name: 'Claude 4 Opus' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-gov', name: 'GPT-4o (Gov)' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ],
  'huawei-cloud-maas': [
    { id: 'DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'DeepSeek-R1', name: 'DeepSeek R1' },
  ],
  doubao: [
    { id: 'doubao-1-5-pro-256k-250115', name: 'Doubao 1.5 Pro 256K' },
    { id: 'doubao-1-5-pro-32k-250115', name: 'Doubao 1.5 Pro 32K' },
    { id: 'deepseek-v3-250324', name: 'DeepSeek V3' },
    { id: 'deepseek-r1-250120', name: 'DeepSeek R1' },
  ],
  requesty: [
    { id: 'anthropic/claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ],
  nousResearch: [
    { id: 'Hermes-4-405B', name: 'Hermes 4 405B' },
    { id: 'DeepHermes-3-Llama-3.1-8B-Preview', name: 'DeepHermes 3 8B' },
  ],
  minimax: [
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
    { id: 'MiniMax-M1', name: 'MiniMax M1' },
  ],
};

/**
 * @description One-line provider descriptions shown under the provider
 * dropdown by handleProviderChange() in ui-logic.js.
 */
const PROVIDER_INFO = {
  anthropic: 'Anthropic Claude models - State-of-the-art AI with advanced reasoning capabilities',
  openrouter: 'OpenRouter - Access to multiple AI models through a unified API',
  openai: 'OpenAI GPT models - Industry-leading language models',
  'openai-native': 'OpenAI Native API - Latest GPT models with enhanced features',
  'openai-codex': 'OpenAI Codex - Specialized for coding tasks (ChatGPT subscription)',
  gemini: 'Google Gemini - Multimodal AI models with large context windows',
  bedrock: 'AWS Bedrock - Enterprise-grade managed AI service',
  vertex: 'Google Vertex AI - Enterprise AI platform with multiple models',
  ollama: 'Ollama - Run open-source models locally on your machine',
  lmstudio: 'LM Studio - Local model hosting with user-friendly interface',
  litellm: 'LiteLLM - Unified interface for 100+ LLM APIs',
  deepseek: 'DeepSeek - Advanced reasoning models with competitive pricing',
  qwen: 'Qwen (Alibaba) - Powerful multilingual models',
  'qwen-code': 'Qwen Code - Specialized coding models',
  mistral: 'Mistral AI - European AI with strong coding capabilities',
  groq: 'Groq - Ultra-fast inference with custom hardware',
  xai: 'X AI (Grok) - Elon Musk\'s AI models',
  together: 'Together AI - Open-source models at scale',
  fireworks: 'Fireworks AI - Fast inference for open models',
  cerebras: 'Cerebras - Ultra-fast inference up to 3000 tokens/s',
  sambanova: 'SambaNova - High-performance AI acceleration',
  nebius: 'Nebius AI Studio - Advanced AI infrastructure',
  baseten: 'Baseten - Production ML platform with latest models',
  moonshot: 'Moonshot AI (Kimi) - Advanced reasoning with 256K context',
  zai: 'Z AI (GLM) - Powerful Chinese AI models with global reach',
  huggingface: 'Hugging Face - Access to thousands of open-source models',
  asksage: 'AskSage - Enterprise AI with government-grade security',
  'huawei-cloud-maas': 'Huawei Cloud MaaS - Cloud-based AI services',
  'vercel-ai-gateway': 'Vercel AI Gateway - Unified API for multiple providers',
  oca: 'OCA - Advanced AI models',
  aihubmix: 'AIHubMix - Aggregated AI model access',
  minimax: 'MiniMax - Advanced AI models',
  hicap: 'HiCap - Specialized AI capabilities',
  nousResearch: 'Nous Research - High-quality open models',
  doubao: 'Doubao - ByteDance AI models',
  requesty: 'Requesty - Multi-provider AI access',
  dify: 'Dify.ai - LLM application development platform',
  'vscode-lm': 'VS Code Language Models - Built-in VSCode AI',
  cline: 'Cline - Specialized models for Cline',
  'claude-code': 'Claude Code - Use Claude via the Claude Code CLI (no API key needed)',
};
