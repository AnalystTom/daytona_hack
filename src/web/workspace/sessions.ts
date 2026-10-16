import { z } from "zod";

// Each run is a session with its own workspace. The orchestrator cannot list runs, so this
// browser keeps the runs it has opened; a run created through the API joins once its
// /workspace/<runId> link is opened.
// shortcut: sessions and card layouts live in this browser's localStorage; move them server side with login.

export const PHASES: Record<string, string> = {
  brief: "Agreeing the spec",
  inspecting: "Inspecting the site",
  awaiting_sign_in: "Waiting for sign-in",
  planning: "Planning tasks",
  planned: "Plan ready",
  building: "Building",
  done: "Build finished",
  stopped: "Stopped",
  failed: "Run failed",
};
export const phaseLabel = (phase: string) => PHASES[phase] ?? phase;

export const RUN_ID = /^[\w-]{1,100}$/;

const Session = z.object({
  runId: z.string().regex(RUN_ID),
  target: z.string().optional(),
  phase: z.string().optional(),
  updatedAt: z.number(),
});
export type Session = z.infer<typeof Session>;

const SESSIONS_KEY = "reversy.sessions";
const layoutKey = (runId: string) => `reversy.layout.${runId}`;
const MAX_SESSIONS = 50;

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the session still works, it is just not remembered.
  }
}

// Newest first; unreadable entries are dropped.
export function listSessions(): Session[] {
  const stored = z.array(z.unknown()).safeParse(read(SESSIONS_KEY));
  if (!stored.success) return [];
  return stored.data
    .flatMap((item) => {
      const session = Session.safeParse(item);
      return session.success ? [session.data] : [];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Records what is known about a run; unknown fields keep their stored value.
export function rememberSession(
  update: Pick<Session, "runId"> & Partial<Pick<Session, "target" | "phase">>,
  now = Date.now(),
) {
  const sessions = listSessions();
  const known = sessions.find((s) => s.runId === update.runId);
  const next: Session = {
    runId: update.runId,
    target: update.target ?? known?.target,
    phase: update.phase ?? known?.phase,
    updatedAt: now,
  };
  if (known && known.target === next.target && known.phase === next.phase) {
    return;
  }
  write(
    SESSIONS_KEY,
    [next, ...sessions.filter((s) => s.runId !== update.runId)].slice(
      0,
      MAX_SESSIONS,
    ),
  );
}

// Card offsets on the canvas, in canvas pixels, by card id.
const Layout = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));
export type Layout = z.infer<typeof Layout>;

export function loadLayout(runId: string): Layout {
  const layout = Layout.safeParse(read(layoutKey(runId)));
  return layout.success ? layout.data : {};
}

export function saveLayout(runId: string, layout: Layout) {
  write(layoutKey(runId), layout);
}
