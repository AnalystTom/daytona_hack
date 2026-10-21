"""Fetch a research page. Anchor Browser when a key is set, plain HTTP otherwise."""
import json
import os

import httpx
import trafilatura

from .config import tracer

UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36",
    "Accept-Language": "en-US",
}


def _html_via_anchor(url: str) -> str:
    r = httpx.post(
        "https://api.anchorbrowser.io/v1/tools/fetch/webpage",
        headers={"anchor-api-key": os.environ["ANCHORBROWSER_API_KEY"]},
        json={"url": url},
        timeout=120,
    )
    r.raise_for_status()
    return r.text


def fetch_report(url: str) -> dict:
    """Return {url, title, date, text, via}."""
    with tracer.start_as_current_span("fetch_report") as span:
        span.set_attribute("input.value", url)
        via = "http"
        html = None
        if os.getenv("ANCHORBROWSER_API_KEY"):
            try:
                html, via = _html_via_anchor(url), "anchor"
            except Exception as e:  # fall back to plain HTTP, but record why
                span.set_attribute("anchor.error", str(e)[:300])
        if html is None:
            r = httpx.get(url, headers=UA, timeout=30, follow_redirects=True)
            r.raise_for_status()
            html = r.text
        meta = json.loads(trafilatura.extract(html, output_format="json", with_metadata=True) or "{}")
        doc = {
            "url": url,
            "title": meta.get("title") or url,
            "date": meta.get("date"),
            "text": meta.get("text") or "",
            "via": via,
        }
        span.set_attribute("output.value", f"{doc['title']} ({doc['date']}, {len(doc['text'])} chars via {via})")
        return doc
