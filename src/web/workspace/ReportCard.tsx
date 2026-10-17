import { useEffect, useRef, useState } from "react";
import type { CanvasEvidence } from "../../shared/workspace";
import {
  exactQuoteEvidence,
  type ReportDissection,
  type ReportFigure,
} from "../../shared/report";
import { useEvidenceSrc } from "./useEvidenceSrc";

const sourceStatus = {
  in_article: "In the article",
  traced_online: "Traced to source online",
  named_not_found: "Source named but not found",
  not_observed: "Not observed",
};
const traceStatus = (
  figure: ReportFigure,
  trace?: ReportDissection["traces"][number],
) =>
  trace?.status === "matches" && exactQuoteEvidence(figure, trace)
    ? "Exact source quote match"
    : "Unverified online";
const sourceLink = (url: string, quote: string) =>
  `${url.split("#")[0]}#:~:text=${encodeURIComponent(quote.slice(0, 200))}`;

export function ReportCard({
  report,
  evidence,
  onSave,
}: {
  report: ReportDissection;
  evidence: CanvasEvidence[];
  onSave?: (
    figureId: string,
    edit: { label: string; value: string },
  ) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const quoteRef = useRef<HTMLElement>(null);
  const figure = report.figures.find((f) => f.id === selected);
  const source = report.sources.find((s) => s.id === figure?.sourceId);
  const trace = report.traces.find((t) => t.figureId === selected);
  const originalSource = report.sources.find((s) => s.id === trace?.sourceId);
  useEffect(() => {
    if (selected) quoteRef.current?.focus({ preventScroll: true });
    setSaveStatus("");
  }, [selected]);
  return (
    <article className="card report-card" aria-labelledby="report-title">
      <header className="card-head">
        <h2 id="report-title" className="card-title card-title-lg">
          Report dissection
        </h2>
      </header>
      <div className="report-body">
        <h3>{report.title}</h3>
        <p className="muted">
          Select a number to inspect its source. Changes are saved separately;
          captured originals stay intact.
        </p>
        {report.figures.length === 0 && (
          <p>No figures observed in this capture.</p>
        )}
        {(
          [
            ["investment_breakdown", "Investment breakdown"],
            ["key_figures", "Key figures and periods"],
            ["not_observed", "Not observed"],
          ] as const
        ).map(([group, label]) => {
          const figures = report.figures.filter((f) => f.group === group);
          return (
            figures.length > 0 && (
              <section key={group} aria-label={label}>
                <h4>{label}</h4>
                <div className="report-table-scroll">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th scope="col">Figure</th>
                        <th scope="col">Value</th>
                        <th scope="col">Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {figures.map((f) => (
                        <tr key={f.id} aria-selected={selected === f.id}>
                          <th scope="row">
                            {report.edits[f.id]?.label ?? f.label}
                            {report.edits[f.id] && (
                              <small>Edited; original retained</small>
                            )}
                          </th>
                          <td>
                            <button
                              type="button"
                              className="report-number"
                              onClick={() => setSelected(f.id)}
                              aria-label={`Inspect ${f.value || "not observed"}: ${f.label}`}
                            >
                              {report.edits[f.id]?.value === ""
                                ? "Empty edited value"
                                : (report.edits[f.id]?.value ??
                                  (f.value || "Not observed"))}
                            </button>
                            <small>{f.unit}</small>
                          </td>
                          <td>
                            {f.status === "not_observed"
                              ? "Not observed"
                              : f.status === "inferred"
                                ? "Inferred"
                                : "Observed"}
                            <small>
                              {traceStatus(
                                f,
                                report.traces.find((t) => t.figureId === f.id),
                              )}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          );
        })}
        <section
          className="report-inspector"
          ref={quoteRef}
          tabIndex={-1}
          aria-label="Selected figure source"
        >
          {figure && source ? (
            <>
              <h4>Captured original: {figure.value || "Not observed"}</h4>
              <blockquote>
                <mark>{figure.quote}</mark>
              </blockquote>
              <p>{figure.reason}</p>
              <p>
                <strong>{sourceStatus[source.status]}</strong>
                {source.url && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={sourceLink(source.url, figure.quote)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open source location
                    </a>
                  </>
                )}
              </p>
              <p className="report-location">
                {figure.location.path}
                <br />
                Captured {source.capturedAt}
                <br />
                Content hash {source.hash || "Not observed"}
              </p>
              {figure.location.screenshot ? (
                <ReportRegion
                  region={figure.location.screenshot}
                  evidence={evidence}
                />
              ) : (
                <p className="muted">
                  Screenshot region not observed for this figure. The captured
                  text location is available above.
                </p>
              )}
              {trace && (
                <div className="report-trace">
                  <h4>{traceStatus(figure, trace)}</h4>
                  <p>{trace.reason}</p>
                  {trace.quote ? (
                    <>
                      <p>Independently captured source quote</p>
                      <blockquote>{trace.quote}</blockquote>
                    </>
                  ) : (
                    <p>Source quotation not observed.</p>
                  )}
                  {originalSource?.url && (
                    <a
                      href={sourceLink(originalSource.url, trace.quote)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open researched source
                    </a>
                  )}
                </div>
              )}
              <EditFigure
                key={`${report.runId}:${figure.id}`}
                figure={figure}
                edit={report.edits[figure.id]}
                disabled={saving || !onSave}
                onSave={async (edit) => {
                  if (!onSave) return;
                  setSaving(true);
                  setSaveStatus("");
                  try {
                    setSaveStatus(
                      (await onSave(figure.id, edit))
                        ? "Saved. Original retained."
                        : "Changes could not be saved. Try again.",
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              />
              <p role="status">{saving ? "Saving changes…" : saveStatus}</p>
            </>
          ) : (
            <p className="muted">
              Select a figure to see its exact quotation, location, screenshot
              region and online research.
            </p>
          )}
        </section>
        <section className="report-sources" aria-label="Report sources">
          <h4>Sources and datasets</h4>
          <p className="muted">
            {report.search.calls} search calls, budget {report.search.budget}.{" "}
            {report.search.limitations}
          </p>
          <ul>
            {report.sources.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong>
                <span className={`report-source-status status-${s.status}`}>
                  {sourceStatus[s.status]}
                </span>
                <p>
                  {s.publisher}
                  {s.published
                    ? ` · ${s.published}`
                    : " · Published date not observed"}
                </p>
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.url}
                  </a>
                )}
                <details>
                  <summary>Provenance and availability</summary>
                  <blockquote>{s.quote}</blockquote>
                  <a
                    href={sourceLink(s.quoteUrl, s.quote)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open captured quotation
                  </a>
                  <p>{s.reason}</p>
                  <p>
                    {s.status === "named_not_found"
                      ? "Citation captured"
                      : "Captured"}{" "}
                    {s.capturedAt}
                    <br />
                    Hash {s.hash || "Not observed"}
                    <br />
                    Source record: report_source [{report.runId}, {s.id}]
                  </p>
                </details>
              </li>
            ))}
          </ul>
        </section>
        <details className="report-records">
          <summary>Stored records</summary>
          <p>
            SurrealDB {report.storage.table}: {report.storage.recordId}
          </p>
          <p>
            Each figure and source has a linked report_figure or report_source
            record. Changes are stored in report_edit.
          </p>
        </details>
      </div>
    </article>
  );
}

function EditFigure({
  figure,
  edit,
  disabled,
  onSave,
}: {
  figure: ReportFigure;
  edit?: { label: string; value: string };
  disabled: boolean;
  onSave: (edit: { label: string; value: string }) => void;
}) {
  const [label, setLabel] = useState(edit?.label ?? figure.label);
  const [value, setValue] = useState(edit?.value ?? figure.value);
  return (
    <form
      className="report-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ label, value });
      }}
    >
      <h4>Edit this figure</h4>
      <label>
        Label
        <input
          value={label}
          maxLength={1000}
          required
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label>
        Value
        <input
          value={value}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="button"
        disabled={disabled || !label.trim()}
      >
        Save changes
      </button>
    </form>
  );
}

function ReportRegion({
  region,
  evidence,
}: {
  region: NonNullable<ReportFigure["location"]["screenshot"]>;
  evidence: CanvasEvidence[];
}) {
  const item = evidence.find((e) => e.id === region.evidenceId);
  const { src, error } = useEvidenceSrc(item?.src ?? "");
  if (!item || error)
    return <p role="status">Source screenshot unavailable.</p>;
  if (!src) return <p role="status">Loading source screenshot…</p>;
  return (
    <svg
      className="report-region"
      viewBox={`${Math.max(0, region.x - 12)} ${Math.max(0, region.y - 12)} ${region.width + 24} ${region.height + 24}`}
      role="img"
      aria-label="Highlighted region of the captured source screenshot"
    >
      <image href={src} width={region.pageWidth} height={region.pageHeight} />
      <rect
        x={region.x}
        y={region.y}
        width={region.width}
        height={region.height}
        fill="#c4db9b"
        fillOpacity="0.2"
        stroke="#39253f"
        strokeWidth="3"
      />
    </svg>
  );
}
