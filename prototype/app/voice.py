"""Spoken PM briefing via ElevenLabs."""
import os

import httpx

from .config import tracer

VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")  # "George", a stock voice


def speak(text: str) -> bytes:
    with tracer.start_as_current_span("voice.briefing") as span:
        span.set_attribute("input.value", text)
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
            json={"text": text, "model_id": "eleven_multilingual_v2"},
            timeout=120,
        )
        r.raise_for_status()
        return r.content
