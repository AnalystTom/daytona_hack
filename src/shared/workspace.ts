import { z } from "zod";
import { ReportDissection } from "./report";
import { EvidenceItem } from "./contracts";

// What the workspace canvas renders in the Spec view. Fields stay absent until agreed in chat.

export const DraftSpec = z.object({
  url: z.url({ protocol: /^https?$/ }).optional(),
  // The URL the user entered, when it redirected to `url`.
  redirectedFrom: z.url({ protocol: /^https?$/ }).optional(),
  pagesAndFlows: z.array(z.string().min(1)).optional(),
  openQuestions: z.array(z.string().min(1)).optional(),
  status: z.enum(["draft", "approved"]),
});
export type DraftSpec = z.infer<typeof DraftSpec>;

// An evidence item plus where the browser can load its captured file from (none when not observed).
// Code evidence has no file: it carries what was found and where in the bundle.
export const CanvasEvidence = EvidenceItem.extend({
  src: z.string().min(1).optional(),
  summary: z.string().optional(),
  locator: z.string().optional(),
});
export type CanvasEvidence = z.infer<typeof CanvasEvidence>;

export const SpecCanvas = z.object({
  draftSpec: DraftSpec.optional(),
  report: ReportDissection.optional(),
  evidence: z.array(CanvasEvidence),
});
export type SpecCanvas = z.infer<typeof SpecCanvas>;
