import { Landing } from "./landing/Landing";
import { useHistorySession, usePath } from "./router";
import { Start } from "./start/Start";
import { ExampleWorkspace } from "./workspace/ExampleWorkspace";
import { specFixture } from "./workspace/fixtures";
import { Workspace } from "./workspace/Workspace";

// Bare /workspace starts a new session; examples have their own explicit route.
export function workspaceRoute(
  path: string,
): "example" | { runId?: string } | null {
  const match = path.match(/^\/workspace(?:\/([\w-]{1,100}))?\/?$/);
  if (!match) return null;
  const runId = match[1];
  if (runId === "example") return "example";
  return { runId };
}

export function App() {
  const path = usePath();
  const session = useHistorySession();
  if (path === "/") return <Landing />;
  if (path === "/start") return <Start />;
  const fixture =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("fixture") === "spec";
  const workspace = workspaceRoute(path);
  if (workspace === "example") return <ExampleWorkspace />;
  if (workspace) {
    const { runId } = workspace;
    // Each session mounts its own workspace. A new session keeps its key when its run is
    // created, so the URL can gain the run ID without starting over.
    return (
      <Workspace
        key={session ?? runId ?? "new"}
        runId={runId}
        fixture={fixture ? specFixture : undefined}
      />
    );
  }
  // Every other path is still the placeholder shell.
  return (
    <div className="shell">
      <header className="header">
        <h1 className="brand">Reversy</h1>
      </header>
      <main className="workspace">
        <section className="canvas" aria-label="Canvas" />
        <aside className="chat" aria-label="Chat" />
      </main>
    </div>
  );
}
