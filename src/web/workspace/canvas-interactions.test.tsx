import {
  Children,
  type ComponentProps,
  isValidElement,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { Canvas } from "./Canvas";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [
    typeof initial === "function" ? initial() : initial,
    vi.fn(),
  ],
}));

afterEach(() => vi.unstubAllGlobals());

function elements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...elements(child.props.children)]
      : [],
  );
}

function surface(children?: ReactNode) {
  const tree = Canvas({ layout: {}, onLayout: vi.fn(), children });
  const node = elements(tree).find(
    (element) =>
      isValidElement<{ className?: string }>(element) &&
      element.props.className === "cv",
  );
  assert(node);
  return (node as ReactElement<ComponentProps<"div">>).props;
}

function pointer(tags: string[], capture: ReturnType<typeof vi.fn>) {
  const closest = vi.fn<(selector: string) => object | null>();
  const target = { closest };
  closest.mockImplementation((selector) =>
    selector.split(",").some((part) => tags.includes(part.trim()))
      ? target
      : null,
  );
  return {
    button: 0,
    pointerId: 7,
    clientX: 10,
    clientY: 20,
    target,
    currentTarget: { setPointerCapture: capture },
  } as unknown as PointerEvent<HTMLDivElement>;
}

it.each(["button", "a", "input", "textarea", "select"])(
  "leaves pointer events on %s descendants available to the control",
  (tag) => {
    const capture = vi.fn();
    surface().onPointerDown?.(pointer(["span", tag], capture));
    expect(capture).not.toHaveBeenCalled();
  },
);

it("still starts a pan on empty canvas space", () => {
  const capture = vi.fn();
  surface().onPointerDown?.(pointer([], capture));
  expect(capture).toHaveBeenCalledExactlyOnceWith(7);
});
