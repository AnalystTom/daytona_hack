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
      z.string().regex(/^\/[^?#]*$/, "paths start with / and have no query"),
    )
    .min(1)
    .max(10),
});
export type CaptureScope = z.infer<typeof CaptureScope>;

export const CaptureRequest = z.object({
  // first_look: one desktop screenshot per path. full_pack: every kind Anchor can capture.
  mode: z.enum(["first_look", "full_pack"]),
  scope: CaptureScope,
  // start: open an Anchor live session for the user to sign in themselves.
  // resume: capture inside that signed-in session.
  signIn: z.enum(["start", "resume"]).optional(),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

export const EvidenceRecord = EvidenceItem.extend({
  runId: z.string().min(1),
  // The page URL the item was captured from (or attempted, when not observed).
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

// Only the approved origin and paths are in scope; a trailing slash is not a different page.
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
    scope.paths.some((approved) => normalisePath(approved) === path)
  );
}
