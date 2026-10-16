import { useEffect, useState } from "react";
import {
  fetchPreviewLink,
  fetchRun,
  type RunCallError,
  type RunCallResult,
} from "./runClient";

// The rebuild's sandbox is private, so the preview opens from a short-lived signed link.
export function PreviewView({
  runId,
  onRefused,
}: {
  runId: string;
  onRefused: (error: RunCallError) => void;
}) {
  const [link, setLink] = useState<RunCallResult<string>>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads on run change or Reload, not on every render's callback
  useEffect(() => {
    let live = true;
    setLink(undefined);
    void fetchPreviewLink(runId).then(async (result) => {
      if (!live) return;
      setLink(result);
      if (
        !result.ok &&
        ["operator_token", "access_required"].includes(result.error)
      )
        onRefused(result);
      if (!result.ok && result.error === "not_found") {
        const owned = await fetchRun(runId);
        if (live && !owned.ok && owned.error === "not_found") onRefused(owned);
      }
    });
    return () => {
      live = false;
    };
  }, [runId, attempt]);

  if (!link?.ok) {
    return (
      <div className="empty-state">
        <h2>{link ? "Preview unavailable" : "Opening the preview"}</h2>
        <p>{link ? link.detail : "Asking the sandbox for a fresh link."}</p>
        {link && (
          <button
            type="button"
            className="button"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <section className="preview" aria-label="Rebuild preview">
      <div className="preview-bar">
        <p className="muted">Links last 30 minutes. Reload for a fresh one.</p>
        <button
          type="button"
          className="button"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Reload
        </button>
        <a
          className="button"
          href={link.value}
          target="_blank"
          rel="noreferrer"
        >
          Open in new tab
        </a>
      </div>
      <iframe
        className="preview-frame"
        title="Rebuild preview"
        src={link.value}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
