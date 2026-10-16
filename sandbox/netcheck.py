"""Create a throwaway sandbox, test egress to the hosts Reversy needs, delete it. Run: uv run sandbox/netcheck.py"""
from pathlib import Path

import truststore

truststore.inject_into_ssl()
from daytona import CreateSandboxFromSnapshotParams, Daytona  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
d = Daytona()
sb = d.create(CreateSandboxFromSnapshotParams(snapshot="daytona-medium"), timeout=180)
try:
    hosts = ["https://www.daytona.io", "https://api.anchorbrowser.io", "https://srv1.spectron.aws-usw2.surreal.cloud/api/v1/health",
             "https://codeberg.org", "https://otlp.arize.com"]
    cmd = "; ".join(f'printf "%s " {h}; curl -s -o /dev/null -m 8 -w "%{{http_code}}\\n" {h} || echo BLOCKED' for h in hosts)
    print(sb.process.exec(cmd, timeout=90).result)
finally:
    sb.delete()
