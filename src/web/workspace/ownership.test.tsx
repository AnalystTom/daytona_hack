import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "./Canvas";
import { ChatPanel } from "./ChatPanel";
import { PreviewView } from "./PreviewView";
import { SessionSwitcher } from "./SessionSwitcher";
import { SpecView } from "./SpecView";
import { Workspace } from "./Workspace";
import { listSessions, loadLayout, rememberSession } from "./sessions";

const hooks = vi.hoisted(() => ({
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  index: 0,
  effects: [] as (() => void)[],
  dirty: false,
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const changed = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ) =>
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((value, i) => !Object.is(value, previous[i]));
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const i = hooks.index++;
    const slot = hooks.slots[i];
    if (!slot || changed(slot.deps, deps))
      hooks.slots[i] = { value: factory(), deps };
    return hooks.slots[i]?.value;
  };
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = hooks.index++;
      hooks.slots[i] ??= {
        value:
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
      };
      const slot = hooks.slots[i];
      return [
        slot.value,
        (update: unknown) => {
          const value =
            typeof update === "function"
              ? (update as (current: unknown) => unknown)(slot.value)
              : update;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            hooks.dirty = true;
          }
        },
      ];
    },
    useRef: (value: unknown) => memo(() => ({ current: value }), []),
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) =>
      memo(() => callback, deps),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const i = hooks.index++;
      const old = hooks.slots[i];
      if (old && !changed(old.deps, deps)) return;
      hooks.slots[i] = { deps, cleanup: old?.cleanup };
      const slot = hooks.slots[i];
      hooks.effects.push(() => {
        slot.cleanup?.();
        const cleanup = effect();
        slot.cleanup =
          typeof cleanup === "function" ? (cleanup as () => void) : undefined;
      });
    },
  };
});

let tree: ReactNode;
let draw: () => ReactNode;
function paint() {
  hooks.index = 0;
  hooks.dirty = false;
  tree = draw();
  for (const effect of hooks.effects.splice(0)) effect();
}
function mount(render: () => ReactNode) {
  draw = render;
  paint();
}
async function flush() {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
    if (hooks.dirty) paint();
  }
}
function nodes(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...nodes(child.props.children)]
      : [],
  );
}
function element<P>(type: unknown): ReactElement<P> {
  const found = nodes(tree).find((node) => node.type === type);
  if (!found) throw new Error("Rendered component not found");
  return found as ReactElement<P>;
}
const chat = () => element<ComponentProps<typeof ChatPanel>>(ChatPanel);
const spec = () =>
  element<ComponentProps<typeof SpecView>>(SpecView).props.canvas;

beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  hooks.index = 0;
  hooks.dirty = false;
  vi.useFakeTimers();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal("window", { history: { state: null } });
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  for (const slot of hooks.slots) slot.cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const events = [
  {
    seq: 1,
    ts: "2026-10-16T12:00:00Z",
    type: "chat",
    data: { role: "user", text: "Alice's private brief" },
  },
  {
    seq: 2,
    ts: "2026-10-16T12:00:00Z",
    type: "chat",
    data: { role: "assistant", text: "Alice's private reply" },
  },
  {
    seq: 3,
    ts: "2026-10-16T12:00:00Z",
    type: "spec",
    data: {
      url: "https://alice.example/private",
      pages: [],
      flows: [],
      openQuestions: [],
      approved: true,
    },
  },
  {
    seq: 4,
    ts: "2026-10-16T12:00:00Z",
    type: "phase",
    data: { phase: "planned" },
  },
];
function service() {
  let caller: "alice" | "expired" | "bob" = "alice";
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (caller === "expired") return new Response(null, { status: 401 });
    if (caller === "bob")
      return Response.json({ code: "run_not_found" }, { status: 404 });
    if (init?.method === "POST") return Response.json({});
    return Response.json(
      String(input).includes("/events") ? events : { id: "alice-run" },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    caller: (value: typeof caller) => {
      caller = value;
    },
  };
}

