import { z } from "zod";

// Run sandbox lifecycle contracts (docs/orchestrator/spec.md sections 3, 5 and 11).

// Captain input reaches Firstmate through an environment variable, which Linux caps at 128 KiB.
export const CaptainInput = z.object({
  kind: z.enum(["chat", "approved_spec"]),
  text: z.string().trim().min(1).max(30000),
  // Targets one variant pod of the run instead of the run sandbox.
  podId: z.string().min(1).optional(),
});
export type CaptainInput = z.infer<typeof CaptainInput>;

export const PodKind = z.enum(["fork", "copy"]);
export type PodKind = z.infer<typeof PodKind>;

export const CreatePodRequest = z.object({
  // Defaults to the run sandbox.
  fromSandboxId: z.string().min(1).optional(),
});
export type CreatePodRequest = z.infer<typeof CreatePodRequest>;

export const Pod = z.object({
  podId: z.string().min(1),
  kind: PodKind,
  parentSandboxId: z.string().min(1),
});
export type Pod = z.infer<typeof Pod>;

export const RunSandbox = z.object({
  runId: z.string().min(1),
  sandboxId: z.string().min(1),
  state: z.string(),
  // "running" while boot.sh runs, then "ready" or "failed" from its exit code.
  boot: z.enum(["running", "ready", "failed", "unknown"]),
  bootLog: z.string(),
  previewUrl: z.string().nullable(),
});
export type RunSandbox = z.infer<typeof RunSandbox>;

export const CleanupReport = z.object({
  runId: z.string().min(1),
  status: z.enum(["succeeded", "failed"]),
  removed: z.array(z.string()),
  failures: z.array(z.object({ id: z.string(), error: z.string() })),
});
export type CleanupReport = z.infer<typeof CleanupReport>;
