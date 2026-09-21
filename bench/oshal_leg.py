"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P5: the oshal leg reported not-run unconditionally, so the benchmark measured competitors and never us. This module POSTs the fixed task through the controller's REAL dispatch - POST /api/send-message as a service-secret machine caller bound to a user sub, which is the one-chokepoint path (executeBotOrInline -> the bot node's /api/swarm-execute, or the inline orchestrator) - and then reads the run's spend from chat_tasks' own total_input_tokens / total_output_tokens / total_cost / total_requests columns inside a READ ONLY transaction. The HTTP response's usage block is the node's claim about itself and is carried only as a cross-check; the ledger is the number. A run that cannot dispatch, has no ledger row, or answered on a different model than the other legs reports not-run / off-model with the reason, never a comparable number.
"""
import base64
import json
import re
import secrets
import time

import requests

from model import _from_env_or_dotenv

# The shared env/.env reader model.py uses, under a short name: every setting comes through it.
setting = _from_env_or_dotenv
from task import check, instruction, user_message

# The compose default for the controller; scripts/oshal-verify.sh assumes the same address.
DEFAULT_API_URL = "http://127.0.0.1:35457"
DEFAULT_PG_PORT = "55433"
# chat_tasks is FORCE row-level security. Measured on the live cluster: the app role reads
# 0 rows, the owner role reads every row. Only an owner-capable DSN is accepted - DATABASE_URL
# (the app role) is deliberately NOT a fallback, because it would read nothing and the leg
# would then blame a missing row instead of a wrong role.
DSN_VARS = ("OSHAL_BENCH_DSN", "OSHAL_COST_CENSUS_DSN", "BOOTSTRAP_DATABASE_URL")
LEDGER_SQL = (
    "SELECT task_id, agent_id, provider_id, total_input_tokens, total_output_tokens, "
    "total_cost, total_requests, usage_by_model FROM chat_tasks "
    "WHERE task_id = ANY(%s) AND total_requests > 0 ORDER BY task_id"
)


class LegError(RuntimeError):
    """A reason the oshal leg could not produce a comparable number. Reported, never hidden."""


def _b64url(value):
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def _flag(name, default):
    return (setting(name, default) or default).strip().lower() not in ("0", "false", "no")


def ledger_dsn():
    """Resolve the DSN the ledger is read through.

    @returns OSHAL_BENCH_DSN, else OSHAL_COST_CENSUS_DSN (what scripts/evidence/cost-per-ticket-type.ts
      reads), else BOOTSTRAP_DATABASE_URL with its in-network host rewritten to the published loopback
      port (OSHAL_PG_PORT) - or None when no owner-capable DSN is configured.
    """
    for name in DSN_VARS[:2]:
        value = setting(name)
        if value:
            return value
    bootstrap = setting("BOOTSTRAP_DATABASE_URL")
    if not bootstrap:
        return None
    port = setting("OSHAL_PG_PORT", DEFAULT_PG_PORT) or DEFAULT_PG_PORT
    return re.sub(r"@[^/@]+/", f"@127.0.0.1:{port}/", bootstrap, count=1)


def settings(benchmark_model):
    """Collect everything the leg needs, naming what is missing instead of guessing it.

    @param benchmark_model - the model NAME the other legs ran on; the parity target.
    @returns (config dict, list of missing-setting descriptions). The user sub defaults to a
      synthetic non-operator subject so the spend is attributed to the benchmark, never to the
      operator, and so the operator's own paid-provider exemption does not select the model.
    """
    cfg = {
        "api": (setting("OSHAL_BENCH_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).rstrip("/"),
        "secret": setting("SWARM_SERVICE_SECRET"),
        "sub": setting("OSHAL_BENCH_USER_SUB", "bench-oshal-leg") or "bench-oshal-leg",
        "agent": setting("OSHAL_BENCH_AGENT_ID"),
        "agentic": _flag("OSHAL_BENCH_AGENTIC", "true"),
        "dsn": ledger_dsn(),
        "dispatch_timeout_s": float(setting("OSHAL_BENCH_DISPATCH_TIMEOUT_S", "600") or 600),
        "ledger_wait_s": float(setting("OSHAL_BENCH_LEDGER_WAIT_S", "20") or 20),
        "model": benchmark_model,
    }
    missing = []
    if not cfg["secret"]:
        missing.append("SWARM_SERVICE_SECRET (the machine identity /api/send-message trusts)")
    if not cfg["dsn"]:
        missing.append(" or ".join(DSN_VARS) + " (an owner-capable DSN for the chat_tasks read)")
    return cfg, missing


def dispatch(cfg, task_id):
    """POST the task through the controller's real dispatch.

    @param cfg - settings() output.
    @param task_id - the thread id this run mints; it is also the workspace scope the node keys its
      cost row under.
    @returns the controller's JSON answer with `_wall_ms` added. Raises LegError on any non-200 or
      an explicit failure, so a refused run is a reason and never a zero.
    """
    headers = {
        "Content-Type": "application/json",
        "X-Service-Secret": cfg["secret"],
        "X-Oshal-User-Sub-B64": _b64url(cfg["sub"]),
    }
    body = {
        "taskId": task_id,
        "text": instruction() + "\n\n" + user_message(),
        "agenticMode": cfg["agentic"],
        "chatOnly": True,
        "interactionMode": "task",
        "source": "bench",
    }
    if cfg["agent"]:
        body["agentId"] = cfg["agent"]
    started = time.time()
    resp = requests.post(
        cfg["api"] + "/api/send-message", headers=headers, data=json.dumps(body), timeout=cfg["dispatch_timeout_s"],
    )
    wall_ms = round((time.time() - started) * 1000)
    if resp.status_code != 200:
        raise LegError(f"dispatch returned HTTP {resp.status_code}: {resp.text[:160]}")
    payload = resp.json()
    if payload.get("success") is False:
        raise LegError(f"dispatch reported failure: {str(payload.get('error') or '')[:160]}")
    payload["_wall_ms"] = wall_ms
    return payload


def _row(record):
    task_id, agent_id, provider_id, tokens_in, tokens_out, cost, requests_n, by_model = record
    if isinstance(by_model, str):
        by_model = json.loads(by_model or "{}")
    return {
        "task_id": task_id,
        "agent_id": agent_id,
        "provider_id": provider_id,
        "input_tokens": int(tokens_in or 0),
        "output_tokens": int(tokens_out or 0),
        "cost_usd": float(cost or 0),
        "requests": int(requests_n or 0),
        "models": sorted(str(key) for key in (by_model or {}).keys()),
    }


def read_ledger(dsn, candidates, wait_s):
    """Read the run's chat_tasks rows inside a READ ONLY transaction.

    @param dsn - an owner-capable DSN (see DSN_VARS).
    @param candidates - the task ids the run may have been recorded under: the thread id (inline
      bots) and `<thread>::<agent>` (a bot node rewrites its cost task id that way).
    @param wait_s - how long to keep re-reading, because the node's write lands after its answer.
    @returns the cost-bearing rows found, possibly empty. Nothing is ever written.
    """
    import psycopg2  # imported here so the other legs never need the driver

    deadline = time.time() + wait_s
    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        conn.set_session(readonly=True, autocommit=False)
        while True:
            with conn.cursor() as cur:
                cur.execute(LEDGER_SQL, (list(candidates),))
                rows = [_row(record) for record in cur.fetchall()]
            conn.rollback()
            if rows or time.time() >= deadline:
                return rows
            time.sleep(0.5)
    finally:
        conn.close()


def _measurement(cfg, payload, rows, agent_id):
    text = str(payload.get("response") or "")
    passed, gate_error = check(text)
    recorded = sorted({name for row in rows for name in row["models"]}) or [str(payload.get("model") or "")]
    providers = sorted({str(row["provider_id"] or "") for row in rows if row["provider_id"]})
    if not providers and payload.get("provider"):
        providers = [str(payload["provider"])]  # the inline rollup carries no provider_id; the answer names it
    usage = payload.get("usage") or {}
    result = {
        "status": "ran",
        "passed": passed,
        "rounds": 1,
        "llm_calls": sum(row["requests"] for row in rows),
        "input_tokens": sum(row["input_tokens"] for row in rows),
        "output_tokens": sum(row["output_tokens"] for row in rows),
        "cost_usd": round(sum(row["cost_usd"] for row in rows), 6),
        "wall_ms": payload["_wall_ms"],
        "reason": "",
        "gate_error": gate_error,
        "model": ", ".join(recorded),
        "provider": ", ".join(providers),
        "agent_id": agent_id,
        "agentic": cfg["agentic"],
        "chat_task_ids": [row["task_id"] for row in rows],
        # The node's own claim, kept beside the ledger so a divergence is visible - never the number.
        "response_usage": {
            "input_tokens": int(usage.get("inputTokens") or 0),
            "output_tokens": int(usage.get("outputTokens") or 0),
        },
    }
    if any(name.lower() != cfg["model"].lower() for name in recorded):
        result["status"] = "off-model"
        result["reason"] = (
            f"answered on {', '.join(recorded)} via {result['provider'] or 'unknown'}; the benchmark model is "
            f"{cfg['model']}. Real numbers, not a like-for-like comparison - point OSHAL_BENCH_AGENT_ID at a "
            "bot pinned to the benchmark model and re-run."
        )
    return result


def measure(benchmark_model):
    """One dispatch through the live cluster, graded by the shared check(), priced from the ledger.

    @param benchmark_model - the model the other legs ran on.
    @returns the fields for one run of the oshal leg. Raises LegError when the leg is not configured,
      the dispatch is refused, or the spend never reached chat_tasks - each a reason, not a number.
    """
    cfg, missing = settings(benchmark_model)
    if missing:
        raise LegError("not configured: " + "; ".join(missing))
    task_id = f"bench-oshal-{secrets.token_hex(8)}"
    payload = dispatch(cfg, task_id)
    thread_id = str(payload.get("taskIdUsed") or task_id)
    agent_id = str(payload.get("agentId") or cfg["agent"] or "")
    candidates = [thread_id] + ([f"{thread_id}::{agent_id}"] if agent_id else [])
    rows = read_ledger(cfg["dsn"], candidates, cfg["ledger_wait_s"])
    if not rows:
        raise LegError(
            f"dispatch answered but chat_tasks has no cost row for {' / '.join(candidates)} after "
            f"{cfg['ledger_wait_s']:g}s - the spend is unaccounted, so there is no number to report"
        )
    return _measurement(cfg, payload, rows, agent_id)
