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
sb.fs.upload_file((HERE / "reversy").read_bytes(), "/home/daytona/reversy")
sb.fs.upload_file((HERE / "ci.mjs").read_bytes(), "/home/daytona/ci.mjs")
sb.fs.upload_file((HERE / "preview.sh").read_bytes(), "/home/daytona/preview.sh")
sb.fs.upload_file((
    f"export REVERSY_GATEWAY_URL={os.environ['REVERSY_GATEWAY_URL']}\n"
    f"export REVERSY_GATEWAY_TOKEN={os.environ['GATEWAY_TOKEN']}\n"
    f"export RUN_ID={run_id}\n"
    "export PATH=$HOME/bin:$HOME/go/bin:$HOME/.local/bin:$PATH\n").encode(), "/home/daytona/.reversy.env")
sb.process.exec('install -m 755 $HOME/reversy $HOME/bin/reversy; grep -q reversy.env $HOME/.bashrc || echo \'. "$HOME/.reversy.env"\' >> $HOME/.bashrc')
env = f"RUN_ID={run_id} API_URL={os.getenv('REVERSY_API_URL', '')} BRIDGE_TOKEN={os.getenv('REVERSY_BRIDGE_TOKEN', '')}"
r = sb.process.exec(
    "pkill -f bridge.mjs; pkill -f ci.mjs; sleep 1; "
    "(setsid nohup node /home/daytona/ci.mjs > /home/daytona/ci.log 2>&1 &); "
    "pgrep -f preview.sh >/dev/null || (setsid nohup bash /home/daytona/preview.sh > /home/daytona/preview.log 2>&1 &); "
    f"(env {env} setsid nohup node /home/daytona/bridge.mjs > /home/daytona/bridge.log 2>&1 &); "
    "sleep 15; cat /home/daytona/bridge.log /home/daytona/ci.log", timeout=60)
print(r.result)
print("preview:", sb.get_preview_link(3000).url)
