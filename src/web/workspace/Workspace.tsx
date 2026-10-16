import { useEffect, useMemo, useRef, useState } from "react";
import type { SpecCanvas } from "../../shared/workspace";
import type { Override } from "../build/BuildBoard";
import { navigate } from "../router";
import { BuildView } from "./BuildView";
import { Canvas } from "./Canvas";
import { ChatPanel } from "./ChatPanel";
import {
  askForUrl,
  type ChatEntry,
  deliver,
  parseBrief,
  takeIncomingBrief,
} from "./chat";
import type { WorkspaceFixture } from "./fixtures";
import { Mark } from "./Mark";
import { chatEntries, type OrchestratorEvent, runView } from "./orchestrator";
import { PreviewView } from "./PreviewView";
import {
  fetchEvents,
  overrideVerdict,
  type RunCallError,
  type RunCallResult,
  runAction,
  signIn,
  startSignIn,
} from "./runClient";
import { SessionSwitcher } from "./SessionSwitcher";
import { SpecView } from "./SpecView";
import {
  type Layout,
  loadLayout,
  phaseLabel,
  rememberSession,
  saveLayout,
} from "./sessions";
import "./workspace.css";

type View = "spec" | "build" | "preview";
const VIEWS: { id: View; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "build", label: "Build" },
  { id: "preview", label: "Preview" },
];

const POLL_MS = 2000;
// A finished run changes only when someone acts on it, so it is checked less often.
const IDLE_POLL_MS = 15000;
const EVENTS_TOKEN_NOTICE = "events-token";

const idle = (phase?: string) =>
  phase === "done" || phase === "stopped" || phase === "failed";
// Phases with work under way, shown on the Build view until tasks exist.
const WORKING = ["inspecting", "planning", "planned", "building"];

