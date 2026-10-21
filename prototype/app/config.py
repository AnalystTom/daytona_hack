"""Shared setup: env, TLS trust store, Arize tracing, OpenAI client."""
import truststore

truststore.inject_into_ssl()  # python.org builds ship without a CA bundle

import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

MODEL = os.getenv("LLM_MODEL", "gpt-5.5")
ORG = os.getenv("MEMORY_ORG", "org/replay")  # bump for a clean demo run

tracer_provider = None
if os.getenv("ARIZE_API_KEY") and os.getenv("ARIZE_SPACE_ID"):
    from arize.otel import register
    from openinference.instrumentation.openai import OpenAIInstrumentor

    tracer_provider = register(
        space_id=os.environ["ARIZE_SPACE_ID"],
        api_key=os.environ["ARIZE_API_KEY"],
        project_name=os.getenv("ARIZE_DEFAULT_PROJECT", "daytona-hack"),
        log_to_console=False,
    )
    OpenAIInstrumentor().instrument(tracer_provider=tracer_provider)

from opentelemetry import trace  # noqa: E402

tracer = trace.get_tracer("research-replay")
llm = OpenAI()


def slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")
