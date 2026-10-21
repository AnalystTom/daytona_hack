import { z } from "zod";
import { EventEnvelope, EvidenceItem } from "./contracts";

// Evidence capture contracts (docs/orchestrator/spec.md section 6).

export const viewports = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export const CaptureScope = z.object({
  // Exact origin only, for example "https://example.com".
  origin: z
    .url({ protocol: /^https?$/ })
    .refine((value) => new URL(value).origin === value, {
      message: "origin must be scheme, host and port only",
    }),
  paths: z
    .array(
      z.string().regex(/^\/[^#]*$/, "paths start with / and have no fragment"),
    )
    .min(1)
    .max(10),
});
export type CaptureScope = z.infer<typeof CaptureScope>;

export const CaptureRequest = z.object({
  // Capture modes follow docs/orchestrator/api.md#evidence-capture.
  mode: z.enum(["first_look", "full_pack"]),
  scope: CaptureScope,
  // start: open an Anchor live session for the user to sign in themselves.
  // resume: capture inside that signed-in session.
  signIn: z.enum(["start", "resume"]).optional(),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

export const EvidenceRecord = EvidenceItem.extend({
  runId: z.string().min(1),
  // Requested page URL, not necessarily the final browser URL.
  url: z.string().min(1),
  contentType: z.string().min(1),
  byteLength: z.int().nonnegative(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

// The part of an event the capture decides; the run API adds the envelope fields.
export const CaptureEvent = EventEnvelope.pick({
  type: true,
  state: true,
  message: true,
  artifactRefs: true,
});
export type CaptureEvent = z.infer<typeof CaptureEvent>;

const normalisePath = (path: string) =>
  path.length > 1 ? path.replace(/\/+$/, "") : path;

export const redactQuery = (value: string) =>
  value.replace(/[?#][^\s"']*/g, "");

// Ends the reason on every item of a page that left the scope; the orchestrator offers sign-in on it.
export const leftScope = "outside the approved scope";

/** Why an item was not observed, in plain words, from its capture limitations. */
export function notObservedReason(limits: string): string {
  const moved = limits.match(/(?:Redirected|Page moved) to (\S+?),? outside/);
  if (moved)
    return `The site redirected to ${moved[1]}, outside the pages approved for this run; that is usually a sign-in page.`;
  const failed = limits.match(/Capture failed: (.*)/);
  if (failed) return `The capture service refused: ${failed[1]}`;
  return limits || "The capture returned no screenshot.";
}

// A scoped query must match exactly; queryless paths allow any query. Trailing slashes are equivalent.
export function inScope(url: string, scope: CaptureScope): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = normalisePath(parsed.pathname);
  return (
    parsed.origin === scope.origin &&
    scope.paths.some((approved) => {
      const pathname = approved.split("?")[0] ?? "";
      const query = approved.slice(pathname.length);
      return (
        normalisePath(pathname) === path && (!query || query === parsed.search)
      );
    })
  );
}
