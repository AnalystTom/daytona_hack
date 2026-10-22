import { z } from "zod";
import { EvidenceItem } from "./contracts";

// Verifier contracts (docs/orchestrator/spec.md section 9): what the Worker sends to the
// verifier and the verdict it gets back.

export const verifyKinds = ["plan", "task", "final"] as const;
export const VerifyKind = z.enum(verifyKinds);
export type VerifyKind = z.infer<typeof VerifyKind>;

const Id = z.string().min(1);

export const PlanItem = z.object({
  id: Id,
  title: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  evidenceIds: z.array(Id),
  // A feature with no evidence must be marked as a deliberate change (spec section 6).
  deliberateChange: z.boolean().default(false),
});
export type PlanItem = z.infer<typeof PlanItem>;

// Screenshots travel inline because evidence files live in private R2, not at public URLs.
export const Screenshot = z.object({
  evidenceId: Id,
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.base64().min(1),
});
export type Screenshot = z.infer<typeof Screenshot>;

export const VerifyTask = z.object({
  id: Id,
  title: z.string().min(1),
  planItemIds: z.array(Id).min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  evidenceIds: z.array(Id),
  rebuildEvidenceIds: z.array(Id).min(1),
});
export type VerifyTask = z.infer<typeof VerifyTask>;

const common = {
  spec: z.string().min(1),
  evidence: z.array(EvidenceItem),
  findings: z.string().default(""),
  screenshots: z.array(Screenshot).default([]),
  plan: z.array(PlanItem).min(1),
};

export const VerifyRequest = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("plan"), ...common }),
    z.object({ kind: z.literal("task"), ...common, task: VerifyTask }),
    z.object({
      kind: z.literal("final"),
      ...common,
      rebuildEvidenceIds: z.array(Id).min(1),
    }),
  ])
  .superRefine((request, ctx) => {
    const known = new Set(request.evidence.map((item) => item.id));
    const planIds = new Set(request.plan.map((item) => item.id));
    const check = (
      ids: string[],
      allowed: Set<string>,
      path: (string | number)[],
      what: string,
    ) =>
      ids.forEach((id, index) => {
        if (!allowed.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, index],
            message: `Unknown ${what} ${id}`,
          });
        }
      });
    request.screenshots.forEach((shot, index) => {
      if (!known.has(shot.evidenceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["screenshots", index, "evidenceId"],
          message: `Screenshot cites unknown evidence ID ${shot.evidenceId}`,
        });
      }
    });
    // Plan items citing unknown evidence stay valid: that gap is for the verifier to report.
    if (request.kind === "task") {
      check(
        request.task.planItemIds,
        planIds,
        ["task", "planItemIds"],
        "plan item",
      );
      check(
        request.task.evidenceIds,
        known,
        ["task", "evidenceIds"],
        "evidence ID",
      );
      check(
        request.task.rebuildEvidenceIds,
        known,
        ["task", "rebuildEvidenceIds"],
        "evidence ID",
      );
    }
    if (request.kind === "final") {
      check(
        request.rebuildEvidenceIds,
        known,
        ["rebuildEvidenceIds"],
        "evidence ID",
      );
    }
  });
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const VerifierFinding = z.object({
  // Null when the finding is about something missing from the plan altogether.
  planItemId: Id.nullable(),
  evidenceIds: z.array(Id),
  message: z.string().min(1),
});
export type VerifierFinding = z.infer<typeof VerifierFinding>;

// The model's structured output.
export const VerifierVerdict = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string().min(1),
  findings: z.array(VerifierFinding),
});
export type VerifierVerdict = z.infer<typeof VerifierVerdict>;

export const VerifyResponse = VerifierVerdict.extend({
  runId: Id,
  kind: VerifyKind,
  model: z.string().min(1),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;
