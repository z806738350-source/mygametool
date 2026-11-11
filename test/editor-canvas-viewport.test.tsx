// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Edge, MiniMapProps, Node, ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/renderer/editor-canvas.js";

const flow = vi.hoisted(() => ({
  props: undefined as ReactFlowProps<Node, Edge> | undefined,
  propsById: new Map<string, ReactFlowProps<Node, Edge>>(),
  minimap: undefined as MiniMapProps<Node> | undefined,
  width: 1000,
  initialized: false,
  fitView: vi.fn<() => Promise<boolean>>(),
  getViewport: vi.fn(() => ({ x: 80, y: 40, zoom: 0.4 })),
  setCenter: vi.fn(() => Promise.resolve(true)),
  zoomIn: vi.fn(() => Promise.resolve(true)),
  zoomOut: vi.fn(() => Promise.resolve(true)),
  zoomTo: vi.fn(() => Promise.resolve(true)),
  setViewport: vi.fn(() => Promise.resolve(true)),
  getNodes: vi.fn<() => Node[]>(),
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow.props = props;
    flow.propsById.set(props.id ?? "canvas", props);
    return (
      <div data-testid={props.id ?? "canvas"} className={`react-flow ${props.className}`} tabIndex={props.tabIndex} style={props.style} onKeyDown={props.onKeyDown} onPointerDownCapture={props.onPointerDownCapture} onFocus={props.onFocus} onBlur={props.onBlur}>
        {props.children}
      </div>
    );
  },
  Background: () => null,
  MiniMap: (props: MiniMapProps<Node>) => { flow.minimap = props; return <div data-testid="minimap" />; },
  BackgroundVariant: { Dots: "dots" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  Panel: ({ children, className, position }: { children: ReactNode; className?: string; position?: string }) => <div className={className} data-position={position}>{children}</div>,
  ViewportPortal: () => null,
  useNodesInitialized: () => flow.initialized,
  useStore: (selector: (state: object) => unknown) =>
    selector({ width: flow.width, height: 700, transform: [0, 0, 1] }),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useReactFlow: () => ({
    fitView: flow.fitView,
    getViewport: flow.getViewport,
    setCenter: flow.setCenter,
    zoomIn: flow.zoomIn,
    zoomOut: flow.zoomOut,
    zoomTo: flow.zoomTo,
    setViewport: flow.setViewport,
    getNodes: flow.getNodes,
  }),
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  flow.initialized = false;
  flow.width = 1000;
  flow.minimap = undefined;
  flow.propsById.clear();
  flow.setCenter.mockClear();
  flow.zoomIn.mockClear(); flow.zoomOut.mockClear(); flow.zoomTo.mockClear(); flow.setViewport.mockClear();
  flow.getNodes.mockReturnValue(nodes);
  flow.getViewport.mockReturnValue({ x: 80, y: 40, zoom: 0.4 });
  flow.fitView.mockReset().mockResolvedValue(true);
  localStorage.removeItem("ohmygame:canvas-minimap-collapsed");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem("ohmygame:canvas-minimap-collapsed");
  vi.unstubAllGlobals();
});
const nodes = [{ id: "document", position: { x: 0, y: 0 }, data: {} }];
const canvas = () =>
  container.querySelector<HTMLElement>('[data-testid="canvas"]')!;
async function render(
  fitViewOnLoad = false,
  items: Node[] = nodes,
  onInitialFit = vi.fn(),
  children?: ReactNode,
  revealNodeIds?: string[],
) {
  await act(async () =>
    root.render(
      <EditorCanvas
        nodes={items}
        addControl={null}
        onOpenMenu={vi.fn()}
        defaultViewport={{ x: 80, y: 40, zoom: 0.4 }}
        fitViewOnLoad={fitViewOnLoad}
        revealNodeIds={revealNodeIds}
        onInitialFit={onInitialFit}
        style={{ background: "red" }}
      >{children}</EditorCanvas>,
    ),
  );
}
async function initialize() {
  await act(async () => flow.props!.onInit!(flow as never));
}

async function key(target: HTMLElement, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}

async function focus(target: HTMLElement) {
  await act(async () => target.focus());
}

it("does not expose the initial 100% view before the saved viewport is initialized, including on remount", async () => {
  for (let index = 0; index < 2; index++) {
    await render();
    expect(canvas().style.opacity).toBe("0");
    expect(canvas().style.pointerEvents).toBe("none");
    expect(canvas().style.background).toBe("red");
    await initialize();
    expect(canvas().style.opacity).toBe("");
    expect(canvas().style.pointerEvents).toBe("");
    await act(async () => root.render(null));
  }
});

it("waits for node measurements and the fitted viewport before revealing a remix", async () => {
  let finishFit!: (fitted: boolean) => void;
  flow.fitView.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishFit = resolve;
      }),
  );
  const onInitialFit = vi.fn();
  await render(true, nodes, onInitialFit);
  await initialize();
  expect(canvas().style.opacity).toBe("0");
  expect(flow.fitView).not.toHaveBeenCalled();
  flow.initialized = true;
  await render(true, nodes, onInitialFit);
  expect(flow.fitView).toHaveBeenCalledOnce();
  expect(canvas().style.opacity).toBe("0");
  await act(async () => finishFit(true));
  expect(canvas().style.opacity).toBe("");
  expect(onInitialFit).toHaveBeenCalledWith({ x: 80, y: 40, zoom: 0.4 });
});

