import { z } from "zod";
import { ReportDissection } from "../../shared/report";
import type { BuildEvent } from "../../shared/build";
import type { CanvasEvidence, DraftSpec } from "../../shared/workspace";
import type { ChatEntry } from "./chat";

// Translates the orchestrator's run events (docs/orchestrator/api.md) into what the workspace renders.
// Event data comes over the wire, so each payload is parsed and a malformed one is skipped.

export const OrchestratorEvent = z.object({
  seq: z.int().positive(),
  ts: z.string(),
  type: z.string(),
  data: z.unknown(),
});
export type OrchestratorEvent = z.infer<typeof OrchestratorEvent>;

const Chat = z.object({ role: z.string(), text: z.string() });
const ErrorData = z.object({ message: z.string() });
const Spec = z.object({
  url: z.string(),
  redirects: z.array(z.string()).optional(),
  pages: z.array(
    z.object({
      path: z.string(),
      confirmed: z.boolean(),
      notes: z.string().optional(),
    }),
  ),
  flows: z.array(
    z.object({
      name: z.string(),
      confirmed: z.boolean(),
      notes: z.string().optional(),
    }),
  ),
  openQuestions: z.array(z.string()),
  approved: z.boolean(),
});
const Evidence = z.object({
  id: z.string().min(1),
  page: z.string().min(1),
  kind: z.string(),
  tool: z.string().min(1),
  status: z.enum(["observed", "inferred", "not_observed"]),
  capturedAt: z.iso.datetime({ offset: true }),
  hash: z.string(),
  limits: z.string(),
  url: z.string().optional(),
});
const Task = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string(),
  attempts: z.number(),
  failure: z.string().optional(),
  nextAction: z.string().optional(),
});
const Plan = z.object({ tasks: z.array(Task) });
const Review = z.object({
  taskId: z.string().min(1),
  verdict: z.enum(["approve", "reject"]),
  reason: z.string(),
  findings: z.array(z.string()).optional(),
  diffStat: z.string().optional(),
});
// The sandbox is private: the event says a preview is served, and the app asks for a signed link.
const Preview = z.object({ mergedTask: z.string().optional() });
const Phase = z.object({ phase: z.string() });
const Verification = z.object({
  taskId: z.string().optional(),
  pass: z.boolean(),
  summary: z.string(),
});

const EVIDENCE_PATH = /^\/runs\/[\w-]+\/evidence\/[\w-]+$/;
const isWebLink = (url: string) => /^https?:\/\//.test(url);

export type RunView = {
  phase?: string;
  report?: ReportDissection;
  hasPreview: boolean;
  draftSpec?: DraftSpec;
  evidence: CanvasEvidence[];
  board: BuildEvent[];
};

// Chat lines for new events. The user's own messages are already in the chat, so they are
// skipped unless `withUser` is set (a session reopened from its link starts with an empty chat).
export function chatEntries(
  events: readonly OrchestratorEvent[],
  { withUser = false } = {},
): ChatEntry[] {
  return events.flatMap((event): ChatEntry[] => {
    const id = `run-${event.seq}`;
    if (event.type === "chat") {
      const chat = Chat.safeParse(event.data);
      if (!chat.success) return [];
      if (chat.data.role === "assistant") {
        return [{ kind: "agent", id, text: chat.data.text }];
      }
      return withUser && chat.data.role === "user"
        ? [{ kind: "user", id, text: chat.data.text, delivery: "sent" }]
        : [];
    }
    if (event.type === "error") {
      const error = ErrorData.safeParse(event.data);
      return error.success
        ? [
            {
              kind: "notice",
              id,
              error: "run_error",
              detail: error.data.message,
            },
          ]
        : [];
    }
    return [];
  });
}