describe("workspace ownership", () => {
  it("renders no cached Alice details while checking Bob's history, then shows only Bob's session", async () => {
    rememberSession({
      runId: "alice-run",
      target: "https://alice.example/private",
      phase: "building",
    });
    rememberSession({
      runId: "bob-run",
      target: "https://bob.example/",
      phase: "done",
    });
    const cached = listSessions();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    mount(() => SessionSwitcher({}));
    element<{ onClick: () => void }>("button").props.onClick();
    await flush();
    expect(renderToStaticMarkup(tree)).toContain("Loading sessions");
    expect(renderToStaticMarkup(tree)).not.toContain("alice");
    expect(renderToStaticMarkup(tree)).not.toContain("Building");
    resolve(
      Response.json([{ id: "bob-run", createdAt: "2026-10-16T12:00:00Z" }]),
    );
    await flush();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("bob.example");
    expect(html).toContain("Build finished");
    expect(html).not.toContain("alice");
    expect(listSessions()).toEqual(cached);
  });

  it("clears retained chat, target, layout and canvas on ownership refusal and ignores a late message reply", async () => {
    const api = service();
    mount(() => Workspace({ runId: "alice-run" }));
    await flush();
    expect(chat().props.entries).toHaveLength(2);
    const originalKey = chat().key;
    expect(spec().draftSpec?.url).toBe("https://alice.example/private");
    element<ComponentProps<typeof Canvas>>(Canvas).props.onLayout(() => ({
      spec: { x: 30, y: 40 },
    }));
    await flush();
    let resolve!: (response: Response) => void;
    api.fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    chat().props.onSend("Alice's late message");
    await flush();
    api.caller("bob");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    resolve(Response.json({}));
    await flush();
    expect(chat().props.entries).toEqual([
      expect.objectContaining({ kind: "notice", error: "not_found" }),
    ]);
    expect(chat().key).not.toBe(originalKey);
    expect(spec().draftSpec).toBeUndefined();
    expect(spec().evidence).toEqual([]);
    expect(element<ComponentProps<typeof Canvas>>(Canvas).props.layout).toEqual(
      {},
    );
    expect(
      element<ComponentProps<typeof SessionSwitcher>>(SessionSwitcher).props
        .current,
    ).toBeUndefined();
    expect(listSessions()).toEqual([]);
    expect(loadLayout("alice-run")).toEqual({});
  });

  it("keeps the same user's conversation and failed message across reauthentication until an explicit retry", async () => {
    const api = service();
    mount(() => Workspace({ runId: "alice-run" }));
    await flush();
    const original = chat().props.entries;
    const originalKey = chat().key;
    api.caller("expired");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(chat().props.entries).toEqual(expect.arrayContaining(original));
    expect(spec().draftSpec?.url).toBe("https://alice.example/private");
    chat().props.onSend("Keep the private hero");
    await flush();
    const failed = chat().props.entries.find(
      (entry) => entry.kind === "user" && entry.delivery === "failed",
    );
    expect(failed).toMatchObject({ text: "Keep the private hero" });
    const posts = () =>
      api.fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    api.caller("alice");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(posts()).toHaveLength(1);
    if (!failed) throw new Error("Failed message missing");
    chat().props.onRetry(failed.id);
    await flush();
    expect(posts()).toHaveLength(2);
    expect(posts().map(([path]) => path)).toEqual([
      "/api/v1/runs/alice-run/messages",
      "/api/v1/runs/alice-run/messages",
    ]);
    expect(chat().props.entries).toEqual(expect.arrayContaining(original));
    expect(chat().props.entries).toContainEqual(
      expect.objectContaining({ id: failed.id, delivery: "sent" }),
    );
    expect(chat().key).toBe(originalKey);
  });

  it.each([true, false])(
    "checks ownership on a preview 404 (run accessible: %s)",
    async (accessible) => {
      const onRefused = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (path) =>
          String(path).endsWith("/preview") || !accessible
            ? new Response(null, { status: 404 })
            : Response.json({ id: "alice-run" }),
        ),
      );
      mount(() => PreviewView({ runId: "alice-run", onRefused }));
      await flush();
      expect(onRefused).toHaveBeenCalledTimes(accessible ? 0 : 1);
    },
  );
});