// One session's workspace: `runId` reopens that run's session, none starts an empty one.
export function Workspace({
  fixture,
  runId: routeRunId,
}: {
  fixture?: WorkspaceFixture;
  runId?: string;
}) {
  const [view, setView] = useState<View>("spec");
  const [entries, setEntries] = useState<ChatEntry[]>(fixture?.entries ?? []);
  const [pending, setPending] = useState(false);
  // The run this session opened with; the URL gains a run ID later when a new session creates one.
  const [initialRunId] = useState(routeRunId);
  const [runId, setRunId] = useState(routeRunId);
  const [confirmed, setConfirmed] = useState(false);
  // The brief's URL, until the run's own spec names the target.
  const [briefTarget, setBriefTarget] = useState<string>();
  const [layout, setLayout] = useState<Layout>(() =>
    initialRunId ? loadLayout(initialRunId) : {},
  );
  const layoutChanged = useRef(false);
  // A run created after the user has switched sessions must not take over that session's URL.
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode runs this twice in development, so the mount sets it again.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [offline, setOffline] = useState(false);
  // Set from the Start build click until the next event, so a second click cannot race the phase change.
  const [starting, setStarting] = useState(false);
  const pollSoon = useRef<() => void>(undefined);
  // Messages sent before the brief had a URL; they are sent with it.
  const briefParts = useRef<string[]>([]);
  const run = useMemo(() => runView(runId ?? "", events), [runId, events]);
  const phase = useRef(run.phase);
  phase.current = run.phase;
  const canvas: SpecCanvas = fixture?.canvas ?? {
    draftSpec: run.draftSpec,
    evidence: run.evidence,
  };
  const canBuild = runId !== undefined && run.phase === "planned" && !starting;
  const signingIn = runId !== undefined && run.phase === "awaiting_sign_in";
  const target = run.draftSpec?.url ?? briefTarget;

  // Lists this run among the browser's sessions, with its latest target and phase.
  useEffect(() => {
    if (runId && confirmed && !fixture)
      rememberSession({ runId, target, phase: run.phase });
  }, [runId, confirmed, target, run.phase, fixture]);

  // Card positions are kept per session once there is a run to keep them under.
  useEffect(() => {
    if (runId && layoutChanged.current) saveLayout(runId, layout);
  }, [runId, layout]);

  const onLayout = (update: (layout: Layout) => Layout) => {
    layoutChanged.current = true;
    setLayout(update);
  };

  // Follows the run's events from the orchestrator.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialRunId never changes
  useEffect(() => {
    if (!runId) return;
    let since = 0;
    let live = true;
    // A reopened session has no chat yet, so its first batch brings the user's messages too.
    let withUser = runId === initialRunId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const poll = async () => {
      busy = true;
      const result = await fetchEvents(runId, since);
      busy = false;
      if (!live) return;
      if (!result.ok && result.error === "not_found") {
        setOffline(false);
        setEntries((list) => [
          ...list,
          {
            kind: "notice",
            id: "events-not-found",
            error: result.error,
            detail: `${result.detail} Check the run ID or start a new session.`,
          },
        ]);
        return;
      }
      setOffline(
        !result.ok &&
          !["operator_token", "access_required"].includes(result.error),
      );
      if (
        !result.ok &&
        ["operator_token", "access_required"].includes(result.error)
      ) {
        const { error, detail } = result;
        setEntries((list) =>
          list.some((e) => e.id === EVENTS_TOKEN_NOTICE)
            ? list
            : [
                ...list,
                { kind: "notice", id: EVENTS_TOKEN_NOTICE, error, detail },
              ],
        );
      }
      if (result.ok) {
        setConfirmed(true);
        const fresh = result.value.filter((event) => event.seq > since);
        if (fresh.length > 0) {
          since = Math.max(...fresh.map((event) => event.seq));
          setEvents((list) => [...list, ...fresh]);
          setStarting(false);
          const lines = chatEntries(fresh, { withUser });
          withUser = false;
          setEntries((list) => [...list, ...lines]);
        }
      }
      timer = setTimeout(poll, idle(phase.current) ? IDLE_POLL_MS : POLL_MS);
    };
    // An action can restart a finished run, so it skips the idle wait.
    pollSoon.current = () => {
      if (busy) return;
      clearTimeout(timer);
      void poll();
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
    if (result.ok) pollSoon.current?.();
    else {
      setStarting(false);
      addNotice(result);
    }
  };

  // The tab opens within the click so it is not blocked as a pop-up, and gets no handle on this page.
  const openSignIn = async () => {
    if (!runId) return;
    const tab = window.open("", "_blank");
    if (!tab) {
      addNotice({
        ok: false,
        error: "failed",
        detail: "Allow pop-ups for this site, then open secure sign-in again.",
      });
      return;
    }
    tab.opener = null;
    const result = await startSignIn(runId);
    if (result.ok) tab.location.href = result.value;
    else {
      tab.close();
      addNotice(result);
    }
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
      const briefUrl = parseBrief(message)?.url;
      setRunId(result.runId);
      setConfirmed(true);
      setBriefTarget(briefUrl);
      // Recorded here too: the user may have switched sessions while the run was being created.
      if (!fixture) rememberSession({ runId: result.runId, target: briefUrl });
      // The run's ID goes in the URL so a refresh or a shared link reopens this session.
      const state = window.history.state;
      if (mounted.current)
        navigate(
          `/workspace/${result.runId}`,
          { ...state, session: state?.session ?? "new" },
          { replace: true },
        );
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

  // Signing in resends the message the notice stopped, if any; a refused action is pressed again.
  const onSaveToken = async (token: string, noticeId: string) => {
    const result = await signIn(token);
    if (!result.ok) {
      const { error, detail } = result;
      setEntries((list) =>
        list.map((e) =>
          e.id === noticeId && e.kind === "notice"
            ? { ...e, error, detail }
            : e,
        ),
      );
      return;
    }
    const messageId = noticeId.replace(/-notice$/, "");
    if (messageId !== noticeId) return onRetry(messageId);
    setEntries((list) => list.filter((e) => e.id !== noticeId));
    pollSoon.current?.();
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
          {!fixture && (
            <SessionSwitcher current={runId ? { runId, target } : undefined} />
          )}
          <nav className="ws-views" aria-label="Canvas view">
            {VIEWS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="ws-view"
                aria-pressed={view === id}
                disabled={id === "preview" && !run.hasPreview}
                title={
                  id === "preview" && !run.hasPreview
                    ? "Available once the build serves a preview"
                    : undefined
                }
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ws-run">
            {run.phase && (
              <span className="ws-phase" role="status">
                {phaseLabel(run.phase)}
              </span>
            )}
            {signingIn && runId && (
              <>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void openSignIn()}
                >
                  Open secure sign-in
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => void act(runAction(runId, "sign-in/resume"))}
                >
                  Resume capture
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => void act(runAction(runId, "sign-in/skip"))}
                >
                  Skip sign-in
                </button>
              </>
            )}
            <button
              type="button"
              className="button button-primary"
              disabled={!canBuild}
              title={canBuild ? undefined : "Available once the plan is ready"}
              onClick={() => {
                setView("build");
                setStarting(true);
                if (runId) void act(runAction(runId, "build"));
              }}
            >
              Start build
            </button>
          </div>
        </header>
        <main
          className="ws-canvas"
          aria-label={`${VIEWS.find((v) => v.id === view)?.label} canvas`}
        >
          {view === "preview" && runId ? (
            // The preview's iframe stays outside the canvas so it is never panned or zoomed.
            <PreviewView runId={runId} onRefused={(e) => addNotice(e)} />
          ) : (
            <Canvas key={view} layout={layout} onLayout={onLayout}>
              {view === "spec" ? (
                <SpecView canvas={canvas} />
              ) : (
                <BuildView
                  draftSpec={canvas.draftSpec}
                  events={run.board}
                  status={
                    run.phase && WORKING.includes(run.phase)
                      ? phaseLabel(run.phase)
                      : undefined
                  }
                  onStopBuild={() =>
                    runId && void act(runAction(runId, "stop"))
                  }
                  onOverride={onOverride}
                />
              )}
            </Canvas>
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
