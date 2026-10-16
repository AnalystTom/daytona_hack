import { useEffect, useMemo, useState } from "react";
import { BuildView } from "./BuildView";
import { Canvas } from "./Canvas";
import { ChatPanel } from "./ChatPanel";
import { type Example, exampleView, fetchExample } from "./example";
import { Mark } from "./Mark";
import type { RunCallResult } from "./runClient";
import {
  SessionSwitcher,
  sessionTitle,
  startNewSession,
} from "./SessionSwitcher";
import { SpecView } from "./SpecView";
import { type Layout, phaseLabel } from "./sessions";
import "./workspace.css";

type View = "spec" | "build" | "preview";
const VIEWS: { id: View; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "build", label: "Build" },
  { id: "preview", label: "Preview" },
];

export const exampleDate = (iso: string) =>
  `${new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;

const noop = () => {};

const StartOwn = () => (
  <button
    type="button"
    className="button button-primary"
    onClick={startNewSession}
  >
    Start your own
  </button>
);

// Loads the saved example run, then replays it read-only.
export function ExampleWorkspace() {
  const [example, setExample] = useState<RunCallResult<Example>>();

  useEffect(() => {
    let live = true;
    void fetchExample().then((result) => live && setExample(result));
    return () => {
      live = false;
    };
  }, []);

  if (!example?.ok) {
    return (
      <div className="ws ws-example">
        <div className="ws-main">
          <main className="ws-canvas" aria-label="Example run">
            <div className="empty-state">
              <h2>{example ? "Example unavailable" : "Loading the example"}</h2>
              <p>
                {example && !example.ok
                  ? example.detail
                  : "Opening a saved run of Reversy."}
              </p>
              {example && <StartOwn />}
            </div>
          </main>
        </div>
      </div>
    );
  }

  return <ExampleRun example={example.value} />;
}

// One saved run, read-only: nothing here reaches the run or spends anything.
export function ExampleRun({ example }: { example: Example }) {
  const [view, setView] = useState<View>("spec");
  // Cards can be moved around, but the layout is not kept.
  const [layout, setLayout] = useState<Layout>({});
  const { run, entries, outcome } = useMemo(
    () => exampleView(example),
    [example],
  );
  const target = sessionTitle(example);
  const screenshots = run.evidence.filter((e) => e.kind === "screenshot");

  return (
    <div className="ws ws-example">
      <div className="example-banner" role="note">
        <p>
          <strong>
            Example run: {target}, captured {exampleDate(example.finishedAt)},
            run {example.runId.slice(0, 8)}.
          </strong>{" "}
          A saved, read-only copy of a finished run, not a live session. Tasks:{" "}
          {outcome}.
        </p>
        <StartOwn />
      </div>
      <div className="ws-main">
        <header className="ws-header">
          <a className="ws-brand" href="/">
            <Mark />
            <span>Reversy</span>
          </a>
          <SessionSwitcher example />
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
            <span className="ws-phase" role="status">
              {phaseLabel(example.phase)}
            </span>
          </div>
        </header>
        <main
          className="ws-canvas"
          aria-label={`${VIEWS.find((v) => v.id === view)?.label} canvas`}
        >
          {view === "preview" ? (
            <section
              className="example-preview"
              aria-label="Captured screenshots"
            >
              <p className="muted">
                The live preview is not kept in the example. These screenshots
                were captured from {target} during the run; they show the target
                site, not the rebuild.
              </p>
              {screenshots.map((shot) => (
                <figure key={shot.id}>
                  <img
                    src={shot.src}
                    alt={`${target}${shot.pageOrState}, captured ${exampleDate(shot.capturedAt)}`}
                    loading="lazy"
                  />
                  <figcaption className="muted">
                    {shot.pageOrState}: {shot.limitations.join(" ")}
                  </figcaption>
                </figure>
              ))}
            </section>
          ) : (
            <Canvas
              key={view}
              layout={layout}
              onLayout={(update) => setLayout(update)}
            >
              {view === "spec" ? (
                <SpecView
                  canvas={{ draftSpec: run.draftSpec, evidence: run.evidence }}
                />
              ) : (
                <BuildView draftSpec={run.draftSpec} events={run.board} />
              )}
            </Canvas>
          )}
        </main>
      </div>
      <ChatPanel
        entries={entries}
        pending={false}
        onSend={noop}
        onRetry={noop}
        onSaveToken={noop}
        readOnly={
          <p className="composer-hint">
            This example is read-only. Start your own session to send a brief.
          </p>
        }
      />
    </div>
  );
}
