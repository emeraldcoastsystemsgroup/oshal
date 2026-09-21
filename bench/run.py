"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Cost/determinism benchmark entrypoint. Runs the SAME review-gated task on the SAME free model across frameworks and records REAL tokens/rounds/wall-time. This exists to convert the un-earned "our cluster is cheaper" claim into a measured one; legs that can't run are reported not-run, never faked.  Usage: python bench/run.py [--runners vanilla,langgraph,oshal] [--rounds 4]
2 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P5: every leg now takes (model, rounds) - the oshal leg needs the benchmark model NAME for its parity check - and the run carries a stated n. --n repeats every leg; each result keeps its per-run records under `runs`, the headline numbers are the median over the runs that ran, and `passed` counts passing runs so the table reads k/n. The table gains a model column because a leg that answered on a different model (status off-model) is a real measurement that is not the comparison this benchmark makes, and it must be visible as such rather than sit in the same column as a like-for-like row. The results file is written with LF line endings on every platform, so the committed artifact does not flip endings depending on which box regenerated it.
"""
import argparse
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from model import FreeModel  # noqa: E402
import runners as runner_mod  # noqa: E402

ALL_RUNNERS = {
    "vanilla": runner_mod.run_vanilla,
    "langgraph": runner_mod.run_langgraph,
    "oshal": runner_mod.run_oshal,
}

NUMERIC = ("rounds", "llm_calls", "input_tokens", "output_tokens", "cost_usd", "wall_ms")
COMPARABLE = ("ran", "off-model")
AGGREGATE_NOTE = "headline numbers are the median over the runs that ran; passed counts passing runs out of n"


def _header():
    return "  ".join([
        "runner".ljust(26), "status".ljust(9), "n".rjust(3), "passed".rjust(6), "rounds".rjust(6),
        "llm_calls".rjust(9), "input_tokens".rjust(12), "output_tokens".rjust(13), "wall_ms".rjust(7), "model",
    ])


def _row(result):
    n = result.get("n", 1)
    passed = f"{result['passed']}/{n}" if result["status"] in COMPARABLE else "--"
    cells = [
        result["runner"][:26].ljust(26),
        result["status"].ljust(9),
        str(n).rjust(3),
        passed.rjust(6),
        str(result["rounds"]).rjust(6),
        str(result["llm_calls"]).rjust(9),
        str(result["input_tokens"]).rjust(12),
        str(result["output_tokens"]).rjust(13),
        str(result["wall_ms"]).rjust(7),
        str(result.get("model", ""))[:40],
    ]
    return "  ".join(cells)


def _failed_run(name, exc):
    # A leg that dies (e.g. rate-limited) is not-run with the reason, never a fake number.
    return {"runner": name, "status": "not-run", "passed": False, "rounds": 0, "llm_calls": 0,
            "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "wall_ms": 0,
            "reason": f"leg errored: {type(exc).__name__}: {str(exc)[:160]}"}


def aggregate(runs):
    """Fold n runs of one leg into one row without inventing anything.

    @param runs - the per-run records, in order.
    @returns one record: status is `ran` only when every run ran (otherwise the first other status
      and its reason), the numeric fields are medians over the runs that ran (over the off-model runs
      when none did), `passed` counts passing runs, and `runs` keeps every record so the n is
      inspectable rather than asserted.
    """
    ran = [run for run in runs if run["status"] == "ran"]
    counted = ran or [run for run in runs if run["status"] == "off-model"]
    result = {key: value for key, value in runs[0].items() if key not in NUMERIC and key not in ("passed", "status", "reason")}
    statuses = [run["status"] for run in runs]
    result["status"] = "ran" if all(status == "ran" for status in statuses) else next(s for s in statuses if s != "ran")
    result["reason"] = next((run["reason"] for run in runs if run["status"] != "ran" and run.get("reason")), "")
    result["passed"] = sum(1 for run in counted if run["passed"])
    for key in NUMERIC:
        values = [run[key] for run in counted]
        median = statistics.median(values) if values else 0
        result[key] = median if key == "cost_usd" else int(round(median))
    models = sorted({str(run.get("model", "")) for run in runs if run.get("model")})
    result["model"] = ", ".join(models)
    result["n"] = len(runs)
    result["runs"] = runs
    return result


def _run_leg(name, func, model, rounds, n):
    runs = []
    for _ in range(n):
        try:
            runs.append(func(model, rounds))
        except Exception as exc:  # noqa: BLE001 - see _failed_run
            runs.append(_failed_run(name, exc))
    return aggregate(runs)


def main():
    parser = argparse.ArgumentParser(description="OSHAL cost/determinism benchmark")
    parser.add_argument("--runners", default="vanilla,langgraph,oshal")
    parser.add_argument("--rounds", type=int, default=4, help="max review rounds before giving up")
    parser.add_argument("--n", type=int, default=1, help="runs per leg; " + AGGREGATE_NOTE)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"))
    args = parser.parse_args()
    n = max(1, args.n)

    model = FreeModel()
    print(f"model : {model.model}  (free)   n = {n} per leg")
    print("task  : messy invoice -> strict JSON, arithmetic quality gate (deterministic)\n")
    header = _header()
    print(header)
    print("-" * len(header))

    results = []
    for name in [item.strip() for item in args.runners.split(",") if item.strip()]:
        func = ALL_RUNNERS.get(name)
        if func is None:
            continue
        result = _run_leg(name, func, model, args.rounds, n)
        results.append(result)
        print(_row(result))

    not_comparable = [r for r in results if r["status"] != "ran"]
    if not_comparable:
        print("\nnot comparable (honest - no numbers invented):")
        for result in not_comparable:
            print(f"  - {result['runner']} [{result['status']}]: {result['reason']}")

    os.makedirs(args.out, exist_ok=True)
    payload = {
        "proofTier": "live",
        "model": model.model,
        "n": n,
        "aggregate": AGGREGATE_NOTE,
        "task": "invoice-extract-arithmetic-gate",
        "note": "Real token/round counts from live calls. Not-run and off-model legs carry a reason; the oshal leg's numbers are read from chat_tasks.",
        "results": results,
    }
    out_path = os.path.join(args.out, "latest.json")
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, indent=2)
    print(f"\nwrote {os.path.relpath(out_path)}")


if __name__ == "__main__":
    main()
