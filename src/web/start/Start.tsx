import { type FormEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Icon, type IconName } from "../landing/icons";
import { Logo } from "../landing/Landing";
import { navigate } from "../router";
import {
  addFiles,
  type Brief,
  canSend,
  initialBrief,
  keepBrief,
  type Starter,
  starters,
} from "./brief";
import "./start.css";

const starterButtons: { starter: Starter; icon: IconName; tone: string }[] = [
  { starter: starters.daytona, icon: "link", tone: "pistachio" },
  { starter: starters.interaction, icon: "click", tone: "persimmon" },
  { starter: starters.screenshots, icon: "image", tone: "aubergine" },
  { starter: starters.inspect, icon: "search", tone: "pistachio" },
];

export function Start() {
  const [brief, setBrief] = useState<Brief>(() =>
    initialBrief(window.history.state, window.location.search),
  );
  const [error, setError] = useState("");
  const sending = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function chooseStarter(starter: Starter) {
    flushSync(() => setBrief((b) => ({ ...b, text: starter.draft })));
    const text = textRef.current;
    text?.focus();
    text?.setSelectionRange(text.value.length, text.value.length);
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (sending.current || !canSend(brief)) return;
    sending.current = true;
    try {
      const kept = keepBrief(brief);
      // Kept on this entry as well, so Back from the workspace returns to the same draft.
      window.history.replaceState(kept, "");
      navigate("/workspace", { brief: brief.text, files: brief.files });
    } catch {
      sending.current = false;
      setError(
        "The brief did not reach the workspace. Your text and attachments are still here: send again.",
      );
    }
  }

  return (
    <div className="start">
      <header className="start-header">
        <Logo />
      </header>
      <main className="start-main">
        <img
          className="start-beaver"
          src="/beaver.png"
          alt=""
          width="606"
          height="499"
        />
        <h1>What would you like to make yours?</h1>
        <p className="start-lede">
          Share a website and a goal. We'll refine the rest in chat.
        </p>

        <form className="composer" onSubmit={send}>
          <label className="visually-hidden" htmlFor="brief">
            Your brief
          </label>
          <textarea
            id="brief"
            ref={textRef}
            value={brief.text}
            placeholder="Paste a URL and tell me what you want to rebuild…"
            rows={3}
            onChange={(e) => {
              setBrief((b) => ({ ...b, text: e.target.value }));
              setError("");
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {brief.files.length > 0 && (
            <ul className="attachments" aria-label="Attachments">
              {brief.files.map((file, index) => (
                <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                  <span>{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setBrief((b) => ({
                        ...b,
                        files: b.files.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="composer-actions">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,application/pdf"
              hidden
              onChange={(e) => {
                // Copy first: the FileList empties when the input is reset below.
                const picked = [...(e.currentTarget.files ?? [])];
                setBrief((b) => ({ ...b, files: addFiles(b.files, picked) }));
                e.currentTarget.value = "";
                setError("");
              }}
            />
            <button
              type="button"
              className="round-button attach"
              aria-label="Attach files"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="clip" />
            </button>
            <button
              type="submit"
              className="round-button send"
              aria-label="Send"
              disabled={!canSend(brief)}
            >
              <Icon name="send" />
            </button>
          </div>
        </form>
        {error && (
          <p className="start-error" role="alert">
            {error}
          </p>
        )}

        <section className="start-starters" aria-labelledby="starters-label">
          <h2 id="starters-label">Try a starter</h2>
          <ul>
            {starterButtons.map(({ starter, icon, tone }) => (
              <li key={starter.id}>
                <button type="button" onClick={() => chooseStarter(starter)}>
                  <span className={`tile tile-${tone}`}>
                    <Icon name={icon} />
                  </span>
                  <span>
                    <span className="starter-title">{starter.title}</span>
                    <span className="starter-hint">{starter.hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="start-note">
            Choose a starter or write your own brief.
          </p>
        </section>
      </main>
    </div>
  );
}
