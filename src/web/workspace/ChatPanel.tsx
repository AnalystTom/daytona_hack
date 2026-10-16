import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatEntry } from "./chat";
import { Mark } from "./Mark";

const NOTICE_TITLE = {
  not_connected: "Not connected",
  operator_token: "Operator token needed",
  not_found: "Not found",
  failed: "Request failed",
  run_error: "Run error",
} as const;

type Handlers = {
  pending: boolean;
  onRetry: (id: string) => void;
  onSend: (text: string) => void;
  onSaveToken: (token: string, noticeId: string) => void;
};

function Entry({
  entry,
  pending,
  onRetry,
  onSend,
  onSaveToken,
}: Handlers & { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <li className="msg msg-user">
          <p className="bubble">{entry.text}</p>
          {entry.delivery === "sending" && <p className="msg-meta">Sending…</p>}
          {entry.delivery === "failed" && (
            <p className="msg-meta msg-meta-failed">
              Not delivered.{" "}
              <button
                type="button"
                className="link-button"
                disabled={pending}
                onClick={() => onRetry(entry.id)}
              >
                Try again
              </button>
            </p>
          )}
        </li>
      );
    case "agent":
      return (
        <li className="msg msg-agent">
          <Mark size={28} />
          <p className="bubble">{entry.text}</p>
        </li>
      );
    case "notice":
      return (
        <li className={`notice notice-${entry.error}`} role="status">
          <StatusIcon />
          <div>
            <p>
              <strong>{NOTICE_TITLE[entry.error]}.</strong> {entry.detail}
            </p>
            {entry.error === "operator_token" && (
              <TokenForm onSave={(token) => onSaveToken(token, entry.id)} />
            )}
          </div>
        </li>
      );
    case "reconnecting":
      return (
        <li className="notice notice-reconnecting" role="status">
          <StatusIcon />
          <p>
            <strong>Reconnecting.</strong> Updates resume when the run is
            reachable again.
          </p>
        </li>
      );
    case "sign_in":
      return (
        <li className="notice notice-sign-in" role="status">
          <StatusIcon />
          <div>
            <p>
              <strong>{entry.page} needs an account.</strong> Sign in yourself
              in a secure browser session, or skip this page.
            </p>
            <div className="notice-actions">
              {/* The sign-in link comes from the run API; only https links are followed. */}
              {entry.signInUrl.startsWith("https://") && (
                <a
                  className="button button-primary"
                  href={entry.signInUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open secure sign-in
                </a>
              )}
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() => onSend(`Skip ${entry.page}`)}
              >
                Skip this page
              </button>
            </div>
          </div>
        </li>
      );
  }
}

export function ChatPanel({
  entries,
  pending,
  onSend,
  onRetry,
  onSaveToken,
  readOnly,
}: Handlers & {
  entries: ChatEntry[];
  // Shown instead of the composer when the chat cannot be written to.
  readOnly?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const isBrief = entries.length === 0;
  const canSend = draft.trim() !== "" && !pending;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever a new entry lands
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      submit(event);
    }
  };

  return (
    <aside className="ws-chat" aria-labelledby="chat-title">
      <h2 id="chat-title" className="chat-title">
        Chat
      </h2>
      {isBrief ? (
        <div className="chat-intro">
          <Mark size={32} />
          <h3>What would you like to make yours?</h3>
          <p>Add a website and tell me what you want to rebuild.</p>
        </div>
      ) : (
        <ol className="chat-log" ref={listRef} aria-live="polite">
          {entries.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              pending={pending}
              onRetry={onRetry}
              onSend={onSend}
              onSaveToken={onSaveToken}
            />
          ))}
        </ol>
      )}
      {readOnly ? (
        <div className="composer composer-closed">{readOnly}</div>
      ) : (
        <form
          className={`composer ${isBrief ? "composer-brief" : ""}`}
          onSubmit={submit}
        >
          <p className="composer-hint" id="composer-hint">
            {isBrief
              ? "Send the URL and your goal in one message. You can refine the scope in conversation."
              : "Refine the scope here. The spec updates on the canvas."}
          </p>
          <div className="composer-box">
            <label htmlFor="composer-input" className="visually-hidden">
              {isBrief ? "Your brief" : "Message"}
            </label>
            <textarea
              id="composer-input"
              aria-describedby="composer-hint"
              rows={isBrief ? 3 : 1}
              value={draft}
              placeholder={
                isBrief
                  ? "Paste a URL and describe your goal…"
                  : "Describe a change…"
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {isBrief ? (
              <button
                type="submit"
                className="button button-primary"
                disabled={!canSend}
              >
                Send brief
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={!canSend}
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5 M6 11l6-6 6 6" />
                </svg>
              </button>
            )}
          </div>
        </form>
      )}
    </aside>
  );
}

function TokenForm({ onSave }: { onSave: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <form
      className="notice-actions token-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim()) onSave(token.trim());
      }}
    >
      <label className="visually-hidden" htmlFor="operator-token">
        Operator token
      </label>
      <input
        id="operator-token"
        type="password"
        autoComplete="off"
        placeholder="Operator token"
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <button
        type="submit"
        className="button button-primary"
        disabled={!token.trim()}
      >
        Sign in
      </button>
    </form>
  );
}

function StatusIcon() {
  return (
    <svg className="icon notice-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5 M12 16.5v.01" />
    </svg>
  );
}