it("reveals empty boards and boards with only hidden nodes without waiting for a fit", async () => {
  for (const items of [[], nodes.map((node) => ({ ...node, hidden: true }))]) {
    await render(true, items);
    await initialize();
    expect(canvas().style.opacity).toBe("");
    expect(flow.fitView).not.toHaveBeenCalled();
    await act(async () => root.render(null));
  }
});

it("centers a minimap click in world coordinates without changing the current zoom", async () => {
  await render();
  expect(flow.minimap?.pannable).toBe(true);
  expect(flow.minimap?.position).toBe("bottom-right");
  flow.getViewport.mockReturnValue({ x: 120, y: -60, zoom: 1.5 });
  await act(async () => flow.minimap!.onClick!({} as never, { x: -2400, y: 3800 }));
  expect(flow.setCenter).toHaveBeenCalledWith(-2400, 3800, { zoom: 1.5 });
});

it("moves a smaller overview above the toolbar in narrow canvases", async () => {
  flow.width = 420;
  await render();
  expect(flow.minimap?.position).toBe("top-right");
  expect(flow.minimap?.style).toEqual({ width: 120, height: 80 });
  expect(container.querySelector(".story-canvas-overview")?.getAttribute("data-position")).toBe("top-right");
});

it("collapses to an SVG map button, preserves focus and remembers the local preference on remount", async () => {
  await render(); await initialize();
  const button = container.querySelector<HTMLButtonElement>(".story-canvas-minimap-toggle")!;
  const controlled = () => document.getElementById(button.getAttribute("aria-controls")!)!;
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await focus(button);
  await act(async () => button.click());
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-label")).toBe("Show minimap");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(controlled().hidden).toBe(true);
  expect(button.querySelector("svg")).not.toBeNull();
  expect(container.querySelector('[data-testid="minimap"]')).toBeNull();
  expect(flow.setCenter).not.toHaveBeenCalled();
  await act(async () => root.render(null)); await render();
  const restored = container.querySelector<HTMLButtonElement>(".story-canvas-minimap-toggle")!;
  expect(restored.getAttribute("aria-expanded")).toBe("false");
  await focus(restored); await act(async () => restored.click());
  expect(document.activeElement).toBe(restored);
  expect(restored.getAttribute("aria-label")).toBe("Hide minimap");
  expect(container.querySelector('[data-testid="minimap"]')).not.toBeNull();
  flow.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1.2 });
  await act(async () => flow.minimap!.onClick!({} as never, { x: -900, y: 1400 }));
  expect(flow.setCenter).toHaveBeenCalledWith(-900, 1400, { zoom: 1.2 });
});

it("keeps the collapsed toggle at the responsive corner without changing the viewport", async () => {
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>(".story-canvas-minimap-toggle")!.click());
  flow.width = 420; await render();
  expect(container.querySelector(".story-canvas-overview")?.getAttribute("data-position")).toBe("top-right");
  expect(container.querySelector(".story-canvas-overview")?.classList.contains("is-collapsed")).toBe(true);
  expect(flow.setViewport).not.toHaveBeenCalled(); expect(flow.setCenter).not.toHaveBeenCalled();
});

it("keeps the minimap toggle usable when local preference storage is unavailable", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  try {
    await render();
    const button = container.querySelector<HTMLButtonElement>(".story-canvas-minimap-toggle")!;
    await act(async () => button.click()); expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click()); expect(button.getAttribute("aria-expanded")).toBe("true");
  } finally { read.mockRestore(); write.mockRestore(); }
});

