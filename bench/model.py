"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | OpenRouter free-model client for the cost/determinism benchmark. Shared by every runner so the model is IDENTICAL across frameworks - the benchmark isolates orchestration overhead, not model choice. Enforces the hard :free-only guard.
"""
import json
import os
import re
import time

import requests

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _from_env_or_dotenv(name, default=None):
    """Read a setting from the process env, falling back to a top-level .env line.

    Keeps the key out of source and out of logs; only the model NAME is ever printed.
    """
    val = os.environ.get(name)
    if val:
        return val.strip()
    try:
        with open(os.path.join(os.getcwd(), ".env"), encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                match = re.match(rf"{name}=(.+)", line.strip())
                if match:
                    return match.group(1).strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return default


class FreeModel:
    """OpenAI-compatible chat client pinned to a single OpenRouter ``:free`` model.

    @description Every runner shares one instance, so the only thing that varies across
      the benchmark is the framework wrapped around the calls - the model, the client, and
      the token accounting are constant. Refuses any model that is not ``:free`` (the
      platform's standing free-only guard) so the benchmark can never quietly spend money.
    """

    MAX_RETRIES = 6

    def __init__(self):
        self.key = _from_env_or_dotenv("OPENROUTER_API_KEY")
        self.model = _from_env_or_dotenv("OPENROUTER_FREE_MODEL", "openai/gpt-oss-20b:free")
        # Free models are hard rate-limited; space calls so the multi-call legs don't 429 constantly.
        self.min_interval_s = float(_from_env_or_dotenv("BENCH_MIN_INTERVAL_S", "6") or 6)
        self._last_call = 0.0
        if not self.key:
            raise RuntimeError("OPENROUTER_API_KEY not set (env or .env) - cannot run the benchmark")
        if not self.model.endswith(":free"):
            raise RuntimeError(f"refusing non-free model {self.model!r} (hard :free-only guard)")

    def _throttle(self):
        gap = time.time() - self._last_call
        if gap < self.min_interval_s:
            time.sleep(self.min_interval_s - gap)

    def chat(self, messages, max_tokens=900, temperature=0):
        """Run one chat completion and return text plus REAL token usage.

        @param messages - OpenAI-shaped message list.
        @returns dict with text, input_tokens, output_tokens, cost_usd, wall_ms - all measured,
          none estimated. Raises on transport/HTTP error so a broken leg fails loudly, never silently.
        """
        body = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://oswarm.ai",
            "X-Title": "oshal-bench",
        }
        wall_ms = 0
        payload = None
        for attempt in range(self.MAX_RETRIES):
            self._throttle()
            started = time.time()
            resp = requests.post(OPENROUTER_URL, headers=headers, data=json.dumps(body), timeout=120)
            self._last_call = time.time()
            wall_ms = round((self._last_call - started) * 1000)
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == self.MAX_RETRIES - 1:
                    resp.raise_for_status()
                retry_after = float(resp.headers.get("Retry-After", 0) or 0)
                time.sleep(min(retry_after or (2 ** attempt) * 3, 40))
                continue
            resp.raise_for_status()
            payload = resp.json()
            break
        choice = (payload.get("choices") or [{}])[0]
        text = ((choice.get("message") or {}).get("content")) or ""
        usage = payload.get("usage") or {}
        return {
            "text": text,
            "input_tokens": int(usage.get("prompt_tokens", 0) or 0),
            "output_tokens": int(usage.get("completion_tokens", 0) or 0),
            "cost_usd": float(usage.get("cost", 0) or 0),
            "wall_ms": wall_ms,
        }
