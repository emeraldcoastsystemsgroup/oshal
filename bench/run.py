"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Cost/determinism benchmark entrypoint. Runs the SAME review-gated task on the SAME free model across frameworks and records REAL tokens/rounds/wall-time. This exists to convert the un-earned "our cluster is cheaper" claim into a measured one; legs that can't run are reported not-run, never faked.  Usage: python bench/run.py [--runners vanilla,langgraph,oshal] [--rounds 4]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from model import FreeModel  # noqa: E402
import runners as runner_mod  # noqa: E402

ALL_RUNNERS = {
    "vanilla": runner_mod.run_vanilla,
    "langgraph": runner_mod.run_langgraph,
    "oshal": runner_mod.run_oshal,
}

COLS = ("runner", "status", "passed", "rounds", "llm_calls", "input_tokens", "output_tokens", "wall_ms")


def _row(result):
    passed = "yes" if result["passed"] else ("--" if result["status"] != "ran" else "NO")
    cells = [
        result["runner"][:26].ljust(26),
        result["status"].ljust(8),
        passed.ljust(6),
        str(result["rounds"]).rjust(6),
        str(result["llm_calls"]).rjust(9),
        str(result["input_tokens"]).rjust(12),
        str(result["output_tokens"]).rjust(13),
        str(result["wall_ms"]).rjust(7),
    ]
    return "  ".join(cells)


def main():
    parser = argparse.ArgumentParser(description="OSHAL cost/determinism benchmark")
    parser.add_argument("--runners", default="vanilla,langgraph,oshal")
    parser.add_argument("--rounds", type=int, default=4, help="max review rounds before giving up")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"))
    args = parser.parse_args()

    model = FreeModel()
    print(f"model : {model.model}  (free)")
    print("task  : messy invoice -> strict JSON, arithmetic quality gate (deterministic)\n")

    header = "  ".join([
        "runner".ljust(26), "status".ljust(8), "passed".ljust(6), "rounds".rjust(6),
        "llm_calls".rjust(9), "input_tokens".rjust(12), "output_tokens".rjust(13), "wall_ms".rjust(7),
    ])
    print(header)
    print("-" * len(header))

    results = []
    for name in [item.strip() for item in args.runners.split(",") if item.strip()]:
        func = ALL_RUNNERS.get(name)
        if func is None:
            continue
        try:
            result = func(args.rounds) if name == "oshal" else func(model, args.rounds)
        except Exception as exc:  # noqa: BLE001 - a leg that dies (e.g. rate-limited) is not-run, never a fake number
            result = {"runner": name, "status": "not-run", "passed": False, "rounds": 0,
                      "llm_calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
                      "wall_ms": 0, "reason": f"leg errored: {type(exc).__name__}: {str(exc)[:160]}"}
        results.append(result)
        print(_row(result))

    not_run = [r for r in results if r["status"] != "ran"]
    if not_run:
        print("\nnot-run (honest - no numbers invented):")
        for result in not_run:
            print(f"  - {result['runner']}: {result['reason']}")

    os.makedirs(args.out, exist_ok=True)
    payload = {
        "proofTier": "live",
        "model": model.model,
        "task": "invoice-extract-arithmetic-gate",
        "note": "Real token/round counts from live free-model calls. Not-run legs carry a reason, never a number.",
        "results": results,
    }
    out_path = os.path.join(args.out, "latest.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    print(f"\nwrote {os.path.relpath(out_path)}")


if __name__ == "__main__":
    main()