it("keeps existing scroll, pinch and drag behavior while wheel policy is under review", async () => {
  await render();
  expect(flow.props?.panOnScroll).toBe(true);
  expect(flow.props?.zoomOnScroll).toBe(false);
  expect(flow.props?.zoomOnPinch).toBe(true);
  expect(flow.props?.panOnDrag).toEqual([1, 2]);
});

it("activates shortcuts by focusing the canvas, including main-keyboard and numpad keys", async () => {
  await render(); await initialize();
  const outside = document.createElement("textarea"); container.append(outside); await focus(outside);
  await key(canvas(), "+");
  expect(flow.zoomIn).not.toHaveBeenCalled();
  await act(async () => canvas().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(document.activeElement).toBe(canvas());
  for (const [value, code, shiftKey] of [["=", "Equal", false], ["+", "Equal", true], ["+", "NumpadAdd", false]] as const) {
    expect((await key(canvas(), value, { code, shiftKey })).defaultPrevented).toBe(true);
  }
  await key(canvas(), "-", { code: "Minus" }); await key(canvas(), "-", { code: "NumpadSubtract" });
  await key(canvas(), "0", { code: "Numpad0" });
  expect(flow.zoomIn).toHaveBeenCalledTimes(3); expect(flow.zoomOut).toHaveBeenCalledTimes(2);
  expect(flow.zoomTo).toHaveBeenCalledExactlyOnceWith(1);
});

it("shows a local focus hint for keyboard entry, but not for pointer entry or later zoom shortcuts", async () => {
  await render(); await initialize();
  const element = canvas();
  const matches = element.matches.bind(element);
  const match = vi.spyOn(element, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
  await act(async () => element.focus());
  expect(element.classList.contains("is-keyboard-focused")).toBe(true);
  await act(async () => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(element.classList.contains("is-keyboard-focused")).toBe(false);
  await key(element, "+");
  expect(element.classList.contains("is-keyboard-focused")).toBe(false);
  await act(async () => element.blur());
  expect(element.classList.contains("is-keyboard-focused")).toBe(false);
  match.mockRestore();
});

it("fits populated or empty canvases using the same operation as the existing button", async () => {
  await render(); await initialize(); await focus(canvas());
  await key(canvas(), "f");
  expect(flow.fitView).toHaveBeenCalledExactlyOnceWith({ padding: 0.2, duration: 200 });
  flow.getNodes.mockReturnValue([]);
  await key(canvas(), "F");
  expect(flow.setViewport).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0, zoom: 1 }, { duration: 200 });
  expect(container.querySelector('[title="Zoom in (+ / =)"]')).not.toBeNull();
  expect(container.querySelector('[title="Reset zoom (0)"]')).not.toBeNull();
  expect(container.querySelector('[title="Fit view (F)"]')).not.toBeNull();
});

it("does not consume modifiers, IME input, held keys, node movement or history shortcuts", async () => {
  await render(); await initialize(); await focus(canvas());
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    expect((await key(canvas(), "+", options)).defaultPrevented).toBe(false);
  }
  for (const value of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Enter", "Escape", "Delete", "Insert", "z", "y", "d"]) {
    expect((await key(canvas(), value)).defaultPrevented).toBe(false);
  }
  await key(canvas(), "F", { shiftKey: true });
  expect(flow.zoomIn).not.toHaveBeenCalled(); expect(flow.fitView).not.toHaveBeenCalled();
});

