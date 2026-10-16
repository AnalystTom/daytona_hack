import { followLink } from "../router";
import type { StarterId } from "../start/brief";
import { starters } from "../start/brief";
import { Icon, type IconName } from "./icons";
import "./landing.css";

export function Logo() {
  return (
    <a className="logo" href="/" onClick={followLink}>
      <img src="/beaver-head.png" alt="" width="128" height="128" />
      Reversy
    </a>
  );
}

function StartLink({ className }: { className: string }) {
  return (
    <a className={className} href="/start" onClick={followLink}>
      Start a project
    </a>
  );
}

const steps: { icon: IconName; tone: string; title: string; body: string }[] = [
  {
    icon: "link",
    tone: "pistachio",
    title: "Refine the brief",
    body: "Share a URL and a goal. Shape the scope in chat.",
  },
  {
    icon: "image",
    tone: "persimmon",
    title: "Inspect the evidence",
    body: "Keep target screenshots, recordings, and findings beside the spec.",
  },
  {
    icon: "check",
    tone: "aubergine",
    title: "Build and review",
    body: "Follow tasks and inspect the evidence behind each review.",
  },
];

const starterLinks: { id: StarterId; icon: IconName; tone: string }[] = [
  { id: "landing-page", icon: "link", tone: "pistachio" },
  { id: "interaction", icon: "click", tone: "persimmon" },
  { id: "screenshots", icon: "image", tone: "aubergine" },
];

export function Landing() {
  return (
    <div className="landing">
      <header className="site-header">
        <Logo />
        <nav className="site-nav" aria-label="Main">
          <a href="#how-it-works">How it works</a>
          <a href="#workspace">Workspace</a>
          <StartLink className="btn" />
        </nav>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <h1>
              Take it apart.
              <br />
              Make it yours.
            </h1>
            <p className="lede">
              Turn a website into a clear spec, captured evidence, and a build
              you can review.
            </p>
            <div className="hero-actions">
              <StartLink className="btn btn-large" />
              <a className="text-link" href="#how-it-works">
                See how it works <Icon name="arrow" />
              </a>
            </div>
          </div>
          <img
            className="hero-beaver"
            src="/beaver.png"
            alt="The Reversy beaver in safety goggles cutting a browser window apart with a chainsaw"
            width="606"
            height="499"
          />
        </section>

        <section id="how-it-works" className="band" aria-labelledby="how-title">
          <h2 id="how-title">From a brief to a build</h2>
          <ol className="steps">
            {steps.map((step) => (
              <li key={step.title}>
                <span className={`tile tile-${step.tone}`}>
                  <Icon name={step.icon} />
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="workspace" className="band" aria-labelledby="view-title">
          <h2 id="view-title">Keep the work in view.</h2>
          <p className="band-lede">
            Chat on the right. Spec, evidence, and tasks on one canvas.
          </p>
          <figure className="preview-figure">
            <WorkspacePreview />
            <figcaption>Workspace concept</figcaption>
          </figure>
        </section>

        <section className="band" aria-labelledby="starters-title">
          <h2 id="starters-title">Start with something specific</h2>
          <ul className="starter-links">
            {starterLinks.map(({ id, icon, tone }) => (
              <li key={id}>
                <a href={`/start?starter=${id}`} onClick={followLink}>
                  <span className={`tile tile-${tone}`}>
                    <Icon name={icon} />
                  </span>
                  <span className="starter-title">{starters[id].title}</span>
                  <Icon name="arrow" />
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">What would you like to make yours?</h2>
          <StartLink className="btn btn-large" />
        </section>
      </main>

      <footer className="site-footer">
        <Logo />
        <p>Take it apart. Make it yours.</p>
      </footer>
    </div>
  );
}

// A static drawing of the workspace, not live data: the figure caption labels it a concept.
function WorkspacePreview() {
  return (
    <div
      className="preview"
      role="img"
      aria-label="Concept of the Reversy workspace: a draft spec, a target screenshot and video evidence on a canvas, with the chat on the right"
    >
      <div className="pv-canvas">
        <div className="pv-bar">
          <span className="pv-brand">
            <img src="/beaver-head.png" alt="" />
            Reversy
          </span>
          <span className="pv-tab pv-tab-active">Spec</span>
          <span className="pv-tab">Build</span>
          <span className="pv-ghost">Start build</span>
        </div>
        <div className="pv-cards">
          <div className="pv-card pv-spec">
            <p className="pv-card-title">Draft spec</p>
            <p className="pv-url">https://www.daytona.io/</p>
            <p className="pv-muted">Scope still being refined in chat.</p>
            <hr />
            <p className="pv-label">Pages and flows</p>
            <p className="pv-muted">Not confirmed yet.</p>
            <hr />
            <p className="pv-label">Open questions</p>
            <p className="pv-muted">Not confirmed yet.</p>
          </div>
          <div className="pv-stack">
            <div className="pv-card">
              <p className="pv-small-title">Target screenshot</p>
              <div className="pv-shot">
                <span className="pv-shot-nav" />
                <span className="pv-shot-head" />
                <span className="pv-shot-line" />
                <span className="pv-shot-line pv-short" />
                <span className="pv-shot-code" />
                <span className="pv-shot-logos" />
              </div>
            </div>
            <div className="pv-card pv-video">
              <p className="pv-small-title">Video evidence</p>
              <p className="pv-muted">No recording yet.</p>
            </div>
          </div>
        </div>
      </div>
      <div className="pv-chat">
        <p className="pv-chat-title">Chat</p>
        <p className="pv-bubble pv-user">
          https://www.daytona.io/ copy this site
        </p>
        <p className="pv-bubble pv-agent">
          <img src="/beaver-head.png" alt="" />
          Which pages and interactions should we include?
        </p>
        <p className="pv-hint">
          Refine the scope here. The spec updates on the canvas.
        </p>
        <p className="pv-composer">
          Describe a change…
          <span className="pv-send" />
        </p>
      </div>
    </div>
  );
}
