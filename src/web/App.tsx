import { Landing } from "./landing/Landing";
import { usePath } from "./router";
import { Start } from "./start/Start";
import { specFixture } from "./workspace/fixtures";
import { Workspace } from "./workspace/Workspace";

export function App() {
  const path = usePath();
  if (path === "/") return <Landing />;
  if (path === "/start") return <Start />;
  if (path.replace(/\/$/, "") === "/workspace") {
    const fixture =
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get("fixture") === "spec";
    return <Workspace fixture={fixture ? specFixture : undefined} />;
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
