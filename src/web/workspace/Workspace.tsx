import { useEffect, useMemo, useRef, useState } from "react";
import type { SpecCanvas } from "../../shared/workspace";
import type { Override } from "../build/BuildBoard";
import { BuildView } from "./BuildView";
import { ChatPanel } from "./ChatPanel";
import { askForUrl, type ChatEntry, deliver, takeIncomingBrief } from "./chat";
import type { WorkspaceFixture } from "./fixtures";
import { Mark } from "./Mark";
import { chatEntries, type OrchestratorEvent, runView } from "./orchestrator";
import {
  fetchEvents,
  operatorToken,
  overrideVerdict,
  type RunCallError,
  type RunCallResult,
  runAction,
} from "./runClient";
import { SpecView } from "./SpecView";
import "./workspace.css";

type View = "spec" | "build";
const VIEWS: { id: View; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "build", label: "Build" },
];

const PHASES: Record<string, string> = {
  brief: "Agreeing the spec",
  inspecting: "Inspecting the site",
  planning: "Planning tasks",
  planned: "Plan ready",
  building: "Building",
  done: "Build finished",
  stopped: "Stopped",
  failed: "Run failed",
};
const POLL_MS = 2000;
// A finished run changes only when someone acts on it, so it is checked less often.
const IDLE_POLL_MS = 15000;
const idle = (phase?: string) =>
  phase === "done" || phase === "stopped" || phase === "failed";

export function Workspace({ fixture }: { fixture?: WorkspaceFixture }) {
  const [view, setView] = useState<View>("spec");
  const [entries, setEntries] = useState<ChatEntry[]>(fixture?.entries ?? []);
  const [pending, setPending] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [offline, setOffline] = useState(false);
  // Messages sent before the brief had a URL; they are sent with it.
  const briefParts = useRef<string[]>([]);
  const run = useMemo(() => runView(runId ?? "", events), [runId, events]);
  const phase = useRef(run.phase);
  phase.current = run.phase;
  const canvas: SpecCanvas = fixture?.canvas ?? {
    draftSpec: run.draftSpec,
    evidence: run.evidence,
  };
  const canBuild = runId !== undefined && run.phase === "planned";

  // Follows the run's events from the orchestrator.
  useEffect(() => {
    if (!runId) return;
    let since = 0;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await fetchEvents(runId, since);
      if (!live) return;
      setOffline(!result.ok);
      if (result.ok) {
        const fresh = result.value.filter((event) => event.seq > since);
        if (fresh.length > 0) {
          since = Math.max(...fresh.map((event) => event.seq));
          setEvents((list) => [...list, ...fresh]);
          setEntries((list) => [...list, ...chatEntries(fresh)]);
        }
      }
      timer = setTimeout(poll, idle(phase.current) ? IDLE_POLL_MS : POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runId]);

  const addNotice = (error: RunCallError, id: string = crypto.randomUUID()) =>
    setEntries((list) => [
      ...list,
      { kind: "notice", id, error: error.error, detail: error.detail },
    ]);

  const act = async (call: Promise<RunCallResult<unknown>>) => {
    const result = await call;
    if (!result.ok) addNotice(result);
  };

  const setDelivery = (id: string, delivery: "sent" | "failed") =>
    setEntries((list) =>
      list.map((e) =>
        e.kind === "user" && e.id === id ? { ...e, delivery } : e,
      ),
    );

  const send = async (id: string, text: string) => {
    setPending(true);
    const message =
      runId === undefined ? [...briefParts.current, text].join("\n") : text;
    const result = await deliver(runId, message);
    setPending(false);
    if (result.needsUrl) {
      briefParts.current.push(text);
      setDelivery(id, "sent");
      setEntries((list) => [
        ...list,
        { kind: "agent", id: `${id}-ask`, text: askForUrl },
      ]);
      return;
    }
    setDelivery(id, result.error ? "failed" : "sent");
    if (result.runId && runId === undefined) {
      briefParts.current = [];
      setRunId(result.runId);
    }
    const { error } = result;
    if (error) {
      addNotice(
        { ...error, detail: `${error.detail} Your message is kept here.` },
        `${id}-notice`,
      );
    }
  };

  const onSend = (text: string) => {
    const id = crypto.randomUUID();
    setEntries((list) => [
      ...list,
      { kind: "user", id, text, delivery: "sending" },
    ]);
    void send(id, text);
  };

  const onRetry = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (entry?.kind !== "user") return;
    setEntries((list) =>
      list
        .filter((e) => e.id !== `${id}-notice`)
        .map((e) => (e.id === id ? { ...entry, delivery: "sending" } : e)),
    );
    void send(id, entry.text);
  };

  // Saving the token resends the message it stopped, if any; a refused action is pressed again.
  const onSaveToken = (token: string, noticeId: string) => {
    operatorToken.set(token);
    const messageId = noticeId.replace(/-notice$/, "");
    if (messageId !== noticeId) return onRetry(messageId);
    setEntries((list) => list.filter((e) => e.id !== noticeId));
  };

  const onOverride = (override: Override) => {
    if (runId) void act(overrideVerdict(runId, override));
  };

  // A brief sent from /start arrives already in the chat. Runs once; StrictMode's second pass finds it taken.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useEffect(() => {
    const brief = fixture ? undefined : takeIncomingBrief(window.history);
    if (brief) onSend(brief);
  }, []);

  return (
    <div className="ws">
      {fixture && (
        <p className="fixture-banner" role="note">
          Fixture mode: sample data for design review, not a live result.
        </p>
      )}
      <div className="ws-main">
        <header className="ws-header">
          <a className="ws-brand" href="/">
            <Mark />
            <span>Reversy</span>
          </a>
          <nav className="ws-views" aria-label="Canvas view">
            {VIEWS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="ws-view"
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ws-run">
            {run.phase && (
              <span className="ws-phase" role="status">
                {PHASES[run.phase] ?? run.phase}
              </span>
            )}
            {run.previewUrl && (
              <a
                className="button"
                href={run.previewUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open preview
              </a>
            )}
            <button
              type="button"
              className="button button-primary"
              disabled={!canBuild}
              title={canBuild ? undefined : "Available once the plan is ready"}
              onClick={() => {
                setView("build");
                if (runId) void act(runAction(runId, "build"));
              }}
            >
              Start build
            </button>
          </div>
        </header>
        <main
          className="ws-canvas"
          aria-label={view === "spec" ? "Spec canvas" : "Build canvas"}
        >
          {view === "spec" ? (
            <SpecView canvas={canvas} />
          ) : (
            <BuildView
              draftSpec={canvas.draftSpec}
              events={run.board}
              onStopBuild={() => runId && void act(runAction(runId, "stop"))}
              onOverride={onOverride}
            />
          )}
        </main>
      </div>
      <ChatPanel
        entries={
          offline
            ? [...entries, { kind: "reconnecting", id: "offline" }]
            : entries
        }
        pending={pending}
        onSend={onSend}
        onRetry={onRetry}
        onSaveToken={onSaveToken}
      />
    </div>
  );
}
