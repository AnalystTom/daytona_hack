import type { DraftSpec } from "../../shared/workspace";

// Mount point for the kanban, which is built separately in src/web/build/.
export function BuildView({ draftSpec }: { draftSpec?: DraftSpec }) {
  return (
    <div className="build-board">
      <section
        className="card kanban-mount"
        aria-labelledby="build-title"
        data-mount="kanban"
      >
        <h2 id="build-title" className="card-title card-title-lg">
          Build and review
        </h2>
        <div className="kanban-empty">
          <p className="kanban-empty-title">No build started</p>
          <p className="muted">Tasks appear after the spec is approved.</p>
        </div>
      </section>
      {draftSpec && (
        <section className="card spec-summary" aria-label="Draft spec">
          <h2 className="card-title">Draft spec</h2>
          <p className="muted">
            {draftSpec.status === "approved"
              ? "Scope approved"
              : "Scope not confirmed"}
          </p>
        </section>
      )}
    </div>
  );
}
