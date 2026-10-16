"""Create a fresh Daytona sandbox and run sandbox/bootstrap.sh in it. Prints the sandbox id.

Run: uv run sandbox/try_bootstrap.py [sandbox_id]   (reuse a sandbox by passing its id)
"""
import os
import sys
from pathlib import Path

import truststore

truststore.inject_into_ssl()
from daytona import CreateSandboxFromSnapshotParams, Daytona  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
d = Daytona()
if len(sys.argv) > 1:
    sb = d.get(sys.argv[1])
else:
    sb = d.create(CreateSandboxFromSnapshotParams(
        snapshot="daytona-medium", public=True, auto_stop_interval=120,
        labels={"app": "reversy", "role": "firstmate"},
        env_vars={"OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]},
    ), timeout=180)
print("sandbox", sb.id, flush=True)
sb.fs.upload_file((Path(__file__).parent / "bootstrap.sh").read_bytes(), "/home/daytona/bootstrap.sh")
r = sb.process.exec("bash /home/daytona/bootstrap.sh 2>&1 | tail -40", timeout=900)
print(r.result)
