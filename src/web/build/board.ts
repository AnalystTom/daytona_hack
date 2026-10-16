import { TaskDetail, type TaskReview } from "../../shared/build";
import { type EventEnvelope, TaskState } from "../../shared/contracts";

export const columns = [
  { id: "queued", label: "Queued" },
  { id: "building", label: "Building" },
  { id: "in_review", label: "In review" },
  { id: "merged", label: "Merged" },
] as const;
export type BoardColumn = (typeof columns)[number]["id"];

export type LogLine = {
  eventId: string;
  timestamp: string;
  message: string;
};

export type BoardTask = {
  id: string;
  title?: string;
  state?: TaskState;
  // Last column the task reached; failed and stopped tasks stay in it.
  column?: BoardColumn;
  reason?: string;
  nextAction?: string;
  previewUrl?: string;
  review?: TaskReview;
  log: LogLine[];
};

export type BoardState = {
  tasks: BoardTask[];
  runStopped: boolean;
};

// Detail arrives over the wire, so it is parsed here rather than trusted.
type IncomingEvent = EventEnvelope & { detail?: unknown };

const isColumn = (state: TaskState): state is BoardColumn =>
  state !== "failed" && state !== "stopped";

export function deriveBoard(events: readonly IncomingEvent[]): BoardState {
  const seen = new Set<string>();
  const unique = events.filter(
    (event) => !seen.has(event.eventId) && seen.add(event.eventId),
  );
  // Stable sort: events sharing a sequence keep their arrival order.
  const ordered = [...unique].sort((a, b) => a.sequence - b.sequence);

  const tasks = new Map<string, BoardTask>();
  let runStopped = false;

  for (const event of ordered) {
    if (!event.taskId) {
      if (event.state === "stopped") runStopped = true;
      continue;
    }
    let task = tasks.get(event.taskId);
    if (!task) {
      task = { id: event.taskId, log: [] };
      tasks.set(event.taskId, task);
    }
    // A stopped task is final: later events never move or reopen it.
    if (task.state === "stopped") continue;

    if (event.message) {
      task.log.push({
        eventId: event.eventId,
        timestamp: event.timestamp,
        message: event.message,
      });
    }

    const state = TaskState.safeParse(event.state);
    if (state.success) {
      task.state = state.data;
      if (isColumn(state.data)) {
        task.column = state.data;
        task.reason = undefined;
        task.nextAction = undefined;
      } else {
        task.column ??= "queued";
      }
    }

    const detail = TaskDetail.safeParse(event.detail);
    if (detail.success) {
      const { review, ...rest } = detail.data;
      Object.assign(task, rest);
      if (review) task.review = { ...task.review, ...review };
    }

    if (
      state.success &&
      !isColumn(state.data) &&
      !(detail.success && detail.data.reason) &&
      event.message
    ) {
      task.reason = event.message;
    }
  }

  return { tasks: [...tasks.values()], runStopped };
}
