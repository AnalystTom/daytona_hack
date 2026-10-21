"""SurrealDB Agent Memory: dated, attributed, scoped claims with as-of recall.

Scopes: org/replay/author/<institution> for each research house, org/replay/data/sec for
primary filings. A new note from an author supersedes that author's previous view; other
authors' views live in their own scope and are never overwritten.
"""
import os

import httpx

from .config import ORG, slug, tracer

BASE = f"{os.environ['SPECTRON_URL'].rstrip('/')}/api/v1/{os.environ['SPECTRON_CONTEXT_ID']}"
HEADERS = {"Authorization": f"Bearer {os.environ['SPECTRON_API_KEY']}"}
_known_scopes: set[str] = set()


def author_scope(author: str) -> str:
    return f"{ORG}/author/{slug(author)}"


DATA_SCOPE = f"{ORG}/data/sec"


def _post(path: str, body: dict) -> dict:
    r = httpx.post(f"{BASE}{path}", headers=HEADERS, json=body, timeout=180)
    if r.status_code >= 400:
        raise RuntimeError(f"agent memory {path} {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def ensure_scope(path: str) -> None:
    if path in _known_scopes:
        return
    parts = path.split("/")
    for i in range(2, len(parts) + 1):
        p = "/".join(parts[:i])
        if p in _known_scopes:
            continue
        r = httpx.post(f"{BASE}/scopes", headers=HEADERS, json={"path": p}, timeout=30)
        if r.status_code >= 400 and r.status_code != 409:
            raise RuntimeError(f"scope {p} {r.status_code}: {r.text[:200]}")
        _known_scopes.add(p)


def _ts(d: str) -> str:
    return f"{d}T12:00:00Z" if len(d) == 10 else d


def remember(text: str, scope: str, observed_at: str, infer: str = "full") -> dict:
    """Dated record for recall. observed_at = when the market learned it (needs infer=full)."""
    with tracer.start_as_current_span("memory.remember") as span:
        span.set_attribute("input.value", text)
        ensure_scope(scope)
        return _post("/facts", {"text": text, "infer": infer, "scopes": [[scope]], "observed_at": _ts(observed_at)})


def view_entity(author: str, metric: str) -> str:
    """One entity per (author, metric): a newer note supersedes only that author's view."""
    return f"{author} view: {metric}"


def remember_view(author: str, metric: str, fields: dict, observed_at: str) -> dict:
    with tracer.start_as_current_span("memory.remember_view") as span:
        scope = author_scope(author)
        ensure_scope(scope)
        entity = {"type": "concept", "name": view_entity(author, metric)}
        triples = [{"entity": entity, "key": k, "value": str(v)} for k, v in fields.items() if v is not None]
        span.set_attribute("input.value", f"{entity['name']}: {fields}")
        return _post("/facts", {"infer": "triples", "scopes": [[scope]], "triples": triples,
                                "observed_at": _ts(observed_at)})


def view_history(author: str, metric: str, key: str = "value_usd_bn") -> list:
    name = view_entity(author, metric)
    r = httpx.get(f"{BASE}/entities/concept/{name}/history/{key}", headers=HEADERS, timeout=30)
    return r.json().get("history", []) if r.status_code == 200 else []


def recall(query: str, as_of: str | None = None, scopes: list[str] | None = None, k: int = 20) -> dict:
    with tracer.start_as_current_span("memory.recall") as span:
        span.set_attribute("input.value", f"{query} | asOf={as_of} | lens={scopes}")
        body = {"query": query, "k": k}
        if as_of:
            body["asOf"] = f"{as_of}T23:59:59Z" if len(as_of) == 10 else as_of
        if scopes:
            body["lens"] = [[s] for s in scopes]
        out = _post("/query", body)
        span.set_attribute("output.value", f"tier={out.get('tier')} hits={len(out.get('hits', []))}")
        return out


def hits_as_text(result: dict) -> str:
    lines = []
    for i, h in enumerate(result.get("hits", []), 1):
        txt = h.get("text") or h.get("content") or h.get("snippet") or h.get("value") or str(h)[:300]
        when = h.get("occurredAt", "")
        lines.append(f"[M{i}] ({when[:10]}) {txt}")
    return "\n".join(lines)
