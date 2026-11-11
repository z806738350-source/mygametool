// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltips } from "../src/renderer/tooltips.js";
import { desktopPreviewLayout } from "../src/renderer/desktop-game-preview.js";

let root: Root | undefined;
let popupSize = { width: 160, height: 40 };
const rect = (x: number, y: number, width: number, height: number): DOMRect =>
  ({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  }) as DOMRect;
const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount() {
  const container = document.createElement("div");
  container.style.overflow = "hidden";
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Tooltips />));
  return container;
}

function trigger(x = 300, y = 80, text = "Show the Agent playtest window") {
  const button = document.createElement("button");
  button.dataset.tooltip = text;
  button.setAttribute("aria-label", text);
  button.innerHTML = "<svg><path></path></svg>";
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rect(x, y, 32, 32));
  document.body.append(button);
  return button;
}

async function pointer(
  target: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
  pointerType = "mouse",
) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType, relatedTarget }),
    );
    await settle();
  });
}

function keyboardFocus(button: HTMLButtonElement, visible: boolean) {
  const original = button.matches.bind(button);
  vi.spyOn(button, "matches").mockImplementation((selector) =>
    selector === ":focus-visible" ? visible : original(selector),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 800);
  vi.stubGlobal("innerHeight", 600);
  popupSize = { width: 160, height: 40 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip"
        ? rect(
            parseFloat(this.style.left) || 0,
            parseFloat(this.style.top) || 0,
            popupSize.width,
            popupSize.height,
          )
        : rect(0, 0, 0, 0);
    },
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared real tooltip", () => {
  it("uses a body portal and stays open while moving between a button's nested icon parts", async () => {
    const container = await mount();
    const button = trigger();
    const svg = button.querySelector("svg")!;
    const path = button.querySelector("path")!;
    await pointer(path, "pointerover");
    expect(tip()?.textContent).toBe(button.dataset.tooltip);
    expect(tip()?.parentElement).toBe(document.body);
    expect(container.contains(tip())).toBe(false);
    expect(tip()?.hasAttribute("data-native-preview-overlay")).toBe(false);
    const original = tip();
    await pointer(path, "pointerout", svg);
    expect(tip()).toBe(original);
    await pointer(svg, "pointerover", path);
    expect(tip()).toBe(original);
    await pointer(button, "pointerout", document.body);
    expect(tip()).toBeNull();
  });

  it("shows for keyboard focus-visible, dismisses on Escape without moving focus, and preserves descriptions", async () => {
    await mount();
    const button = trigger();
    button.setAttribute("aria-describedby", "help-one help-two");
    keyboardFocus(button, true);
    await act(async () => button.focus());
    expect(tip()).not.toBeNull();
    const id = tip()!.id;
    expect(button.getAttribute("aria-describedby")).toBe(
      `help-one help-two ${id}`,
    );
    await act(async () =>
      button.setAttribute(
        "aria-describedby",
        `${button.getAttribute("aria-describedby")} newer-help`,
      ),
    );
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-describedby")).toBe(
      "help-one help-two newer-help",
    );
  });

  it("does not show on non-keyboard focus or touch pointer events", async () => {
    await mount();
    const button = trigger();
    keyboardFocus(button, false);
    await act(async () => button.focus());
    expect(tip()).toBeNull();
    await pointer(button, "pointerover", null, "touch");
    expect(tip()).toBeNull();
  });

  it("keeps keyboard focus tooltip after pointer leave and clears it on blur", async () => {
    await mount();
    const button = trigger();
    keyboardFocus(button, true);
    await act(async () => button.focus());
    await pointer(button, "pointerover");
    await pointer(button, "pointerout", document.body);
    expect(tip()).not.toBeNull();
    await act(async () => button.blur());
    expect(tip()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("updates a visible trigger's dynamic tooltip and removes it when text disappears", async () => {
    await mount();
    const button = trigger();
    await pointer(button, "pointerover");
    const id = tip()!.id;
    await act(async () => {
      button.dataset.tooltip = "Hide the Agent playtest window";
      await settle();
    });
    expect(tip()?.textContent).toBe("Hide the Agent playtest window");
    expect(tip()?.id).toBe(id);
    await act(async () => {
      delete button.dataset.tooltip;
      await settle();
    });
    expect(tip()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("clears a removed trigger and component teardown restores its existing description", async () => {
    await mount();
    const removed = trigger();
    await pointer(removed, "pointerover");
    await act(async () => {
      removed.remove();
      await settle();
    });
    expect(tip()).toBeNull();
    expect(removed.hasAttribute("aria-describedby")).toBe(false);
    const retained = trigger();
    retained.setAttribute("aria-describedby", "existing");
    await pointer(retained, "pointerover");
    await act(async () => root!.unmount());
    root = undefined;
    expect(tip()).toBeNull();
    expect(retained.getAttribute("aria-describedby")).toBe("existing");
    await pointer(retained, "pointerover");
    expect(tip()).toBeNull();
  });

  it.each(["scroll", "resize", "pointerdown"])(
    "dismisses and restores trigger ARIA on %s",
    async (type) => {
      await mount();
      const button = trigger();
      await pointer(button, "pointerover");
      await act(async () => {
        if (type === "scroll") button.dispatchEvent(new Event("scroll"));
        else if (type === "resize") window.dispatchEvent(new Event("resize"));
        else
          button.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true }),
          );
      });
      expect(tip()).toBeNull();
      expect(button.hasAttribute("aria-describedby")).toBe(false);
    },
  );

  it.each([
    {
      label: "left edge",
      x: 0,
      y: 80,
      size: { width: 220, height: 80 },
      left: 8,
      top: 116,
    },
    {
      label: "right edge",
      x: 780,
      y: 80,
      size: { width: 220, height: 80 },
      left: 572,
      top: 116,
    },
    {
      label: "bottom edge",
      x: 300,
      y: 550,
      size: { width: 220, height: 80 },
      left: 112,
      top: 466,
    },
  ])(
    "keeps long text visible at the $label using measured placement",
    async ({ x, y, size, left, top }) => {
      popupSize = size;
      await mount();
      const text = "Agent 试玩时显示窗口：".repeat(10);
      const button = trigger(x, y, text);
      await pointer(button, "pointerover");
      expect(tip()?.textContent).toBe(text);
      expect(tip()?.style.left).toBe(`${left}px`);
      expect(tip()?.style.top).toBe(`${top}px`);
      expect(tip()?.style.visibility).not.toBe("hidden");
    },
  );

  it("keeps tooltips outside the visible native preview without hiding it", async () => {
    await mount();
    popupSize = { width: 160, height: 60 };
    const frame = document.createElement("div");
    frame.setAttribute("data-native-preview-visible", "true");
    document.body.append(frame);
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(
      rect(300, 100, 400, 350),
    );
    const button = trigger(400, 50);
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
    await pointer(button, "pointerover");
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
    expect(tip()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(100);
    await act(async () => {
      frame.setAttribute("data-native-preview-visible", "false");
      await settle();
    });
    expect(tip()?.style.top).toBe("86px");
    await act(async () => {
      frame.setAttribute("data-native-preview-visible", "true");
      await settle();
    });
    expect(tip()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(100);
    await pointer(button, "pointerout", document.body);
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
    const unrelated = trigger(0, 50);
    await pointer(unrelated, "pointerover");
    expect(tip()).not.toBeNull();
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
  });
});
