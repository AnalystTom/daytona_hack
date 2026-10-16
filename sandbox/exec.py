"""Run one shell command in a Daytona sandbox and print its output. Run: uv run sandbox/exec.py <sandbox_id> '<command>'"""
import sys
from pathlib import Path

import truststore

truststore.inject_into_ssl()
from daytona import Daytona  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
r = Daytona().get(sys.argv[1]).process.exec(
    "export PATH=$HOME/bin:$HOME/go/bin:$HOME/.local/bin:$PATH; " + sys.argv[2], timeout=600)
print(r.result)
sys.exit(r.exit_code or 0)