// The spec canvas, kanban events, phase and preview after every event so far.
export function runView(
  runId: string,
  events: readonly OrchestratorEvent[],
): RunView {
  const view: RunView = { hasPreview: false, evidence: [], board: [] };
  const envelope = (
    event: OrchestratorEvent,
    fields: Pick<BuildEvent, "state" | "message"> &
      Partial<Pick<BuildEvent, "taskId" | "detail">>,
    suffix = "",
  ): BuildEvent => ({
    schemaVersion: 1,
    eventId: `${event.seq}${suffix}`,
    sequence: event.seq,
    runId,
    timestamp: event.ts,
    artifactRefs: [],
    type: event.type,
    ...fields,
  });

  for (const event of events) {
    const { data } = event;
    switch (event.type) {
      case "report": {
        const report = ReportDissection.safeParse(data);
        if (report.success) view.report = report.data;
        break;
      }
      case "spec": {
        const spec = Spec.safeParse(data);
        if (spec.success) view.draftSpec = draftSpec(spec.data);
        break;
      }
      case "evidence": {
        const item = Evidence.safeParse(data);
        if (!item.success) break;
        const e = item.data;
        // Only screenshots and recordings have a card; other evidence feeds the plan.
        const kind = e.kind === "recording" ? "recording" : "screenshot";
        // A screenshot that was not observed still gets a card saying why.
        const missing = e.status === "not_observed" && kind === "screenshot";
        if (e.kind !== kind) break;
        view.evidence = view.evidence.filter((x) => x.id !== e.id);
        if (!missing && !(e.url && EVIDENCE_PATH.test(e.url))) break;
        view.evidence.push({
          id: e.id,
          kind,
          label: e.status,
          pageOrState: e.page,
          tool: e.tool,
          capturedAt: e.capturedAt,
          contentHash: e.hash || "unknown",
          limitations: e.limits ? [e.limits] : [],
          src: missing ? undefined : `/api/v1${e.url}`,
        });
        break;
      }
      case "plan": {
        const plan = Plan.safeParse(data);
        if (!plan.success) break;
        for (const task of plan.data.tasks) {
          view.board.push(
            envelope(
              event,
              {
                taskId: task.id,
                state: task.status,
                message: "Planned",
                detail: { title: task.title || undefined },
              },
              `:${task.id}`,
            ),
          );
        }
        break;
      }
      case "task": {
        const task = Task.safeParse(data);
        if (!task.success) break;
        const t = task.data;
        view.board.push(
          envelope(event, {
            taskId: t.id,
            state: t.status,
            message: taskMessage(t),
            detail: {
              title: t.title || undefined,
              reason: t.failure || undefined,
              nextAction: t.nextAction || undefined,
            },
          }),
        );
        break;
      }
      case "review": {
        const review = Review.safeParse(data);
        if (!review.success) break;
        const r = review.data;
        const verdict = r.verdict === "approve" ? "approved" : "rejected";
        view.board.push(
          // "review" is not a task state, so the card stays in its column.
          envelope(event, {
            taskId: r.taskId,
            state: "review",
            message: `Review ${verdict}: ${r.reason}`,
            detail: {
              review: {
                verdict,
                reason: r.reason || undefined,
                diffSummary: r.diffStat || r.findings?.join("\n") || undefined,
              },
            },
          }),
        );
        break;
      }
      case "preview": {
        const preview = Preview.safeParse(data);
        if (!preview.success) break;
        view.hasPreview = true;
        if (preview.data.mergedTask) {
          view.board.push(
            envelope(event, {
              taskId: preview.data.mergedTask,
              state: "preview",
              message: "Preview updated with this task",
            }),
          );
        }
        break;
      }
      case "verification": {
        const check = Verification.safeParse(data);
        if (!check.success || !check.data.taskId) break;
        view.board.push(
          envelope(event, {
            taskId: check.data.taskId,
            state: "verification",
            message: `Verifier ${check.data.pass ? "passed" : "failed"}: ${check.data.summary}`,
          }),
        );
        break;
      }
      case "phase": {
        const phase = Phase.safeParse(data);
        if (!phase.success) break;
        view.phase = phase.data.phase;
        // A run-level "stopped" state marks the whole build stopped on the board.
        view.board.push(
          envelope(event, { state: phase.data.phase, message: "" }),
        );
        break;
      }
    }
  }
  return view;
}

function draftSpec(spec: z.infer<typeof Spec>): DraftSpec {
  const item = (label: string, confirmed: boolean, notes?: string) =>
    `${label}${notes ? `: ${notes}` : ""}${confirmed ? "" : " (not confirmed yet)"}`;
  const pagesAndFlows = [
    ...spec.pages.map((p) => item(p.path, p.confirmed, p.notes)),
    ...spec.flows.map((f) => item(f.name, f.confirmed, f.notes)),
  ];
  return {
    url: isWebLink(spec.url) ? spec.url : undefined,
    redirectedFrom:
      spec.redirects?.[0] && isWebLink(spec.redirects[0])
        ? spec.redirects[0]
        : undefined,
    pagesAndFlows: pagesAndFlows.length ? pagesAndFlows : undefined,
    openQuestions: spec.openQuestions.length ? spec.openQuestions : undefined,
    status: spec.approved ? "approved" : "draft",
  };
}

function taskMessage(task: z.infer<typeof Task>): string {
  switch (task.status) {
    case "building":
      return `Worker started (attempt ${task.attempts})`;
    case "in_review":
      return "Worker finished; reviewing the diff";
    case "merged":
      return "Merged into the rebuild";
    case "failed":
      return task.failure || "Failed";
    case "stopped":
      return "Stopped";
    default:
      return task.nextAction || "Queued";
  }
}
