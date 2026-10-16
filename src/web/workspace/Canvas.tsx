import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Layout } from "./sessions";

// A pannable, zoomable canvas. Cards keep their place in the normal layout and are shifted
// by a stored offset, so Reset layout just clears the offsets.

export type Camera = { x: number; y: number; zoom: number };
type Box = { x: number; y: number; width: number; height: number };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const STEP = 1.25;
const KEY_MOVE = 20;
// A press that moves less than this is a click, not a drag.
const DRAG_SLOP = 4;
const INTERACTIVE = "a, button, input, textarea, select, video, label, summary";

const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Zooms by `factor`, keeping the screen point `at` over the same spot on the canvas. */
export function zoomAt(
  camera: Camera,
  at: { x: number; y: number },
  factor: number,
): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  const k = zoom / camera.zoom;
  return {
    zoom,
    x: at.x - (at.x - camera.x) * k,
    y: at.y - (at.y - camera.y) * k,
  };
}

/** The camera that shows all of `content` (canvas units) centred in the viewport. */
export function fitCamera(
  content: Box,
  viewport: { width: number; height: number },
  padding = 32,
): Camera {
  const zoom = clampZoom(
    Math.min(
      1,
      (viewport.width - padding * 2) / Math.max(content.width, 1),
      (viewport.height - padding * 2) / Math.max(content.height, 1),
    ),
  );
  return {
    zoom,
    x: (viewport.width - content.width * zoom) / 2 - content.x * zoom,
    y: (viewport.height - content.height * zoom) / 2 - content.y * zoom,
  };
}

type CanvasApi = {
  offset: (id: string) => { x: number; y: number };
  moveBy: (id: string, dx: number, dy: number) => void;
  zoom: () => number;
};
const CanvasContext = createContext<CanvasApi | null>(null);

