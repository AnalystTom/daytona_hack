import { useEffect, useState } from "react";
import type {
  CanvasEvidence,
  DraftSpec,
  SpecCanvas,
} from "../../shared/workspace";
import { notObservedReason } from "../../shared/evidence";
import { CanvasItem } from "./Canvas";
import { fetchEvidence } from "./runClient";

// Run evidence needs the operator token, so it is fetched and shown from a blob URL.
function useEvidenceSrc(src: string) {
  const fromRun = src.startsWith("/api/");
  const [blobUrl, setBlobUrl] = useState<string>();
  useEffect(() => {
    if (!fromRun) return;
    let url: string | undefined;
    let live = true;
    void fetchEvidence(src).then((result) => {
      if (!live || !result.ok) return;
      url = URL.createObjectURL(result.value);
      setBlobUrl(url);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      setBlobUrl(undefined);
    };
  }, [src, fromRun]);
  return fromRun ? blobUrl : src;
}

const NOT_CONFIRMED = "Not confirmed yet";

function SpecList({ items }: { items: string[] | undefined }) {
  if (!items?.length) return <p className="muted">{NOT_CONFIRMED}</p>;
  return (
    <ul className="spec-list">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items are plain strings and may repeat
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export function DraftSpecCard({ spec }: { spec: DraftSpec }) {
  return (
    <article className="card spec-card" aria-labelledby="draft-spec-title">
      <header className="card-head">
        <DocIcon />
        <h2 id="draft-spec-title" className="card-title card-title-lg">
          Draft spec
        </h2>
        <span className={`spec-status spec-status-${spec.status}`}>
          {spec.status === "approved" ? "Approved" : "Draft"}
        </span>
      </header>
      <section className="spec-field">
        <h3>Target URL</h3>
        {spec.url ? (
          <a href={spec.url} target="_blank" rel="noreferrer">
            {spec.url}
          </a>
        ) : (
          <p className="muted">{NOT_CONFIRMED}</p>
        )}
        {spec.redirectedFrom && spec.url && (
          <p className="muted">
            You entered {spec.redirectedFrom}; it redirects to {spec.url}.
          </p>
        )}
      </section>
      <section className="spec-field">
        <h3>Pages and flows</h3>
        <SpecList items={spec.pagesAndFlows} />
      </section>
      <section className="spec-field">
        <h3>Open questions</h3>
        <SpecList items={spec.openQuestions} />
      </section>
    </article>
  );
}

function EvidenceCaption({ item }: { item: CanvasEvidence }) {
  return (
    <p className="evidence-caption">
      <span>{item.pageOrState}</span>
      {item.label !== "observed" && (
        <span className="evidence-label">
          {item.label === "inferred" ? "Inferred" : "Not observed"}
        </span>
      )}
    </p>
  );
}

function ScreenshotCard({ item }: { item: CanvasEvidence }) {
  const src = useEvidenceSrc(item.src ?? "");
  return (
    <article className="card evidence-card">
      <header className="card-head">
        <ImageIcon />
        <h2 className="card-title">Target screenshot</h2>
      </header>
      {item.src ? (
        <img
          className="evidence-media"
          src={src}
          alt={`Screenshot of ${item.pageOrState}`}
        />
      ) : (
        <p className="muted">{notObservedReason(item.limitations.join(" "))}</p>
      )}
      <EvidenceCaption item={item} />
    </article>
  );
}

function VideoCard({ item }: { item?: CanvasEvidence }) {
  const src = useEvidenceSrc(item?.src ?? "");
  return (
    <article className="card evidence-card">
      <header className="card-head">
        <VideoIcon />
        <h2 className="card-title">Video evidence</h2>
      </header>
      {item ? (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: captured recordings have no caption track */}
          <video className="evidence-media" src={src} controls />
          <EvidenceCaption item={item} />
        </>
      ) : (
        <p className="muted">No recording yet</p>
      )}
    </article>
  );
}

export function SpecView({ canvas }: { canvas: SpecCanvas }) {
  const screenshots = canvas.evidence.filter((e) => e.kind === "screenshot");
  const recordings = canvas.evidence.filter((e) => e.kind === "recording");
  if (!canvas.draftSpec && canvas.evidence.length === 0) {
    return (
      <div className="empty-state">
        <EmptyIcon />
        <h2>Your work starts here</h2>
        <p>The spec and evidence appear here as you refine the brief.</p>
      </div>
    );
  }
  return (
    <div className="spec-board">
      {canvas.draftSpec && (
        <CanvasItem id="draft-spec" label="Draft spec" className="spec-card">
          <DraftSpecCard spec={canvas.draftSpec} />
        </CanvasItem>
      )}
      <div className="evidence-column">
        {screenshots.map((item) => (
          <CanvasItem
            key={item.id}
            id={`evidence-${item.id}`}
            label={`screenshot of ${item.pageOrState}`}
          >
            <ScreenshotCard item={item} />
          </CanvasItem>
        ))}
        {recordings.map((item) => (
          <CanvasItem
            key={item.id}
            id={`evidence-${item.id}`}
            label={`recording of ${item.pageOrState}`}
          >
            <VideoCard item={item} />
          </CanvasItem>
        ))}
        {canvas.draftSpec && recordings.length === 0 && (
          <CanvasItem id="video-evidence" label="Video evidence">
            <VideoCard />
          </CanvasItem>
        )}
      </div>
    </div>
  );
}

function DocIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v14H4z M4 16l5-5 4 4 2-2 5 5" />
      <circle cx="15.5" cy="9" r="1.5" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7h12v10H3z M15 11l6-3v8l-6-3" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg className="empty-icon" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M16 6h22l12 12v36a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4Z M38 6v12h12" />
      <circle cx="26" cy="32" r="3" />
      <path d="M18 50l10-10 6 6 4-4 8 8" />
    </svg>
  );
}
