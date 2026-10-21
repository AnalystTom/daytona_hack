"""'What changed since report X?' — compare the memory as of the report date with today."""
import json
from typing import Literal

from pydantic import BaseModel, Field

from . import memory
from .config import MODEL, llm, tracer


class ThesisImpact(BaseModel):
    thesis: str = Field(description="Original thesis from the base report")
    status: Literal["holds", "revised_by_author", "challenged_by_others", "contradicted_by_data", "needs_recompute"]
    what_changed: str
    evidence: list[str] = Field(description="Citation markers like M3 or V1 backing this row")
    updated_view: str = Field(description="Where the number/thesis stands now, with figures")


class ChangeReport(BaseModel):
    headline: str
    impacts: list[ThesisImpact]
    beyond_the_street: list[str] = Field(description="Extra analysis the sell-side notes do not provide")
    caveats: list[str]
    briefing_script: str = Field(description="~60 second spoken briefing for a portfolio manager, plain sentences")


PROMPT = """You audit sell-side research for an investment team. You get:
(A) what the memory knew AS OF the base report date, (B) what it knows NOW, and
(V) sandbox verification of claims against SEC filings.
Different institutions' forecasts are parallel views: never treat Morgan Stanley's number as a
correction of Goldman's. A newer note from the SAME author revises that author's view.
Cite only markers that appear in the inputs (M.. for memory, V.. for verifications).
If evidence is missing say so; do not invent numbers. No investment advice."""


def what_changed(base: dict, verifications: list[dict], topic: str) -> dict:
    """base: {author, title, date, claims:[...]}."""
    with tracer.start_as_current_span("what_changed") as span:
        span.set_attribute("input.value", f"{base['title']} ({base['date']}) on {topic}")
        then = memory.recall(topic, as_of=base["date"])
        now = memory.recall(topic)
        ver = "\n".join(
            f"[V{i}] claim={json.dumps(v['claim'])} result={json.dumps(v['result'])}"
            for i, v in enumerate(verifications, 1)
        )
        report = llm.responses.parse(
            model=MODEL,
            instructions=PROMPT,
            input=(
                f"BASE REPORT: {base['author']} — {base['title']} ({base['date']})\n"
                f"Base theses:\n" + "\n".join(f"- {c['statement']}" for c in base["claims"]) +
                f"\n\n(A) MEMORY AS OF {base['date']}:\n{memory.hits_as_text(then)}"
                f"\n\n(B) MEMORY NOW:\n{memory.hits_as_text(now)}"
                f"\n\n(V) VERIFICATIONS:\n{ver or 'none'}"
            ),
            text_format=ChangeReport,
        ).output_parsed
        out = {
            "report": report.model_dump(),
            "memory_then": then.get("hits", []),
            "memory_now": now.get("hits", []),
            "trace_ids": [then.get("trace", {}).get("traceId"), now.get("trace", {}).get("traceId")],
        }
        span.set_attribute("output.value", report.model_dump_json())
        return out
