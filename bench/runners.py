"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Benchmark runners: a vanilla single-shot control, a real LangGraph supervisor loop, and the live OSHAL cluster. Each runs the SAME task on the SAME free model; an unavailable leg reports status=not-run with the reason, NEVER a fabricated number (that would be the exact sin the competitive study just punished).
2 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P5: run_oshal was a stub that set status=not-run unconditionally, so the benchmark measured competitors and never us. It now takes the same (model, rounds) signature as the other legs and delegates to oshal_leg.measure - the REAL dispatch (POST /api/send-message as a service-secret machine caller -> executeBotOrInline -> bot node or inline orchestrator) priced from chat_tasks' own token/cost columns. Every leg also records the model it ran on, so the parity the benchmark rests on is in the row, not assumed.
"""
import time

import oshal_leg
from task import check, instruction, user_message


def _blank(name):
    return {
        "runner": name,
        "status": "ran",
        "passed": False,
        "rounds": 0,
        "llm_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "wall_ms": 0,
        "reason": "",
    }


def run_vanilla(model, max_rounds=1):
    """Control: one model call, one check, no framework. The floor every framework is measured against."""
    result = _blank("vanilla (no framework)")
    result["model"] = model.model
    started = time.time()
    out = model.chat(
        [
            {"role": "system", "content": instruction()},
            {"role": "user", "content": user_message()},
        ]
    )
    result["llm_calls"] = 1
    result["rounds"] = 1
    result["input_tokens"] = out["input_tokens"]
    result["output_tokens"] = out["output_tokens"]
    result["cost_usd"] = out["cost_usd"]
    result["passed"] = check(out["text"])[0]
    result["wall_ms"] = round((time.time() - started) * 1000)
    return result


def run_langgraph(model, max_rounds=4):
    """Real LangGraph supervisor loop: extractor -> deterministic gate -> retry-with-error, bounded."""
    result = _blank("langgraph (supervisor loop)")
    result["model"] = model.model
    try:
        from typing import TypedDict

        from langgraph.graph import END, START, StateGraph
    except Exception as exc:  # noqa: BLE001
        result["status"] = "not-run"
        result["reason"] = f"langgraph import failed: {exc}"
        return result

    meter = {"calls": 0, "in": 0, "out": 0, "cost": 0.0}

    def call(messages):
        out = model.chat(messages)
        meter["calls"] += 1
        meter["in"] += out["input_tokens"]
        meter["out"] += out["output_tokens"]
        meter["cost"] += out["cost_usd"]
        return out["text"]

    class State(TypedDict):
        messages: list
        rounds: int
        passed: bool
        error: str

    def extractor(state):
        text = call(state["messages"])
        passed, error = check(text)
        return {
            "messages": state["messages"] + [{"role": "assistant", "content": text}],
            "rounds": state["rounds"] + 1,
            "passed": passed,
            "error": error,
        }

    def gate(state):
        if state["passed"] or state["rounds"] >= max_rounds:
            return END
        return "retry"

    def retry(state):
        # The reviewer feeds the deterministic error back in - the multi-round review the study contested.
        return {
            "messages": state["messages"]
            + [{"role": "user", "content": f"That failed the check: {state['error']}. Return only corrected JSON."}]
        }

    graph = StateGraph(State)
    graph.add_node("extractor", extractor)
    graph.add_node("retry", retry)
    graph.add_edge(START, "extractor")
    graph.add_conditional_edges("extractor", gate, {END: END, "retry": "retry"})
    graph.add_edge("retry", "extractor")
    app = graph.compile()

    started = time.time()
    final = app.invoke(
        {
            "messages": [
                {"role": "system", "content": instruction()},
                {"role": "user", "content": user_message()},
            ],
            "rounds": 0,
            "passed": False,
            "error": "",
        },
        {"recursion_limit": max_rounds * 3 + 5},
    )
    result["wall_ms"] = round((time.time() - started) * 1000)
    result["passed"] = final["passed"]
    result["rounds"] = final["rounds"]
    result["llm_calls"] = meter["calls"]
    result["input_tokens"] = meter["in"]
    result["output_tokens"] = meter["out"]
    result["cost_usd"] = meter["cost"]
    return result


def run_oshal(model, max_rounds=4):
    """The live oshal cluster: the REAL dispatch, priced from chat_tasks (see oshal_leg.py).

    @param model - the shared FreeModel; only its NAME is used (the parity target). This leg never
      calls OpenRouter itself - the cluster runs the model, and the ledger reports what it spent.
    @param max_rounds - accepted for signature parity; the cluster decides its own rounds.
    @returns one run record. A leg that is not configured, is refused, or whose spend never
      reached chat_tasks is not-run with the reason; an answer on another model is off-model.
    """
    result = _blank("oshal (live cluster)")
    result["model"] = model.model
    try:
        result.update(oshal_leg.measure(model.model))
    except oshal_leg.LegError as exc:
        result["status"] = "not-run"
        result["reason"] = str(exc)
    except Exception as exc:  # noqa: BLE001 - a transport/driver failure is a reason, never a number
        result["status"] = "not-run"
        result["reason"] = f"{type(exc).__name__}: {str(exc)[:160]}"
    return result
