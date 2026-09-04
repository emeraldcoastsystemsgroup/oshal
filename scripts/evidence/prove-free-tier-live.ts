/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Plan B live proof — hits each connectable free source once with a REAL 1-token completion and reports which actually answer. The free-tier "run for free by default" story is only true if the sources respond; the free catalog churns (delisted/paid/rate-limited), so this is the honest, repeatable check. Reads keys from env only (never hardcoded): OPENROUTER_API_KEY / GROQ_API_KEY / GEMINI_API_KEY / CEREBRAS_API_KEY / MISTRAL_API_KEY. For OpenRouter it ALSO discovers currently-live :free models from GET /models and probes the platform rotation, since that is the "user connected nothing" default path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OpenRouter lane now ACTUALLY discovers its candidates from GET /models (the change-log line above claimed discovery but the lane was hardcoded — and 2 of its 3 ids had rotted). Same :free + zero-pricing double filter and family/context ranking as the runtime (free-tier-rotation.ts discoverPlatformFreeModels); top 5 probed. Kept standalone (no src imports) so the evidence harness runs on a bare checkout.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Gemini lane candidates refreshed — Google zeroed free quota on gemini-2.0-flash (429 limit:0) and retired 1.5-flash (404); replaced with live-probed gemini-flash-lite-latest (self-updating alias) + gemini-3.1-flash-lite, matching free-tier-providers.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Operator pasted groq/cerebras/mistral keys; two lane defects found and fixed. (a) keyEnv -> keyEnvs[]: the gemini lane read only GEMINI_API_KEY and reported "not configured" while a valid key sat in GOOGLE_API_KEY (compose + optimizer-providers already honour both). (b) Cerebras retired every llama-3.x id (GET /models now lists gpt-oss-120b / gemma-4-31b / zai-glm-4.7 only), so the lane reported DOWN with a working key — candidates refreshed, matching free-tier-providers.ts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Hugging Face Inference Providers lane (HF_TOKEN / HUGGINGFACE_API_KEY) against the OpenAI-compatible router — candidates match free-tier-providers.ts (`:cheapest` policy suffix; live-probed via GET /v1/models 2026-09-04). This script is the REAL companion for the doubled vendor probe in tests/unit/huggingface-lane.spec.ts.
 */

/**
 * Free-tier live proof.
 *
 *   OPENROUTER_API_KEY=... npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/evidence/prove-free-tier-live.ts
 *
 * Exit 0 = at least one free lane answered live. Non-zero = every configured lane failed.
 * No keys configured = exit 0 with a "nothing to test" note (not a failure).
 *
 * @module scripts/evidence/prove-free-tier-live
 */

interface Lane {
  provider: string;
  /** Env vars holding this lane's key, first non-empty wins (mirrors optimizer-providers COMPAT). */
  keyEnvs: string[];
  baseUrl: string;
  /** Candidate models tried in order (first live one wins). Empty when discoverFree is set. */
  models: string[];
  /** Discover `:free` candidates from GET /models at run time (OpenRouter — the catalog churns). */
  discoverFree?: boolean;
}