export function Canvas({
  layout,
  onLayout,
  children,
}: {
  layout: Layout;
  onLayout: (update: (layout: Layout) => Layout) => void;
  children: ReactNode;
}) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  // Animates button zooms and Fit; pointer and wheel moves follow the hand directly.
  const [easing, setEasing] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const api: CanvasApi = {
    offset: (id) => layout[id] ?? { x: 0, y: 0 },
    moveBy: (id, dx, dy) =>
      onLayout((current) => {
        const at = current[id] ?? { x: 0, y: 0 };
        return { ...current, [id]: { x: at.x + dx, y: at.y + dy } };
      }),
    zoom: () => cameraRef.current.zoom,
  };

  // Native listener: React's wheel handler is passive and cannot stop the page from zooming.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // Let scrollable card content (e.g. the task log) scroll natively until it hits its end.
      if (!event.ctrlKey && !event.metaKey && canScroll(event, el)) return;
      event.preventDefault();
      setEasing(false);
      const rect = el.getBoundingClientRect();
      setCamera((c) =>
        event.ctrlKey || event.metaKey
          ? zoomAt(
              c,
              { x: event.clientX - rect.left, y: event.clientY - rect.top },
              Math.exp(-event.deltaY * 0.01),
            )
          : { ...c, x: c.x - event.deltaX, y: c.y - event.deltaY },
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const el = viewport.current;
    if (!el) return;
    setEasing(true);
    setCamera((c) =>
      zoomAt(c, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, factor),
    );
  };

  const fit = () => {
    const el = viewport.current;
    const items = world.current?.querySelectorAll(".cv-item");
    if (!el || !items?.length) return;
    const origin = el.getBoundingClientRect();
    const { x, y, zoom } = cameraRef.current;
    let [left, top, right, bottom] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const item of items) {
      const r = item.getBoundingClientRect();
      left = Math.min(left, (r.left - origin.left - x) / zoom);
      top = Math.min(top, (r.top - origin.top - y) / zoom);
      right = Math.max(right, (r.right - origin.left - x) / zoom);
      bottom = Math.max(bottom, (r.bottom - origin.top - y) / zoom);
    }
    setEasing(true);
    setCamera(
      fitCamera(
        { x: left, y: top, width: right - left, height: bottom - top },
        { width: el.clientWidth, height: el.clientHeight },
      ),
    );
  };

  // Dragging the empty canvas pans it.
  const pan = useRef<{ id: number; x: number; y: number }>(undefined);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (
      event.button !== 0 ||
      target.closest(`.cv-item, .cv-tools, ${INTERACTIVE}`)
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setEasing(false);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (p?.id !== event.pointerId) return;
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    pan.current = { ...p, x: event.clientX, y: event.clientY };
    setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  };
  const endPan = () => {
    pan.current = undefined;
  };

  return (
    <CanvasContext.Provider value={api}>
      <div
        ref={viewport}
        className="cv"
        // The dot grid moves and scales with the cards, so panning reads as panning.
        style={{
          backgroundSize: `${20 * camera.zoom}px ${20 * camera.zoom}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          ref={world}
          className="cv-world"
          data-easing={easing || undefined}
          style={{
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
          }}
        >
          {children}
        </div>
        <div className="cv-tools" role="toolbar" aria-label="Canvas controls">
          <button
            type="button"
            className="cv-tool"
            aria-label="Zoom out"
            disabled={camera.zoom <= MIN_ZOOM}
            onClick={() => zoomBy(1 / STEP)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8h9" />
            </svg>
          </button>
          <button
            type="button"
            className="cv-tool cv-zoom"
            title="Back to 100%"
            onClick={() => {
              setEasing(true);
              setCamera({ x: 0, y: 0, zoom: 1 });
            }}
          >
            <span className="visually-hidden">Zoom </span>
            {Math.round(camera.zoom * 100)}%
          </button>
          <button
            type="button"
            className="cv-tool"
            aria-label="Zoom in"
            disabled={camera.zoom >= MAX_ZOOM}
            onClick={() => zoomBy(STEP)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8h9M8 3.5v9" />
            </svg>
          </button>
          <button type="button" className="cv-tool" onClick={fit}>
            Fit to screen
          </button>
          <button
            type="button"
            className="cv-tool"
            disabled={Object.keys(layout).length === 0}
            onClick={() => onLayout(() => ({}))}
          >
            Reset layout
          </button>
        </div>
      </div>
    </CanvasContext.Provider>
  );
}

/** A card that can be dragged on the canvas, or moved with the keyboard through its Move button. */
export function CanvasItem({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const canvas = useContext(CanvasContext);
  const [moving, setMoving] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean }>(
    undefined,
  );
  const classes = className ? `cv-item ${className}` : "cv-item";
  // Outside a canvas (static rendering, tests) a card is just a card.
  if (!canvas) return <div className={classes}>{children}</div>;
  const { x, y } = canvas.offset(id);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (event.button !== 0 || target.closest(INTERACTIVE)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    drag.current = { ...d, x: event.clientX, y: event.clientY, moved: true };
    const zoom = canvas.zoom();
    canvas.moveBy(id, dx / zoom, dy / zoom);
  };
  const endDrag = () => {
    drag.current = undefined;
  };

  const onMoveKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!moving) return;
    const step = event.shiftKey ? KEY_MOVE * 4 : KEY_MOVE;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      canvas.moveBy(id, ...move);
    } else if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      setMoving(false);
    }
  };

  return (
    <div
      className={classes}
      data-moving={moving || undefined}
      // Moved cards sit above the ones still in place.
      style={x || y ? { translate: `${x}px ${y}px`, zIndex: 1 } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {children}
      <button
        type="button"
        className="cv-move"
        aria-pressed={moving}
        aria-label={`Move ${label}`}
        title={
          moving
            ? "Arrow keys move it, Shift moves further, Enter finishes"
            : undefined
        }
        onClick={() => setMoving((m) => !m)}
        onKeyDown={onMoveKey}
        onBlur={() => setMoving(false)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2" />
        </svg>
      </button>
      {moving && (
        <p className="visually-hidden" role="status">
          Moving {label}. Arrow keys move it, Enter finishes.
        </p>
      )}
    </div>
  );
}

function canScroll(event: WheelEvent, viewport: HTMLElement): boolean {
  for (
    let node = event.target instanceof Element ? event.target : null;
    node && node !== viewport;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    const scrollsY = /auto|scroll/.test(style.overflowY);
    const scrollsX = /auto|scroll/.test(style.overflowX);
    if (
      scrollsY &&
      node.scrollHeight > node.clientHeight &&
      ((event.deltaY > 0 &&
        node.scrollTop + node.clientHeight < node.scrollHeight) ||
        (event.deltaY < 0 && node.scrollTop > 0))
    )
      return true;
    if (
      scrollsX &&
      node.scrollWidth > node.clientWidth &&
      ((event.deltaX > 0 &&
        node.scrollLeft + node.clientWidth < node.scrollWidth) ||
        (event.deltaX < 0 && node.scrollLeft > 0))
    )
      return true;
  }
  return false;
}
