// Minimal CI for the rebuild repo on the local Gitea. Firstmate merges a Forgejo/Gitea PR only when the
// head's combined commit status is success, so every open PR head gets real static checks and a
// "reversy-ci/static" status: JS parses, HTML files are non-empty, and `npm test` passes when defined.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HOST = "http://localhost:3001";
const REPO = "reversy/rebuild";
const TOKEN = readFileSync(`${process.env.HOME}/.gitea-token`, "utf8").trim();
const WORK = `${process.env.HOME}/ci-repo`;
const CONTEXT = "reversy-ci/static";
const api = (path, init = {}) =>
  fetch(`${HOST}/api/v1${path}`, { ...init, headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" } });
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: WORK, stdio: "pipe", timeout: 300_000, ...opts }).toString();

function files(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === ".git" || f === "node_modules") continue;
    const p = join(dir, f);
    statSync(p).isDirectory() ? files(p, out) : out.push(p);
  }
  return out;
}

function check(sha) {
  sh(`git fetch -q origin ${sha} && git checkout -q --force ${sha} && git clean -qfdx`);
  const problems = [];
  const all = files(WORK);
  for (const f of all.filter((f) => /\.(m?js)$/.test(f))) {
    try { sh(`node --check ${JSON.stringify(f)}`); } catch (e) { problems.push(`${f.slice(WORK.length + 1)}: ${String(e.stderr).split("\n")[0]}`); }
  }
  for (const f of all.filter((f) => f.endsWith(".html"))) {
    if (!readFileSync(f, "utf8").trim()) problems.push(`${f.slice(WORK.length + 1)} is empty`);
  }
  const pkg = join(WORK, "package.json");
  let tested = false;
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) {
    tested = true;
    try { sh("npm install --no-audit --no-fund --silent && npm test --silent"); } catch (e) { problems.push(`npm test failed: ${String(e.stdout || e.stderr).slice(-300)}`); }
  }
  return { ok: problems.length === 0, summary: problems.length ? problems.slice(0, 3).join("; ") : `${all.length} files checked${tested ? ", npm test passed" : ""}` };
}

if (!existsSync(WORK)) execSync(`git clone -q ${HOST}/${REPO}.git ${WORK}`);
console.log("[ci] watching", REPO);
for (;;) {
  try {
    const prs = await (await api(`/repos/${REPO}/pulls?state=open&limit=50`)).json();
    for (const pr of prs) {
      const sha = pr.head.sha;
      const statuses = await (await api(`/repos/${REPO}/commits/${sha}/statuses`)).json();
      if (statuses.some((s) => s.context === CONTEXT && s.status !== "pending")) continue;
      await api(`/repos/${REPO}/statuses/${sha}`, { method: "POST", body: JSON.stringify({ state: "pending", context: CONTEXT, description: "running static checks" }) });
      const r = check(sha);
      await api(`/repos/${REPO}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({ state: r.ok ? "success" : "failure", context: CONTEXT, description: r.summary.slice(0, 250) }),
      });
      console.log(`[ci] PR #${pr.number} ${sha.slice(0, 8)} ${r.ok ? "success" : "failure"}: ${r.summary}`);
    }
  } catch (e) {
    console.error("[ci]", e.message);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
