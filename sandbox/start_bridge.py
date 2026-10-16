"""Upload sandbox/bridge.mjs and (re)start it detached in the sandbox.

Run: uv run sandbox/start_bridge.py <sandbox_id> [run_id]
Reads API_URL and BRIDGE_TOKEN from .env (REVERSY_API_URL, REVERSY_BRIDGE_TOKEN) when present.
"""
import os
import sys
from pathlib import Path

import truststore

truststore.inject_into_ssl()
from daytona import Daytona  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
sb = Daytona().get(sys.argv[1])
run_id = sys.argv[2] if len(sys.argv) > 2 else "local"
sb.fs.upload_file((HERE / "bridge.mjs").read_bytes(), "/home/daytona/bridge.mjs")
env = f"RUN_ID={run_id} API_URL={os.getenv('REVERSY_API_URL', '')} BRIDGE_TOKEN={os.getenv('REVERSY_BRIDGE_TOKEN', '')}"
r = sb.process.exec(
    "pkill -f bridge.mjs; sleep 1; "
    f"(env {env} setsid nohup node /home/daytona/bridge.mjs > /home/daytona/bridge.log 2>&1 &); "
    "sleep 4; cat /home/daytona/bridge.log", timeout=60)
print(r.result)
