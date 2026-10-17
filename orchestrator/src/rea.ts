// REA code evidence: turns sandbox/rea-scan.mjs output into evidence items. Each finding keeps
// its bundle's SHA-256 and a source locator; static findings never prove runtime behaviour.
import { redactQuery } from "../../src/shared/evidence";
import type { Evidence } from "./types";

export interface ReaFinding {
  kind: "api" | "route" | "endpoint" | "storage" | "module";
  value: string;
  file: string;
  sha256: string;
  locator: string;
  state: "observed" | "inferred";
  mechanism?: string;
  format?: string;
  exports?: string[];
}

export type ReaScan =
  | {
      findings: ReaFinding[];
      omitted: number;
      truncated: boolean;
      limitations: string[];
    }
  | { error: string };

const LABELS: Record<ReaFinding["kind"], string> = {
  api: "API call",
  route: "Route",
  endpoint: "Endpoint",
  storage: "Storage",
  module: "Module",
};

// What REA's static reading never shows, whatever it found.
const STATIC_LIMITS =
  "static analysis of shipped bundles: calls and routes found in code were not executed or observed at runtime";

type Fields = Omit<Evidence, "id" | "page" | "capturedAt">;

/** One not_observed item: REA did not run, so code-level structure is unknown. */
export const reaNotObserved = (reason: string, bundles: number): Fields => ({
  kind: "code",
  tool: "rea",
  status: "not_observed",
  hash: "",
  limits: reason.slice(0, 300),
  summary: `REA analysis of ${bundles} script bundles not run`,
});

/**
 * Evidence fields for one scan; `files` maps the scanned file names to the bundle URLs they came from.
 * A failed or unreadable scan becomes one not_observed item with the reason.
 */
export function reaEvidence(
  scan: unknown,
  files: Record<string, string>,
): Fields[] {
  const bundles = Object.keys(files).length;
  if (!scan || typeof scan !== "object")
    return [reaNotObserved("REA returned no result", bundles)];
  if ("error" in scan)
    return [reaNotObserved(`REA failed: ${String(scan.error)}`, bundles)];
  const { findings, omitted, truncated, limitations } = scan as Extract<
    ReaScan,
    { findings: unknown }
  >;
  if (!Array.isArray(findings))
    return [reaNotObserved("REA returned no findings list", bundles)];
  const scanLimits = [
    STATIC_LIMITS,
    ...(truncated ? ["REA coverage was truncated"] : []),
    ...(omitted > 0 ? [`${omitted} further findings omitted`] : []),
    ...(Array.isArray(limitations) ? limitations.slice(0, 3) : []),
  ].join("; ");
  if (!findings.length)
    return [
      {
        kind: "code",
        tool: "rea",
        status: "not_observed",
        hash: "",
        limits: scanLimits,
        summary: `REA found no modules, routes or API calls in ${bundles} script bundles`,
      },
    ];
  return findings.map((f) => {
    const source = files[f.file] && redactQuery(files[f.file]);
    const detail = [
      f.mechanism && `via ${f.mechanism}`,
      f.format,
      f.exports?.length && `exports ${f.exports.join(", ")}`,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      kind: "code",
      tool: "rea",
      status: f.state === "observed" ? "observed" : "inferred",
      hash: f.sha256,
      locator: f.locator,
      limits: scanLimits,
      summary:
        `${LABELS[f.kind] ?? "Finding"} ${f.value}${detail ? ` (${detail})` : ""} in ${source ?? f.file}`.slice(
          0,
          400,
        ),
    };
  });
}
