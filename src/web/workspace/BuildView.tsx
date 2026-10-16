import type { BuildEvent } from "../../shared/build";
import type { DraftSpec } from "../../shared/workspace";
import { BuildBoard, type Override } from "../build/BuildBoard";
import { CanvasItem } from "./Canvas";

export function BuildView({
  draftSpec,
  events = [],
  status,
  onStopBuild = () => {},
  onOverride,
}: {
  draftSpec?: DraftSpec;
  events?: readonly BuildEvent[];
  status?: string;
  onStopBuild?: () => void;
  onOverride?: (override: Override) => void;
}) {
  return (
    <div className="build-board">
      <CanvasItem id="build-board" label="Build and review">
        <div data-mount="kanban">
          <BuildBoard
            events={events}
            status={status}
            onStopBuild={onStopBuild}
            onOverride={onOverride}
          />
        </div>
      </CanvasItem>
      {draftSpec && (
        <CanvasItem id="build-spec" label="Draft spec summary">
          <section className="card spec-summary" aria-label="Draft spec">
            <h2 className="card-title">Draft spec</h2>
            <p className="muted">
              {draftSpec.status === "approved"
                ? "Scope approved"
                : "Scope not confirmed"}
            </p>
          </section>
        </CanvasItem>
      )}
    </div>
  );
}
