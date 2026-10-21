"""End-to-end steps, with state kept in data/state.json for the UI."""
import json
from pathlib import Path

from . import memory
from .analyze import what_changed
from .config import tracer
from .extract import extract_claims
from .fetch import fetch_report
from .verify import sec_capex_rows, verify_claim

STATE = Path(__file__).resolve().parent.parent / "data" / "state.json"


def load() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"reports": [], "verifications": [], "changes": None}


def save(state: dict) -> None:
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))


def ingest(url: str, date: str | None = None) -> dict:
    """Fetch → extract claims → write dated, attributed claims to agent memory."""
    with tracer.start_as_current_span("ingest_report") as span:
        span.set_attribute("input.value", url)
        state = load()
        doc = fetch_report(url)
        doc["date"] = date or doc["date"]
        known = {c["metric"] for r in state["reports"] for c in r["claims"]}
        ex = extract_claims(doc, sorted(known))
        scope = memory.author_scope(ex.author)
        claims = []
        for c in ex.claims:
            value = f" Value: ${c.value_usd_bn:g}bn for {c.period}." if c.value_usd_bn is not None else ""
            memory.remember(
                f"{ex.author} ({doc['date']}) {c.kind}: {c.statement}{value} "
                f"Source: \"{doc['title']}\" <{doc['url']}>. Quote: \"{c.quote}\"",
                scope, doc["date"],
            )
            memory.remember_view(ex.author, c.metric, {
                "value_usd_bn": c.value_usd_bn, "statement": c.statement, "kind": c.kind,
                "period": c.period, "source_url": doc["url"], "published": doc["date"],
            }, doc["date"])
            claims.append(c.model_dump())
        report = {"author": ex.author, "title": doc["title"], "date": doc["date"], "url": url,
                  "via": doc["via"], "scope": scope, "claims": claims}
        state["reports"] = [r for r in state["reports"] if r["url"] != url] + [report]
        state["reports"].sort(key=lambda r: r["date"])
        save(state)
        span.set_attribute("output.value", f"{ex.author}: {len(claims)} claims")
        return report


def verify(report_url: str, max_claims: int = 2) -> list[dict]:
    """Recompute numeric capex claims of one report from SEC filings inside Daytona."""
    state = load()
    report = next(r for r in state["reports"] if r["url"] == report_url)
    rows = sec_capex_rows()
    checkable = [c for c in report["claims"] if c["value_usd_bn"] is not None and "capex" in c["metric"]]
    out = []
    for c in checkable[:max_claims]:
        v = verify_claim({"author": report["author"], "date": report["date"], "statement": c["statement"],
                          "value_usd_bn": c["value_usd_bn"], "period": c["period"], "metric": c["metric"]}, rows)
        out.append(v)
        r = v["result"]
        memory.remember(
            f"Replay verification ({r.get('latest_filing', 'latest filings')}): {report['author']} claim "
            f"\"{c['statement']}\" is {r.get('verdict')} with SEC filings. {r.get('explanation', '')}",
            memory.DATA_SCOPE, r.get("latest_filing") or report["date"],
        )
    state["verifications"] = [x for x in state["verifications"] if x["claim"]["author"] != report["author"]
                              or x["claim"]["date"] != report["date"]] + out
    save(state)
    return out


def changes(base_url: str, topic: str) -> dict:
    state = load()
    base = next(r for r in state["reports"] if r["url"] == base_url)
    result = what_changed(base, state["verifications"], topic)
    result["base_url"] = base_url
    result["topic"] = topic
    state["changes"] = result
    save(state)
    return result
