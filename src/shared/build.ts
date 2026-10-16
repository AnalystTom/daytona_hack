import { z } from "zod";
import { EventEnvelope } from "./contracts";

// Links the board renders as href or src: absolute http(s) or a same-origin path, never javascript: or data:.
const Link = z.string().regex(/^(https?:\/\/|\/(?![/\\]))/);

const field = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

export const TaskReview = z.object({
  diffSummary: field(z.string().min(1)),
  diffUrl: field(Link),
  originalScreenshot: field(Link),
  rebuildScreenshot: field(Link),
  verdict: field(z.enum(["approved", "rejected"])),
  reason: field(z.string().min(1)),
});
export type TaskReview = z.infer<typeof TaskReview>;

// Facts a task event can carry beyond the envelope. Each is optional and shows on the board only once sent.
export const TaskDetail = z.object({
  title: field(z.string().min(1)),
  reason: field(z.string().min(1)),
  nextAction: field(z.string().min(1)),
  previewUrl: field(Link),
  review: field(TaskReview),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const BuildEvent = EventEnvelope.extend({
  detail: TaskDetail.optional(),
});
export type BuildEvent = z.infer<typeof BuildEvent>;
