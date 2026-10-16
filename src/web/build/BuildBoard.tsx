import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { EventEnvelope, TaskState } from "../../shared/contracts";
import { type BoardTask, canOverride, columns, deriveBoard } from "./board";
import "./BuildBoard.css";

export type Override = {
  taskId: string;
  verdict: "approve" | "reject";
  reason: string;
};

type Props = {
  events: readonly (EventEnvelope & { detail?: unknown })[];
  onStopBuild: () => void;
  onOverride?: (override: Override) => void;
};

const stateLabels: Record<TaskState, string> = {
  queued: "Queued",
  building: "Building",
  in_review: "In review",
  merged: "Merged",
  failed: "Failed",
  stopped: "Stopped",
};

// Small glyphs so status never relies on colour alone.
const stateIcons: Record<TaskState, ReactNode> = {
  queued: <circle cx="8" cy="8" r="5" fill="none" strokeWidth="1.75" />,
  building: (
    <path
      d="M2.5 11 5 6l2.5 5L10 6l2.5 5"
      fill="none"
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
  ),
  in_review: (
    <>
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"
        fill="none"
        strokeWidth="1.5"
      />
      <circle cx="8" cy="8" r="1.75" strokeWidth="0" />
    </>
  ),
  merged: (
    <path
      d="m3 8.5 3 3 7-7"
      fill="none"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
  ),
  failed: (
    <path
      d="m4 4 8 8m0-8-8 8"
      fill="none"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
  ),
  stopped: <rect x="4" y="4" width="8" height="8" rx="1.5" strokeWidth="0" />,
};

