import { type FormEvent, useEffect, useRef, useState } from "react";
import { followLink, navigate } from "../router";
import { listSessions, phaseLabel, RUN_ID, type Session } from "./sessions";

// "www.daytona.io/pricing" rather than the full URL; the run id until the target is known.
export function sessionTitle(session: Pick<Session, "runId" | "target">) {
  if (!session.target) return `Run ${session.runId.slice(0, 8)}`;
  try {
    const url = new URL(session.target);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return session.target;
  }
}

// The saved example run; bare /workspace also shows it until a session is started.
export const EXAMPLE_PATH = "/workspace/example";

export function startNewSession() {
  // A fresh history key gives the new session its own empty workspace, even from /workspace.
  navigate("/workspace", { session: crypto.randomUUID() });
}

export function SessionSwitcher({
  current,
  example = false,
}: {
  current?: Pick<Session, "runId" | "target">;
  // Set while the saved example run is shown.
  example?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [runId, setRunId] = useState("");
  const root = useRef<HTMLDivElement>(null);

  // Read on open: another tab may have started a session since.
  useEffect(() => {
    if (open) setSessions(listSessions());
  }, [open]);

  // Clicking or focusing outside closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes it and hands focus back to the toggle.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>(".ss-toggle")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("focusin", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openRun = (event: FormEvent) => {
    event.preventDefault();
    const id = runId.trim();
    if (!RUN_ID.test(id)) return;
    setOpen(false);
    setRunId("");
    navigate(`/workspace/${id}`);
  };

  return (
    <div className="ss" ref={root}>
      <button
        type="button"
        className="ss-toggle"
        aria-expanded={open}
        aria-controls="ss-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="visually-hidden">Session: </span>
        <span className="ss-current">
          {example
            ? "Example run"
            : current
              ? sessionTitle(current)
              : "New session"}
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div id="ss-panel" className="ss-panel">
          <button
            type="button"
            className="button ss-new"
            onClick={() => {
              setOpen(false);
              startNewSession();
            }}
          >
            New session
          </button>
          <a
            className="ss-item ss-example"
            href={EXAMPLE_PATH}
            aria-current={example ? "page" : undefined}
            onClick={(event) => {
              setOpen(false);
              followLink(event);
            }}
          >
            <span className="ss-target">Example run</span>
            <span className="ss-phase">Saved, read-only</span>
          </a>
          {sessions.length > 0 ? (
            <ul className="ss-list" aria-label="Your sessions">
              {sessions.map((session) => (
                <li key={session.runId}>
                  <a
                    className="ss-item"
                    href={`/workspace/${session.runId}`}
                    aria-current={
                      session.runId === current?.runId ? "page" : undefined
                    }
                    onClick={(event) => {
                      setOpen(false);
                      followLink(event);
                    }}
                  >
                    <span className="ss-target">{sessionTitle(session)}</span>
                    <span className="ss-phase">
                      {session.phase ? phaseLabel(session.phase) : "Starting"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ss-empty">
              Sessions you start or open in this browser are listed here.
            </p>
          )}
          <form className="ss-open" onSubmit={openRun}>
            <label htmlFor="ss-run-id">Open a run by ID</label>
            <div>
              <input
                id="ss-run-id"
                value={runId}
                spellCheck={false}
                autoComplete="off"
                pattern="[\w\-]{1,100}"
                placeholder="Run ID from the API"
                onChange={(event) => setRunId(event.target.value)}
              />
              <button type="submit" className="button">
                Open
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
