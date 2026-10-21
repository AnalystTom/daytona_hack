"""Smoke-test every sponsor integration. Run: uv run scripts/check_setup.py [service ...]"""
import os
import sys

import truststore

truststore.inject_into_ssl()  # use macOS keychain certs (python.org builds ship without CA bundle)

import httpx
from dotenv import load_dotenv

load_dotenv()


def need(*names):
    missing = [n for n in names if not os.getenv(n)]
    if missing:
        raise RuntimeError(f"missing env: {', '.join(missing)}")


def check_openai():
    need("OPENAI_API_KEY")
    from openai import OpenAI

    r = OpenAI().responses.create(model=os.getenv("LLM_MODEL", "gpt-5.5"), input="Reply with: ok")
    return f"{r.model}: {r.output_text.strip()}"


def check_daytona():
    need("DAYTONA_API_KEY")
    from daytona import Daytona

    sandbox = Daytona().create()
    try:
        return sandbox.process.code_run('print("hello from daytona")').result.strip()
    finally:
        sandbox.delete()


def check_anchor():
    need("ANCHORBROWSER_API_KEY")
    headers = {"anchor-api-key": os.environ["ANCHORBROWSER_API_KEY"]}
    base = "https://api.anchorbrowser.io/v1"
    r = httpx.post(f"{base}/sessions", headers=headers, json={}, timeout=60)
    r.raise_for_status()
    data = r.json()["data"]
    httpx.delete(f"{base}/sessions/{data['id']}", headers=headers, timeout=30)
    return f"session ok, live view: {data.get('live_view_url')}"


def check_arize():
    need("ARIZE_API_KEY", "ARIZE_SPACE_ID")
    from arize.otel import register

    provider = register(
        space_id=os.environ["ARIZE_SPACE_ID"],
        api_key=os.environ["ARIZE_API_KEY"],
        project_name=os.getenv("ARIZE_DEFAULT_PROJECT", "daytona-hack"),
    )
    with provider.get_tracer("check_setup").start_as_current_span("setup-check") as span:
        span.set_attribute("input.value", "ping")
        span.set_attribute("output.value", "pong")
    provider.force_flush()
    return "span sent — look for 'setup-check' in AX"


def check_surreal():
    need("SPECTRON_URL", "SPECTRON_CONTEXT_ID", "SPECTRON_API_KEY")
    base = f"{os.environ['SPECTRON_URL'].rstrip('/')}/api/v1/{os.environ['SPECTRON_CONTEXT_ID']}"
    headers = {"Authorization": f"Bearer {os.environ['SPECTRON_API_KEY']}"}
    httpx.post(f"{base}/facts", headers=headers, json={"text": "The hackathon team is testing setup."}, timeout=60).raise_for_status()
    r = httpx.post(f"{base}/query", headers=headers, json={"query": "What is the team doing?"}, timeout=60)
    r.raise_for_status()
    return f"query ok (tier={r.json().get('tier')})"


def check_elevenlabs():
    need("ELEVENLABS_API_KEY")
    r = httpx.get("https://api.elevenlabs.io/v1/user", headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}, timeout=30)
    r.raise_for_status()
    return f"tier={r.json().get('subscription', {}).get('tier')}"


CHECKS = {
    "openai": check_openai,
    "daytona": check_daytona,
    "anchor": check_anchor,
    "arize": check_arize,
    "surreal": check_surreal,
    "elevenlabs": check_elevenlabs,
}

if __name__ == "__main__":
    selected = sys.argv[1:] or list(CHECKS)
    for name in selected:
        try:
            print(f"✅ {name}: {CHECKS[name]()}")
        except Exception as e:
            print(f"❌ {name}: {e}")