function StateIcon({ state }: { state: TaskState }) {
  return (
    <svg
      className="bb-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      {stateIcons[state]}
    </svg>
  );
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function BuildBoard({ events, onStopBuild, onOverride }: Props) {
  const board = useMemo(() => deriveBoard(events), [events]);
  const [selectedId, setSelectedId] = useState<string>();

  const placed = board.tasks.filter((task) => task.column && task.state);
  const selected = placed.find((task) => task.id === selectedId);
  const started = placed.length > 0;

  function close() {
    const id = selectedId;
    setSelectedId(undefined);
    if (id) document.getElementById(cardId(id))?.focus();
  }

  return (
    <section className="bb" aria-labelledby="bb-title">
      <header className="bb-head">
        <h2 id="bb-title" className="bb-title">
          Build and review
        </h2>
        <button
          type="button"
          className="bb-stop"
          disabled={!started || board.runStopped}
          onClick={onStopBuild}
        >
          {board.runStopped ? "Build stopped" : "Stop build"}
        </button>
      </header>

      <div className="bb-columns">
        {columns.map((column) => {
          const tasks = placed.filter((task) => task.column === column.id);
          return (
            <section
              key={column.id}
              className="bb-column"
              data-column={column.id}
              aria-labelledby={`bb-col-${column.id}`}
            >
              <h3 id={`bb-col-${column.id}`} className="bb-column-title">
                <StateIcon state={column.id} />
                {column.label}
                {started && <span className="bb-count">{tasks.length}</span>}
              </h3>
              <ul className="bb-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      selected={task.id === selectedId}
                      onSelect={() =>
                        setSelectedId(
                          task.id === selectedId ? undefined : task.id,
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {!started && (
          <div className="bb-empty">
            <p className="bb-empty-title">No build started.</p>
            <p>Tasks appear after the spec is approved.</p>
          </div>
        )}
      </div>

      {selected && (
        <TaskPanel
          key={selected.id}
          task={selected}
          onClose={close}
          onOverride={onOverride}
        />
      )}
    </section>
  );
}

const cardId = (taskId: string) => `bb-card-${taskId}`;

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: BoardTask;
  selected: boolean;
  onSelect: () => void;
}) {
  // biome-ignore lint/style/noNonNullAssertion: only placed tasks (with a state) are rendered
  const state = task.state!;
  const halted = state === "failed" || state === "stopped";
  return (
    <button
      type="button"
      id={cardId(task.id)}
      className="bb-card"
      data-state={state}
      aria-expanded={selected}
      aria-controls={selected ? "bb-panel" : undefined}
      onClick={onSelect}
    >
      <span className="bb-card-title">{task.title ?? task.id}</span>
      {halted && (
        <>
          <span className="bb-status" data-state={state}>
            <StateIcon state={state} />
            {stateLabels[state]}
          </span>
          {task.reason && <span className="bb-reason">{task.reason}</span>}
          <span className="bb-next">
            {task.nextAction ?? "Reply in chat to decide what happens next."}
          </span>
        </>
      )}
      {!halted && task.review?.verdict && (
        <span className="bb-status" data-verdict={task.review.verdict}>
          {task.review.verdict === "approved" ? "Approved" : "Rejected"}
        </span>
      )}
      {!halted && task.review?.verdict === "rejected" && (
        <>
          {task.review.reason && (
            <span className="bb-reason">{task.review.reason}</span>
          )}
          <span className="bb-next">
            {task.nextAction ?? "Reply in chat to decide what happens next."}
          </span>
        </>
      )}
    </button>
  );
}

function TaskPanel({
  task,
  onClose,
  onOverride,
}: {
  task: BoardTask;
  onClose: () => void;
  onOverride?: (override: Override) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus into the panel when it opens, so keyboard users land on the task they chose.
  useEffect(() => heading.current?.focus(), []);

  // biome-ignore lint/style/noNonNullAssertion: only placed tasks (with a state) are selectable
  const state = task.state!;
  const review = task.review;
  const hasShots = review?.originalScreenshot || review?.rebuildScreenshot;
  const hasReview =
    review &&
    (review.diffSummary || review.diffUrl || hasShots || review.verdict);
  const empty = task.log.length === 0 && !task.previewUrl && !hasReview;

  return (
    <section
      id="bb-panel"
      className="bb-panel"
      aria-labelledby="bb-panel-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="bb-panel-head">
        <div>
          <h3
            id="bb-panel-title"
            className="bb-panel-title"
            ref={heading}
            tabIndex={-1}
          >
            {task.title ?? task.id}
          </h3>
          <span className="bb-status" data-state={state}>
            <StateIcon state={state} />
            {stateLabels[state]}
          </span>
        </div>
        <button type="button" className="bb-close" onClick={onClose}>
          Close
        </button>
      </header>

      {(state === "failed" || state === "stopped") && (
        <p className="bb-panel-reason">
          {task.reason && <>{task.reason} </>}
          {task.nextAction ?? "Reply in chat to decide what happens next."}
        </p>
      )}

      {task.previewUrl && (
        <p>
          <a href={task.previewUrl} target="_blank" rel="noreferrer">
            Open preview
          </a>
        </p>
      )}

      {hasReview && (
        <div className="bb-review">
          <h4>Review</h4>
          {review.verdict && (
            <p className="bb-verdict" data-verdict={review.verdict}>
              <strong>
                {review.verdict === "approved" ? "Approved." : "Rejected."}
              </strong>
              {review.reason && <> {review.reason}</>}
            </p>
          )}
          {review.verdict === "rejected" &&
            state !== "failed" &&
            state !== "stopped" && (
              <p className="bb-next">
                {task.nextAction ??
                  "Reply in chat to decide what happens next."}
              </p>
            )}
          {review.diffSummary && (
            <p className="bb-diff">{review.diffSummary}</p>
          )}
          {review.diffUrl && (
            <p>
              <a href={review.diffUrl} target="_blank" rel="noreferrer">
                View diff
              </a>
            </p>
          )}
          {hasShots && (
            <div className="bb-shots">
              {review.originalScreenshot && (
                <figure>
                  <img
                    src={review.originalScreenshot}
                    alt={`Original site for ${task.title ?? task.id}`}
                    loading="lazy"
                  />
                  <figcaption>Original</figcaption>
                </figure>
              )}
              {review.rebuildScreenshot && (
                <figure>
                  <img
                    src={review.rebuildScreenshot}
                    alt={`Rebuild for ${task.title ?? task.id}`}
                    loading="lazy"
                  />
                  <figcaption>Rebuild</figcaption>
                </figure>
              )}
            </div>
          )}
        </div>
      )}

      {onOverride && canOverride(task) && (
        <OverrideForm
          onOverride={(verdict, reason) =>
            onOverride({ taskId: task.id, verdict, reason })
          }
        />
      )}

      {task.log.length > 0 && (
        <div className="bb-log-wrap">
          <h4>Log</h4>
          <ol className="bb-log">
            {task.log.map((line) => (
              <li key={line.eventId}>
                <time dateTime={line.timestamp}>
                  {timeFormat.format(new Date(line.timestamp))}
                </time>
                {line.message}
              </li>
            ))}
          </ol>
        </div>
      )}

      {empty && <p className="bb-muted">Nothing recorded for this task yet.</p>}
    </section>
  );
}

// Lets the user overrule the reviewer: merge the work as it is, or send it back for another build.
function OverrideForm({
  onOverride,
}: {
  onOverride: (verdict: Override["verdict"], reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form className="bb-override" onSubmit={(event) => event.preventDefault()}>
      <h4>Override the review</h4>
      <label htmlFor="bb-override-reason">Reason (optional)</label>
      <input
        id="bb-override-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="bb-override-actions">
        <button
          type="button"
          className="bb-button"
          onClick={() => onOverride("approve", reason.trim())}
        >
          Approve and merge
        </button>
        <button
          type="button"
          className="bb-button"
          onClick={() => onOverride("reject", reason.trim())}
        >
          Send back to build
        </button>
      </div>
    </form>
  );
}
