"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Fixed benchmark task: a messy invoice into strict JSON, graded by an ARITHMETIC quality gate. The checker is deterministic so every framework is graded identically, and the gate is the exact "quality gate before advancement" axis the 2026-07-17 competitive study contested -- so measuring what each framework SPENDS to pass it is the point. The arithmetic is deliberately non-trivial (quantity x unit price, plus a percentage tax on a running subtotal) so a small model slips often enough that the review loop actually engages.
"""
import json
import re

# The printed TOTAL ($1,500.00) is wrong on purpose, and two lines require arithmetic the model must
# do itself: a quantity x unit-price line, and a percentage tax on the subtotal of the lines above it.
# A correct answer must COMPUTE each amount and make `total` equal the sum of its own line_items --
# never copy the printed total. Harder arithmetic means more first-try slips, which is precisely when
# a review gate earns its keep and spends the extra tokens this benchmark measures.
INVOICE = """\
ACME INDUSTRIAL SUPPLY -- INVOICE
Date: March 4, 2026
Bill to: Emerald Coast Systems

  Widget, heavy-duty ......... 3 @ $412.50 each
  Freight and handling ....................... $85.50
  Rush surcharge ............................. $200
  Sales tax .................. 7.5% of the three lines above
--------------------------------------------------------
  TOTAL DUE ............................ $1,500.00   (USD)
"""

SCHEMA = (
    '{"vendor": string, "date": string, "currency": string, '
    '"line_items": [{"description": string, "amount": number}], "total": number}'
)


def instruction():
    """The system instruction -- identical for every runner."""
    return (
        "You extract invoice data into STRICT JSON. Return ONLY the JSON object: no prose, "
        "no explanation, no code fences.\n"
        "Schema:\n" + SCHEMA + "\n"
        "Rules: amounts are plain numbers (strip the dollar sign and commas). Compute every amount "
        "yourself: the widget line is quantity times unit price, and sales tax is 7.5% of the sum of "
        "the three lines above it (round to 2 decimals). The printed total is unreliable -- `total` "
        "MUST equal the exact sum of your line_items amounts."
    )


def user_message():
    """The task input -- identical for every runner."""
    return "Extract this invoice:\n\n" + INVOICE


def _strip(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start >= 0 and end > start else text


def check(text):
    """Deterministically grade one candidate answer.

    @returns (passed: bool, error: str). The same function grades every framework, so the comparison
      is of orchestration cost to reach a passing answer -- never of grading luck. The gate is internal
      consistency (sum of line_items equals total), which is framework-neutral and cheap to verify.
    """
    try:
        obj = json.loads(_strip(text))
    except Exception as exc:  # noqa: BLE001 - any parse failure is a fail, with the reason
        return False, f"not valid JSON: {exc}"
    for key in ("vendor", "date", "currency", "line_items", "total"):
        if key not in obj:
            return False, f"missing key: {key}"
    items = obj.get("line_items")
    if not isinstance(items, list) or not items:
        return False, "line_items must be a non-empty list"
    try:
        line_sum = sum(float(item["amount"]) for item in items)
        total = float(obj["total"])
    except Exception as exc:  # noqa: BLE001
        return False, f"amounts/total not numeric: {exc}"
    if abs(line_sum - total) > 0.01:
        return False, f"arithmetic gate FAILED: line_items sum to {line_sum:.2f} but total={total:.2f}"
    return True, ""
