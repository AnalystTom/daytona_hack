import { useEffect, useRef, useState } from "react";
import type { VariantView } from "./orchestrator";
import {
  fetchPreviewLink,
  type RunCallError,
  type RunCallResult,
} from "./runClient";

const STATUS: Record<VariantView["status"], string> = {
  building: "Building",
  ready: "Ready",
  failed: "Did not finish",
  promoted: "Promoted",
};

// The rebuilt site is untrusted: it keeps its own (Daytona) origin, so it can fetch its sections but never reach this app.
const FRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin";

function VariantPreview({
  runId,
  variant,
  onRefused,
}: {
  runId: string;
  variant: VariantView;
  onRefused: (error: RunCallError) => void;
}) {
  const [link, setLink] = useState<RunCallResult<string>>();
  const [attempt, setAttempt] = useState(0);
  const refused = useRef(onRefused);
  refused.current = onRefused;
  useEffect(() => {
    let live = true;
    void fetchPreviewLink(runId, variant.id).then((result) => {
      if (!live) return;
      setLink(result);
      if (!result.ok && result.error === "operator_token")
        refused.current(result);
    });
    return () => {
      live = false;
    };
  }, [runId, variant.id, attempt]);
  if (!link?.ok)
    return (
      <p role="status">
        {link ? link.detail : "Opening variant preview…"}
        {link && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setLink(undefined);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        )}
      </p>
    );
  return (
    <iframe
      className="variant-frame"
      title={`${variant.title} preview`}
      src={link.value}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}

export function PreviewView({
  runId,
  onRefused,
  phase,
  variants,
  onMakeVariants,
  onPromote,
}: {
  runId: string;
  onRefused: (error: RunCallError) => void;
  phase?: string;
  variants: readonly VariantView[];
  onMakeVariants: () => void;
  onPromote: (variantId: string) => void;
}) {
  const [link, setLink] = useState<RunCallResult<string>>();
  const [attempt, setAttempt] = useState(0);
  const promotedId = variants.find((v) => v.status === "promoted")?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads on run change, promotion or Reload, not on every render's callback
  useEffect(() => {
    let live = true;
    setLink(undefined);
    void fetchPreviewLink(runId).then((result) => {
      if (!live) return;
      setLink(result);
      if (!result.ok && result.error === "operator_token") onRefused(result);
    });
    return () => {
      live = false;
    };
  }, [runId, attempt, promotedId]);

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
  const url = link.value;
  const finished = phase === "done";
  const promoted = variants.some((v) => v.status === "promoted");
  return (
    <div className="preview-board">
      <section className="preview-main" aria-label="Rebuild preview">
        <div className="preview-head">
          <h2>Your rebuild</h2>
          <div className="preview-actions">
            <button
              type="button"
              className="button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Reload
            </button>
            <a className="button" href={url} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
            <button
              type="button"
              className="button"
              disabled
              aria-describedby="deploy-note"
            >
              Deploy live
            </button>
          </div>
        </div>
        <p id="deploy-note" className="muted">
          Deploying live is not set up yet. Rebuild links last 30 minutes;
          reload for a fresh rebuild link.
        </p>
        <iframe
          className="preview-frame"
          title="Rebuild preview"
          src={url}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
        />
      </section>

      <section className="preview-variants" aria-label="Landing-page variants">
        <div className="preview-head">
          <div>
            <h2>Landing-page variants</h2>
            <p className="muted">
              Three alternatives built from a snapshot of this rebuild. Promote
              one to keep building from it.
            </p>
          </div>
          {variants.length === 0 && (
            <button
              type="button"
              className="button button-primary"
              disabled={!finished}
              title={finished ? undefined : "Available once the build finishes"}
              onClick={onMakeVariants}
            >
              Make three variants
            </button>
          )}
        </div>
        {variants.length > 0 && (
          <ul className="variant-list">
            {variants.map((v) => (
              <li key={v.id} className="card variant-card">
                <div className="card-head">
                  <h3 className="card-title">{v.title}</h3>
                  <span className={`variant-status variant-${v.status}`}>
                    {STATUS[v.status]}
                  </span>
                </div>
                <p>{v.explanation}</p>
                <p className="muted">
                  {v.pod === "fork"
                    ? "Fork of the merged rebuild"
                    : "Copy of the merged rebuild"}
                </p>
                {v.status !== "failed" && (
                  <VariantPreview
                    key={`${runId}:${v.id}:${attempt}:${promotedId}`}
                    runId={runId}
                    variant={v}
                    onRefused={onRefused}
                  />
                )}
                {v.status === "ready" && (
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={!finished || promoted}
                    onClick={() => onPromote(v.id)}
                  >
                    Promote this variant
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
