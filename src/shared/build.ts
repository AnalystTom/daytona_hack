import { z } from "zod";
import { EventEnvelope } from "./contracts";

// Links the board renders as href or src: absolute http(s) or a same-origin path, never javascript: or data:.
const Link = z.string().regex(/^(https?:\/\/|\/(?![/\\]))/);

export const TaskReview = z.object({
  diffSummary: z.string().min(1).optional(),
  diffUrl: Link.optional(),
  originalScreenshot: Link.optional(),
  rebuildScreenshot: Link.optional(),
  verdict: z.enum(["approved", "rejected"]).optional(),
  reason: z.string().min(1).optional(),
});
export type TaskReview = z.infer<typeof TaskReview>;

// Facts a task event can carry beyond the envelope. Each is optional and shows on the board only once sent.
export const TaskDetail = z.object({
  title: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  nextAction: z.string().min(1).optional(),
  previewUrl: Link.optional(),
  review: TaskReview.optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const BuildEvent = EventEnvelope.extend({
  detail: TaskDetail.optional(),
});
export type BuildEvent = z.infer<typeof BuildEvent>;
