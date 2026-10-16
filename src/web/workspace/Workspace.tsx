import { useEffect, useRef, useState } from "react";
import type { SpecCanvas } from "../../shared/workspace";
import { BuildView } from "./BuildView";
import { ChatPanel } from "./ChatPanel";
import { type ChatEntry, deliver, takeIncomingBrief } from "./chat";
import type { WorkspaceFixture } from "./fixtures";
import { Mark } from "./Mark";
import { SpecView } from "./SpecView";
import "./workspace.css";

type View = "spec" | "build";
const VIEWS: { id: View; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "build", label: "Build" },
];

export function Workspace({ fixture }: { fixture?: WorkspaceFixture }) {
  const [view, setView] = useState<View>("spec");
  // Filled by run events once the run API streams them; empty until then.
  const [canvas] = useState<SpecCanvas>(fixture?.canvas ?? { evidence: [] });
  const [entries, setEntries] = useState<ChatEntry[]>(fixture?.entries ?? []);
  const [pending, setPending] = useState(false);
  const runId = useRef<string | undefined>(undefined);
  const approved = canvas.draftSpec?.status === "approved";

  const setDelivery = (id: string, delivery: "sent" | "failed") =>
    setEntries((list) =>
      list.map((e) =>
        e.kind === "user" && e.id === id ? { ...e, delivery } : e,
      ),
    );

  const send = async (id: string, text: string) => {
    setPending(true);
    const result = await deliver(runId.current, text);
    runId.current = result.runId;
    setPending(false);
    setDelivery(id, result.error ? "failed" : "sent");
    const { error } = result;
    if (error) {
      setEntries((list) => [
        ...list,
        {
          kind: "notice",
          id: `${id}-notice`,
          error: error.error,
          detail: `${error.detail} Your message is kept here.`,
        },
      ]);
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
          <button
            type="button"
            className="button button-primary ws-start"
            disabled={!approved || pending}
            title={approved ? undefined : "Needs an approved spec"}
            onClick={() => {
              setView("build");
              setEntries((list) => [
                ...list,
                {
                  kind: "notice",
                  id: crypto.randomUUID(),
                  error: "not_connected",
                  detail: "Starting a build is not available yet.",
                },
              ]);
            }}
          >
            Start build
          </button>
        </header>
        <main
          className="ws-canvas"
          aria-label={view === "spec" ? "Spec canvas" : "Build canvas"}
        >
          {view === "spec" ? (
            <SpecView canvas={canvas} />
          ) : (
            <BuildView draftSpec={canvas.draftSpec} />
          )}
        </main>
      </div>
      <ChatPanel
        entries={entries}
        pending={pending}
        onSend={onSend}
        onRetry={onRetry}
      />
    </div>
  );
}
