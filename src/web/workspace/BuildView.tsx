import type { BuildEvent } from "../../shared/build";
import type { DraftSpec } from "../../shared/workspace";
import { BuildBoard, type Override } from "../build/BuildBoard";

export function BuildView({
  draftSpec,
  events = [],
  onStopBuild = () => {},
  onOverride,
}: {
  draftSpec?: DraftSpec;
  events?: readonly BuildEvent[];
  onStopBuild?: () => void;
  onOverride?: (override: Override) => void;
}) {
  return (
    <div className="build-board">
      <div data-mount="kanban">
        <BuildBoard
          events={events}
          onStopBuild={onStopBuild}
          onOverride={onOverride}
        />
      </div>
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
