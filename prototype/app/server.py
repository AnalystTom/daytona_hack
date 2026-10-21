"""FastAPI app: uv run uvicorn app.server:app --reload"""
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import memory, pipeline
from .voice import speak

app = FastAPI(title="Research Replay")
STATIC = Path(__file__).resolve().parent.parent / "static"
AUDIO = pipeline.STATE.parent / "brief.mp3"


class IngestReq(BaseModel):
    url: str
    date: str | None = None


class VerifyReq(BaseModel):
    url: str


class ChangesReq(BaseModel):
    base_url: str
    topic: str = "hyperscaler AI capex forecasts for 2026 and 2027"


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/state")
def state():
    return pipeline.load()


@app.post("/api/ingest")
def ingest(req: IngestReq):
    return pipeline.ingest(req.url, req.date)


@app.post("/api/verify")
def verify(req: VerifyReq):
    return pipeline.verify(req.url)


@app.post("/api/changes")
def changes(req: ChangesReq):
    AUDIO.unlink(missing_ok=True)
    return pipeline.changes(req.base_url, req.topic)


@app.get("/api/recall")
def recall(q: str, as_of: str | None = None):
    return memory.recall(q, as_of=as_of)


@app.get("/api/history")
def history(author: str, metric: str):
    return memory.view_history(author, metric)


@app.get("/api/brief.mp3")
def brief():
    if not AUDIO.exists():
        ch = pipeline.load().get("changes")
        if not ch:
            raise HTTPException(404, "run /api/changes first")
        AUDIO.write_bytes(speak(ch["report"]["briefing_script"]))
    return Response(AUDIO.read_bytes(), media_type="audio/mpeg")
