import { specFixture } from "./workspace/fixtures";
import { Workspace } from "./workspace/Workspace";

// Placeholder shell: the real workspace (Spec and Build views, kanban, chat) is a later task.
export function App() {
  if (window.location.pathname.replace(/\/$/, "") === "/workspace") {
    const fixture =
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get("fixture") === "spec";
    return <Workspace fixture={fixture ? specFixture : undefined} />;
  }
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
