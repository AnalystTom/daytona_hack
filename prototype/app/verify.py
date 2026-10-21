"""Check claims against primary filings.

Primary data (SEC XBRL) is fetched on the host and copied into a Daytona sandbox that has no
network access. The LLM writes the analysis code; it only ever runs inside the sandbox.
"""
import csv
import io
import json

import httpx
from daytona import Daytona
from pydantic import BaseModel

from .config import MODEL, llm, tracer

SEC_UA = {"User-Agent": "research-replay hackathon iv294@cam.ac.uk"}
HYPERSCALERS = {
    "MSFT": ("0000789019", "PaymentsToAcquirePropertyPlantAndEquipment"),
    "GOOGL": ("0001652044", "PaymentsToAcquirePropertyPlantAndEquipment"),
    "AMZN": ("0001018724", "PaymentsToAcquireProductiveAssets"),
    "META": ("0001326801", "PaymentsToAcquirePropertyPlantAndEquipment"),
    "ORCL": ("0001341439", "PaymentsToAcquirePropertyPlantAndEquipment"),
}


def sec_capex_rows() -> list[dict]:
    """Every reported capex value since 2024 (10-Q year-to-date and quarterly, 10-K annual)."""
    from datetime import date

    latest: dict[tuple, dict] = {}
    for ticker, (cik, concept) in HYPERSCALERS.items():
        r = httpx.get(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json",
                      headers=SEC_UA, timeout=30)
        r.raise_for_status()
        for x in r.json()["units"]["USD"]:
            if x["end"] < "2024-01-01" or x["form"] not in ("10-Q", "10-K"):
                continue
            days = (date.fromisoformat(x["end"]) - date.fromisoformat(x["start"])).days + 1
            row = {"ticker": ticker, "start": x["start"], "end": x["end"], "duration_days": days,
                   "capex_usd_bn": round(x["val"] / 1e9, 3), "form": x["form"], "filed": x["filed"],
                   "accession": x["accn"]}
            key = (ticker, x["start"], x["end"])
            if key not in latest or row["filed"] > latest[key]["filed"]:
                latest[key] = row
    return sorted(latest.values(), key=lambda r: (r["ticker"], r["end"], r["duration_days"]))


def rows_to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


class Analysis(BaseModel):
    plan: str
    code: str


CODE_PROMPT = """You are a quant analyst. Write a self-contained Python 3 script (pandas available,
NO network) that reads /home/daytona/capex.csv with columns
ticker, start, end, duration_days, capex_usd_bn, form, filed, accession.
Rows are cash capex as reported in 10-Q/10-K filings: some are single quarters (~90 days), some are
fiscal year-to-date (~180/270 days) or full fiscal years (~365 days). MSFT (June FY end) and ORCL
(May FY end) have non-calendar fiscal years. Derive single quarters by differencing year-to-date
values, then build calendar-year or trailing totals from quarters, and state what you did.
The script must print exactly one JSON object as its last line with keys:
  "observed": {...numbers you computed...},
  "claim_value_usd_bn": number or null,
  "comparable_actual_usd_bn": number or null,
  "verdict": "consistent" | "inconsistent" | "not_yet_verifiable",
  "explanation": short string,
  "latest_filing": latest 'filed' date used.
Be explicit about partial-year data: annualise year-to-date only as a labelled run-rate."""


def _sandbox_run(sandbox, code: str) -> str:
    res = sandbox.process.code_run(code)
    if res.exit_code != 0:
        raise RuntimeError(res.result[-1500:])
    return res.result


def verify_claim(claim: dict, rows: list[dict] | None = None) -> dict:
    """claim: {author, statement, value_usd_bn, period, date}. Returns verdict + code + output."""
    with tracer.start_as_current_span("verify_claim") as span:
        span.set_attribute("input.value", json.dumps(claim))
        rows = rows or sec_capex_rows()
        sandbox = Daytona().create()
        try:
            sandbox.fs.upload_file(rows_to_csv(rows).encode(), "/home/daytona/capex.csv")
            ask = f"Claim to check (published {claim.get('date')} by {claim.get('author')}):\n{json.dumps(claim)}"
            error = None
            for _ in range(2):
                prompt = ask if error is None else f"{ask}\n\nYour previous script failed:\n{error}\nFix it."
                gen = llm.responses.parse(model=MODEL, instructions=CODE_PROMPT, input=prompt,
                                          text_format=Analysis).output_parsed
                try:
                    out = _sandbox_run(sandbox, gen.code)
                    result = json.loads(out.strip().splitlines()[-1])
                    break
                except Exception as e:
                    error = str(e)
            else:
                result = {"verdict": "not_yet_verifiable", "explanation": f"analysis failed: {error[:300]}"}
                out = error
            payload = {"claim": claim, "plan": gen.plan, "code": gen.code, "stdout": out[-3000:],
                       "result": result, "sandbox_id": sandbox.id}
            span.set_attribute("output.value", json.dumps(result))
            return payload
        finally:
            sandbox.delete()