it("leaves focused text, controls, code and media alone without stealing their focus", async () => {
  await render(false, nodes, vi.fn(), <><textarea /><input /><select /><button>Open</button><div contentEditable suppressContentEditableWarning tabIndex={0} /><div className="nokey" tabIndex={0} /><div className="model-preview" tabIndex={0} /><video tabIndex={0} /><iframe tabIndex={0} /></>);
  await initialize();
  for (const element of canvas().querySelectorAll<HTMLElement>("textarea, input, select, button, [contenteditable], .nokey, .model-preview, video, iframe")) {
    await focus(element);
    await act(async () => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(document.activeElement).toBe(element);
    expect((await key(element, "+")).defaultPrevented).toBe(false);
  }
  expect(flow.zoomIn).not.toHaveBeenCalled();
});

it.each(["dialog", "alertdialog", "menu", "listbox"])("blocks a visible %s even when it leaves focus on the canvas", async (role) => {
  await render(); await initialize(); await focus(canvas());
  const overlay = document.createElement("div"); overlay.setAttribute("role", role); container.append(overlay);
  expect((await key(canvas(), "+")).defaultPrevented).toBe(false);
  expect(flow.zoomIn).not.toHaveBeenCalled();
  overlay.style.display = "none";
  await key(canvas(), "+");
  expect(flow.zoomIn).toHaveBeenCalledOnce();
});

it("ignores React portal events and hidden, inert or uninitialized canvases", async () => {
  const portal = document.createElement("div"); document.body.append(portal);
  try {
    await render(false, nodes, vi.fn(), createPortal(<div tabIndex={0} id="outside-canvas">Portal</div>, portal));
    await focus(canvas()); await key(canvas(), "+");
    expect(flow.zoomIn).not.toHaveBeenCalled();
    await initialize();
    const target = portal.querySelector<HTMLElement>("#outside-canvas")!; await focus(target);
    await act(async () => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(document.activeElement).toBe(target);
    await key(target, "+");
    for (const attribute of ["hidden", "inert", "aria-hidden"]) {
      canvas().setAttribute(attribute, "true"); await focus(canvas()); await key(canvas(), "+"); canvas().removeAttribute(attribute);
    }
    canvas().style.display = "none"; await key(canvas(), "+"); canvas().style.display = "";
    expect(flow.zoomIn).not.toHaveBeenCalled();
  } finally { portal.remove(); }
});

it("routes shortcuts only to the focused canvas when editors coexist", async () => {
  await act(async () => root.render(<>
    <EditorCanvas id="first" nodes={nodes} addControl={null} onOpenMenu={vi.fn()} />
    <EditorCanvas id="second" nodes={nodes} addControl={null} onOpenMenu={vi.fn()} />
  </>));
  const firstZoom = vi.fn(), secondZoom = vi.fn();
  await act(async () => { flow.propsById.get("first")!.onInit!({ ...flow, zoomIn: firstZoom } as never); flow.propsById.get("second")!.onInit!({ ...flow, zoomIn: secondZoom } as never); });
  const first = container.querySelector<HTMLElement>('[data-testid="first"]')!, second = container.querySelector<HTMLElement>('[data-testid="second"]')!;
  await focus(first); await key(first, "+");
  expect(firstZoom).toHaveBeenCalledOnce(); expect(secondZoom).not.toHaveBeenCalled();
  await focus(second); await key(second, "+"); await key(first, "+");
  expect(firstZoom).toHaveBeenCalledOnce(); expect(secondZoom).toHaveBeenCalledOnce();
});

it("checks the installed pan/zoom engine's center-preserving reset and zoom limits", async () => {
  const { XYPanZoom } = await import("@xyflow/system");
  const pane = document.createElement("div"); container.append(pane);
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 700);
  const pan = XYPanZoom({ domNode: pane, minZoom: 0.1, maxZoom: 2, viewport: { x: 80, y: -40, zoom: 0.4 }, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]], onDraggingChange: vi.fn() });
  try {
    const before = pan.getViewport();
    await pan.scaleTo(1);
    const after = pan.getViewport();
    expect(after.zoom).toBe(1);
    expect((500 - after.x) / after.zoom).toBeCloseTo((500 - before.x) / before.zoom);
    expect((350 - after.y) / after.zoom).toBeCloseTo((350 - before.y) / before.zoom);
    await pan.scaleTo(100); expect(pan.getViewport().zoom).toBe(2);
    await pan.scaleTo(0.001); expect(pan.getViewport().zoom).toBe(0.1);
  } finally { pan.destroy(); }
});

it("reveals externally created media once after measurement and waits while the board is hidden", async () => {
  const ids = ["agent-image", "reference"];
  await render(false, nodes, undefined, undefined, ids);
  expect(flow.fitView).not.toHaveBeenCalled();
  flow.initialized = true; flow.width = 0;
  await render(false, nodes, undefined, undefined, ids);
  expect(flow.fitView).not.toHaveBeenCalled();
  flow.width = 1000;
  await render(false, nodes, undefined, undefined, ids);
  expect(flow.fitView).toHaveBeenCalledExactlyOnceWith({ nodes: ids.map(id => ({ id })), padding: 0.2, maxZoom: 1, duration: 200 });
  await render(false, nodes, undefined, undefined, [...ids]);
  expect(flow.fitView).toHaveBeenCalledTimes(1);
  await render(false, nodes, undefined, undefined, ["agent-model"]);
  expect(flow.fitView).toHaveBeenCalledTimes(2);
});