const LANES: Lane[] = [
  {
    provider: 'openrouter', keyEnvs: ['OPENROUTER_API_KEY'], baseUrl: 'https://openrouter.ai/api/v1',
    models: [], discoverFree: true,
  },
  { provider: 'groq', keyEnvs: ['GROQ_API_KEY'], baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  // Gemini also honours GOOGLE_API_KEY — the same fallback compose and optimizer-providers use.
  { provider: 'gemini', keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite'] },
  // Cerebras retired the llama-3.x ids (live-probed 2026-07-11); gpt-oss-120b is a REASONING model,
  // so the probe needs a real max_tokens budget or it returns 200-but-empty.
  { provider: 'cerebras', keyEnvs: ['CEREBRAS_API_KEY'], baseUrl: 'https://api.cerebras.ai/v1', models: ['gpt-oss-120b', 'gemma-4-31b', 'zai-glm-4.7'] },
  { provider: 'mistral', keyEnvs: ['MISTRAL_API_KEY'], baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-small-latest', 'open-mistral-nemo'] },
  // Hugging Face router: `:cheapest` picks the lowest-priced live provider for the model. The gpt-oss
  // ids are reasoning models — same max_tokens caveat as Cerebras.
  { provider: 'huggingface', keyEnvs: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], baseUrl: 'https://router.huggingface.co/v1', models: ['openai/gpt-oss-20b:cheapest', 'meta-llama/Llama-3.1-8B-Instruct:cheapest', 'openai/gpt-oss-120b:cheapest'] },
];

/** Probe-order preference over the discovered catalog — mirrors free-tier-rotation.ts. */
const FAMILY_ORDER = ['openai/', 'meta-llama/', 'qwen/', 'google/', 'mistralai/', 'nvidia/', 'deepseek/'];
const familyRank = (id: string): number => {
  const i = FAMILY_ORDER.findIndex((prefix) => id.startsWith(prefix));
  return i === -1 ? FAMILY_ORDER.length : i;
};

/**
 * @description Discover currently-listed `:free` models from GET /models — same double filter
 * (`:free` suffix AND zero prompt+completion pricing) and family/context ranking as the runtime's
 * discoverPlatformFreeModels (src/app/routes/free-tier-rotation.ts). Duplicated deliberately so
 * this evidence harness stays standalone-runnable on a bare checkout.
 * @returns top-5 ranked free model ids (empty on discovery failure — the lane then reports DOWN)
 */
async function discoverFreeModels(lane: Lane, apiKey: string): Promise<string[]> {
  try {
    const r = await fetch(`${lane.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) return [];
    const body = await r.json().catch(() => null) as { data?: Array<{ id?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }> } | null;
    const free = (body?.data ?? []).filter((m) =>
      typeof m?.id === 'string' && /:free$/i.test(m.id)
      && Number(m.pricing?.prompt ?? '0') === 0 && Number(m.pricing?.completion ?? '0') === 0);
    free.sort((a, b) => familyRank(a.id!) - familyRank(b.id!) || (b.context_length ?? 0) - (a.context_length ?? 0));
    return free.map((m) => m.id!).slice(0, 5);
  } catch {
    return [];
  }
}

interface Result { provider: string; model?: string; ok: boolean; detail: string; reply?: string }

/**
 * @description Fires one real completion (enough tokens for reasoning models to finish, not 1) and
 * reports whether it produced content.
 * @returns ok + the model that answered, or the failure code.
 */
async function tryModel(lane: Lane, apiKey: string, model: string): Promise<{ ok: boolean; detail: string; reply?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const r = await fetch(`${lane.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly the three words: free swarm online' }],
        max_tokens: 200, temperature: 0, stream: false,
      }),
      signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({})) as { error?: { message?: string; code?: unknown }; choices?: Array<{ message?: { content?: string } }> };
    if (!r.ok || body.error) {
      return { ok: false, detail: `${r.status} ${String(body.error?.message ?? '').slice(0, 60)}`.trim() };
    }
    const reply = (body.choices?.[0]?.message?.content ?? '').trim();
    if (!reply) return { ok: false, detail: '200 but empty content' };
    return { ok: true, detail: 'ok', reply: reply.slice(0, 40) };
  } catch (err) {
    return { ok: false, detail: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** @description First non-empty key across a lane's env vars (e.g. GEMINI_API_KEY then GOOGLE_API_KEY). */
function laneKey(lane: Lane): string {
  for (const env of lane.keyEnvs) {
    const v = (process.env[env] || '').trim();
    if (v) return v;
  }
  return '';
}

/** @description Probes a lane's candidate models in order; returns the first that answers. */
async function proveLane(lane: Lane): Promise<Result> {
  const apiKey = laneKey(lane);
  if (!apiKey) return { provider: lane.provider, ok: false, detail: `no ${lane.keyEnvs.join('/')}` };
  const models = lane.discoverFree ? await discoverFreeModels(lane, apiKey) : lane.models;
  if (lane.discoverFree && !models.length) {
    return { provider: lane.provider, ok: false, detail: 'GET /models discovery returned no :free candidates' };
  }
  for (const model of models) {
    const res = await tryModel(lane, apiKey, model);
    if (res.ok) return { provider: lane.provider, model, ...res };
  }
  return { provider: lane.provider, ok: false, detail: 'all candidate models failed' };
}

async function main(): Promise<void> {
  const configured = LANES.filter((l) => laneKey(l));
  console.log(`# Free-tier live proof — ${configured.length}/${LANES.length} lanes have a key configured\n`);
  if (configured.length === 0) {
    console.log('No free-tier keys in env (OPENROUTER_API_KEY / GROQ_API_KEY / ...). Nothing to test.');
    process.exit(0);
  }

  const results: Result[] = [];
  for (const lane of LANES) results.push(await proveLane(lane));

  let live = 0;
  for (const r of results) {
    // Ask the LANE for its key (it may live under any of keyEnvs, e.g. gemini → GOOGLE_API_KEY).
    // Re-deriving "<PROVIDER>_API_KEY" here used to print a live lane as "not configured".
    const lane = LANES.find((l) => l.provider === r.provider)!;
    if (!laneKey(lane)) { console.log(`  --   ${r.provider.padEnd(11)} not configured`); continue; }
    if (r.ok) { live++; console.log(`  LIVE ${r.provider.padEnd(11)} ${r.model}  ->  "${r.reply}"`); }
    else { console.log(`  DOWN ${r.provider.padEnd(11)} ${r.detail}`); }
  }

  console.log(`\n${live}/${configured.length} configured free lanes answered live.`);
  if (live === 0) { console.log('FAIL: no free lane is currently usable.'); process.exit(1); }
  console.log('PASS: the swarm can run for free right now.');
  process.exit(0);
}

void main();
