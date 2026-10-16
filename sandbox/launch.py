"""Launch Reversy's agent system (Firstmate + Codex crew) in a Daytona sandbox and hand it the captain's brief.

Run:  uv run sandbox/launch.py [sandbox_id]
Without an id it creates a fresh sandbox and runs bootstrap.sh first. Prints the first mate's screen at the end.
"""
import os
import sys
import time
from pathlib import Path

import truststore

truststore.inject_into_ssl()
from daytona import CreateSandboxFromSnapshotParams, Daytona  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")

BRIEF = (
    "Ahoy. Project `rebuild` is registered (no-mistakes, forge=forgejo on the local Gitea, +yolo). "
    "Rebuild https://www.daytona.io/ as a static site in projects/rebuild, working only from the read-only evidence "
    "in /home/daytona/evidence (the original site is not reachable from this machine). "
    "Split it into ship tasks: first a foundation task (skeleton, design tokens, shared layout, one placeholder per "
    "section), then one task per landing-page section in parallel once the foundation merges. "
    "Dispatch them to Codex crewmates and merge approved work. Report each task's outcome."
)


def sh(sb, cmd: str, timeout: int = 600) -> str:
    r = sb.process.exec(cmd, timeout=timeout)
    return r.result


def main():
    d = Daytona()
    if len(sys.argv) > 1:
        sb = d.get(sys.argv[1])
    else:
        sb = d.create(CreateSandboxFromSnapshotParams(
            snapshot="daytona-medium", public=True, auto_stop_interval=120,
            labels={"app": "reversy", "role": "firstmate"},
            env_vars={"OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]},
        ), timeout=180)
        sb.fs.upload_file((HERE / "bootstrap.sh").read_bytes(), "/home/daytona/bootstrap.sh")
        print(sh(sb, "bash /home/daytona/bootstrap.sh 2>&1 | grep bootstrap", 900))
    print("sandbox", sb.id, flush=True)

    if "already" not in sh(sb, "test -f /home/daytona/evidence/index.json && echo already"):
        upload_evidence(sb)
    print(sh(sb, "export PATH=$HOME/go/bin:$PATH; test -x $HOME/go/bin/tea && tea pulls --help >/dev/null 2>&1 || "
                 "GOTOOLCHAIN=auto go install gitea.dev/tea@v0.16.0 2>&1 | tail -3; tea --version", 900))
    sb.fs.upload_file((HERE / "setup-run.sh").read_bytes(), "/home/daytona/setup-run.sh")
    print(sh(sb, "bash /home/daytona/setup-run.sh 2>&1 | tail -25"))
    print(sh(sb, "export PATH=$HOME/go/bin:$PATH; tea --version; tmux ls"))

    time.sleep(8)
    print("---- first mate screen before the brief ----")
    print(sh(sb, "tmux capture-pane -p -t fm | tail -25"))
    sh(sb, f"tmux send-keys -t fm -l {sh_quote(BRIEF)} && sleep 1 && tmux send-keys -t fm Enter")
    time.sleep(90)
    print("---- first mate screen 90 s after the brief ----")
    print(sh(sb, "tmux capture-pane -p -t fm | tail -40"))
    print(sh(sb, "tail -5 /home/daytona/firstmate/state/fleet-ledger.jsonl 2>/dev/null; ls /home/daytona/firstmate/state | head"))
    print("sandbox", sb.id)


def upload_evidence(sb, url: str = "https://www.daytona.io/"):
    """Capture the original with Anchor (outside the sandbox) and store it read-only for the crew."""
    import hashlib
    import json
    from datetime import datetime, timezone

    import httpx

    h = {"anchor-api-key": os.environ["ANCHORBROWSER_API_KEY"]}
    now = datetime.now(timezone.utc).isoformat()
    items = []
    for i, (name, w, hgt) in enumerate([("desktop", 1440, 900), ("mobile", 390, 844)], 1):
        png = httpx.post("https://api.anchorbrowser.io/v1/tools/screenshot", headers=h, timeout=180,
                         json={"url": url, "width": w, "height": hgt, "capture_full_height": True, "wait": 1500}).content
        eid = f"ev_{i:03d}"
        sb.fs.upload_file(png, f"/home/daytona/evidence/{eid}.png")
        items.append({"id": eid, "kind": "screenshot", "label": "observed", "pageOrState": "/", "tool": "anchor",
                      "capturedAt": now, "contentHash": hashlib.sha256(png).hexdigest()[:16],
                      "limitations": [f"{name} {w}px full height"], "path": f"/home/daytona/evidence/{eid}.png"})
    html = httpx.post("https://api.anchorbrowser.io/v1/tools/fetch/webpage", headers=h, timeout=180, json={"url": url}).content
    sb.fs.upload_file(html, "/home/daytona/evidence/ev_003.html")
    items.append({"id": "ev_003", "kind": "dom", "label": "observed", "pageOrState": "/", "tool": "anchor",
                  "capturedAt": now, "contentHash": hashlib.sha256(html).hexdigest()[:16],
                  "limitations": ["rendered HTML; scripts not executed offline"], "path": "/home/daytona/evidence/ev_003.html"})
    sb.fs.upload_file(json.dumps(items, indent=1).encode(), "/home/daytona/evidence/index.json")
    sb.process.exec("chmod -R a-w /home/daytona/evidence")
    print("evidence:", ", ".join(i["id"] for i in items), flush=True)


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    main()
