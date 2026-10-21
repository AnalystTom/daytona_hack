"""Turn a research article into dated, attributed, checkable claims."""
from typing import Literal

from pydantic import BaseModel, Field

from .config import MODEL, llm, tracer


class Claim(BaseModel):
    statement: str = Field(description="One self-contained claim, as the author makes it")
    kind: Literal["forecast", "consensus", "historical", "opinion"]
    metric: str = Field(description="snake_case metric key, e.g. hyperscaler_capex_2026")
    value_usd_bn: float | None = Field(description="Numeric value in USD billions if the claim has one")
    period: str | None = Field(description="Period the value refers to, e.g. '2026' or 'Q2 2026'")
    assumptions: list[str] = Field(description="Assumptions the claim depends on")
    quote: str = Field(description="Exact sentence from the article supporting the claim")
    data_needed: str = Field(description="Primary data that would confirm or refute it (filings, macro series)")


class Extraction(BaseModel):
    author: str = Field(description="Institution, e.g. 'Goldman Sachs Research'")
    claims: list[Claim]


PROMPT = """You reverse-engineer sell-side research. Extract the 3-6 most decision-relevant,
checkable claims about the investment thesis. Keep each author's forecasts as their own claims:
never merge numbers from different institutions. Quote the article exactly."""


def extract_claims(doc: dict, known_metrics: list[str] = ()) -> Extraction:
    with tracer.start_as_current_span("extract_claims") as span:
        span.set_attribute("input.value", doc["title"])
        resp = llm.responses.parse(
            model=MODEL,
            instructions=PROMPT,
            input=f"Reuse these metric keys when the claim is about the same quantity: {sorted(known_metrics)}\n"
            f"Title: {doc['title']}\nPublished: {doc['date']}\nURL: {doc['url']}\n\n{doc['text'][:20000]}",
            text_format=Extraction,
        )
        out = resp.output_parsed
        span.set_attribute("output.value", out.model_dump_json())
        return out
