"""Smoke test: Codex (gpt-6.1-sol) writes a file inside a throwaway Daytona sandbox.

Codex's own sandbox can't start inside the Daytona container, so the Daytona sandbox is the
isolation boundary. Run: uv run scripts/codex_smoke.py
"""
import os

import truststore

truststore.inject_into_ssl()
from daytona import CreateSandboxFromSnapshotParams, Daytona  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv()

sb = Daytona().create(CreateSandboxFromSnapshotParams(env_vars={"OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]}))
try:
    cmd = (
        "printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; "
        "mkdir -p /home/daytona/w && cd /home/daytona/w && git init -q && "
        "timeout 240 codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "
        "-m gpt-6.1-sol -c model_reasoning_effort=high "
        "'Create index.html with an h1 saying Hello Reversy. Nothing else.' 2>&1 | tail -8; "
        "echo '--- index.html:'; cat index.html"
    )
    print(sb.process.exec(cmd, timeout=300).result[-3000:])
finally:
    sb.delete()
