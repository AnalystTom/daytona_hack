// REA scan (docs/orchestrator/spec.md §6): statically decomposes the shipped JavaScript bundles
// in one directory with the pinned REA CLI (versions.env) and prints compact findings as JSON:
// modules, routes, API calls and storage use, each with its file's SHA-256 and a source locator.
// REA's raw graph runs to megabytes, so only this projection leaves the sandbox. Bundles are
// parsed as inert text; nothing in them is executed. Any failure prints {"error": ...}.
//
// Usage: node rea-scan.mjs <dir> [timeoutSeconds]

import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Most useful first: when the cap cuts findings, API calls and routes survive.
const ORDER = ["api", "route", "endpoint", "storage", "module"];
export const MAX_FINDINGS = 60;

const locate = (loc) => {
  if (loc?.kind === "source-range" && loc.start)
    return `${loc.source}:${loc.start.line}:${loc.start.column}`;
  return loc?.path ?? loc?.source ?? "";
};

/** REA's analyze-javascript-application result, reduced to the findings planning uses. */
export function project(raw, max = MAX_FINDINGS) {
  const result = raw?.normalized_result;
  if (!result?.graph?.nodes)
    return { error: "REA returned no application graph" };
  const findings = [];
  for (const node of result.graph.nodes) {
    const o = node.observations?.[0];
    const p = o?.properties ?? {};
    let kind;
    let value;
    if (node.kind === "endpoint") {
      kind =
        p.endpoint_kind === "network"
          ? "api"
          : p.endpoint_kind === "route"
            ? "route"
            : "endpoint";
      value = p.value;
    } else if (node.kind === "storage") {
      kind = "storage";
      value = `${p.storage_kind} ${p.name}`;
    } else if (
      node.kind === "javascript-module" &&
      p.semantic_role === "source-module"
    ) {
      kind = "module";
      value = p.path;
    } else continue;
    const loc = o.evidence?.location?.available
      ? o.evidence.location.value
      : undefined;
    findings.push({
      kind,
      value: String(value ?? o.label ?? "").slice(0, 300),
      file: loc?.source ?? loc?.path ?? p.path ?? "",
      sha256: o.evidence?.artifact?.sha256 ?? "",
      locator: locate(loc),
      state: o.evidence?.state === "observed" ? "observed" : "inferred",
      ...(p.mechanism ? { mechanism: p.mechanism } : {}),
      ...(p.module_format ? { format: p.module_format } : {}),
      ...(p.export_names?.length
        ? { exports: p.export_names.slice(0, 20) }
        : {}),
    });
  }
  findings.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const coverage = result.graph.coverage;
  return {
    findings: findings.slice(0, max),
    omitted: Math.max(0, findings.length - max),
    truncated: Boolean(coverage?.truncated),
    statistics: result.statistics ?? {},
    limitations: [
      ...(result.limitations ?? []),
      ...(coverage?.limits ?? []),
    ].slice(0, 10),
  };
}

function scan(dir, seconds, work) {
  const out = join(work, "rea.json");
  const err = join(work, "rea.err");
  // REA stops each source at its own timeout and keeps partial evidence; the spawn timeout bounds the whole run.
  const r = spawnSync(
    "rea",
    [
      "analyze-javascript-application",
      dir,
      "--format",
      "json",
      "--analysis-timeout-ms",
      String(Math.max(1, seconds - 5) * 1000),
      "--max-heap-mb",
      "768",
    ],
    {
      stdio: ["ignore", openSync(out, "w"), openSync(err, "w")],
      timeout: seconds * 1000,
      killSignal: "SIGKILL",
    },
  );
  if (r.error?.code === "ETIMEDOUT")
    return { error: `REA did not finish within ${seconds}s` };
  if (r.error)
    return { error: `REA could not start: ${r.error.message}`.slice(0, 300) };
  if (r.status !== 0) {
    // REA prints its failure as JSON on stdout; stderr carries progress lines.
    let reason = readFileSync(err, "utf8").trim().split("\n").at(-1);
    try {
      const failure = JSON.parse(readFileSync(out, "utf8"));
      reason =
        failure.details?.issues?.[0]?.message ?? failure.message ?? reason;
    } catch {}
    return { error: `REA exited ${r.status}: ${reason}`.slice(0, 300) };
  }
  try {
    return project(JSON.parse(readFileSync(out, "utf8")));
  } catch (e) {
    return { error: `REA output unreadable: ${String(e)}`.slice(0, 300) };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, seconds = "120"] = process.argv.slice(2);
  const work = mkdtempSync(join(tmpdir(), "rea-scan-"));
  try {
    console.log(
      JSON.stringify(
        dir
          ? scan(dir, Number(seconds) || 120, work)
          : { error: "usage: rea-scan.mjs <dir> [timeoutSeconds]" },
      ),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
