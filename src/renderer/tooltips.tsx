import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuPlacement } from "./popover-placement.js";
import { desktopPreviewLayout } from "./desktop-game-preview.js";

type TooltipPosition = {
  top: number;
  left: number;
  maxWidth?: number;
  maxHeight?: number;
};
type Area = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Area, b: Area) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Native views cover DOM, so keep hints in the editor space around them. */
function tooltipPosition(anchor: DOMRect, popup: DOMRect): TooltipPosition {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const preferred = menuPlacement(anchor, popup, viewport);
  const native = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-native-preview-visible="true"]',
    ),
  ]
    .map((element) => desktopPreviewLayout(element, true))
    .filter((layout) => layout.visible);
  if (!native.length) return preferred;
  let areas: Area[] = [
    { left: 8, top: 8, right: viewport.width - 8, bottom: viewport.height - 8 },
  ];
  for (const { bounds } of native) {
    const blocked = {
      left: bounds.x - 4,
      top: bounds.y - 4,
      right: bounds.x + bounds.width + 4,
      bottom: bounds.y + bounds.height + 4,
    };
    areas = areas.flatMap((area) => {
      if (!overlaps(area, blocked)) return [area];
      const top = Math.max(area.top, blocked.top),
        bottom = Math.min(area.bottom, blocked.bottom);
      return [
        { ...area, bottom: Math.min(area.bottom, blocked.top) },
        { ...area, top: Math.max(area.top, blocked.bottom) },
        {
          left: area.left,
          right: Math.min(area.right, blocked.left),
          top,
          bottom,
        },
        {
          left: Math.max(area.left, blocked.right),
          right: area.right,
          top,
          bottom,
        },
      ].filter((free) => free.right > free.left && free.bottom > free.top);
    });
  }
  const fitting = areas.filter(
    (area) =>
      area.right - area.left >= popup.width &&
      area.bottom - area.top >= popup.height,
  );
  if (!fitting.length) {
    // ponytail: Constrain oversized hints to free editor space; full help belongs in a dialog.
    const area = areas.sort(
      (a, b) =>
        (b.right - b.left) * (b.bottom - b.top) -
        (a.right - a.left) * (a.bottom - a.top),
    )[0];
    return area
      ? {
          left: area.left,
          top: area.top,
          maxWidth: area.right - area.left,
          maxHeight: area.bottom - area.top,
        }
      : preferred;
  }
  const candidates = [
    preferred,
    {
      left: anchor.left - popup.width - 4,
      top: anchor.top + (anchor.height - popup.height) / 2,
    },
    {
      left: anchor.right + 4,
      top: anchor.top + (anchor.height - popup.height) / 2,
    },
    menuPlacement(anchor, popup, viewport, "end", "above"),
  ];
  const positions = fitting.flatMap((area) =>
    candidates.map((candidate) => ({
      left: Math.max(
        area.left,
        Math.min(candidate.left, area.right - popup.width),
      ),
      top: Math.max(
        area.top,
        Math.min(candidate.top, area.bottom - popup.height),
      ),
      maxWidth: Math.min(240, area.right - area.left),
      maxHeight: area.bottom - area.top,
    })),
  );
  const clear = positions.filter(
    (position) =>
      !overlaps(
        {
          ...position,
          right: position.left + popup.width,
          bottom: position.top + popup.height,
        },
        anchor,
      ),
  );
  const distance = (position: TooltipPosition) =>
    (position.left + popup.width / 2 - (anchor.left + anchor.width / 2)) ** 2 +
    (position.top + popup.height / 2 - (anchor.top + anchor.height / 2)) ** 2;
  return (clear.length ? clear : positions).sort(
    (a, b) => distance(a) - distance(b),
  )[0]!;
}

export function Tooltips() {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [text, setText] = useState("");
  const [position, setPosition] = useState<{
    anchor: HTMLElement;
    text: string;
    value: TooltipPosition;
  }>();
  const popup = useRef<HTMLDivElement>(null);
  const reposition = useRef<() => void>(() => {});
  const id = `tooltip-${useId()}`;

  useEffect(() => {
    let hovered: HTMLElement | undefined;
    let focused: HTMLElement | undefined;
    const target = (node: EventTarget | null) =>
      node instanceof Element
        ? (node.closest<HTMLElement>("[data-tooltip]") ?? undefined)
        : undefined;
    const select = () => setAnchor(hovered ?? focused);
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovered = target(event.target);
      select();
    };
    const out = (event: PointerEvent) => {
      if (
        hovered &&
        event.relatedTarget instanceof Node &&
        hovered.contains(event.relatedTarget)
      )
        return;
      hovered = undefined;
      select();
    };
    const focus = (event: FocusEvent) => {
      const element = target(event.target);
      focused = element?.matches(":focus-visible") ? element : undefined;
      select();
    };
    const blur = () => {
      focused = undefined;
      select();
    };
    const dismiss = () => {
      hovered = focused = undefined;
      setAnchor(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, []);

  useLayoutEffect(() => {
    setPosition(undefined);
    if (!anchor) {
      setText("");
      return;
    }
    const read = () => {
      if (!anchor.isConnected || !anchor.dataset.tooltip) {
        setAnchor(undefined);
        return;
      }
      setText(anchor.dataset.tooltip);
      reposition.current();
    };
    read();
    const description =
      anchor.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ??
      [];
    anchor.setAttribute("aria-describedby", [...description, id].join(" "));
    const mutations = new MutationObserver(read);
    mutations.observe(anchor, {
      attributes: true,
      attributeFilter: ["data-tooltip"],
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-native-preview-visible"],
    });
    return () => {
      mutations.disconnect();
      const remaining =
        anchor
          .getAttribute("aria-describedby")
          ?.split(/\s+/)
          .filter((value) => value && value !== id) ?? [];
      if (remaining.length)
        anchor.setAttribute("aria-describedby", remaining.join(" "));
      else anchor.removeAttribute("aria-describedby");
    };
  }, [anchor, id]);

  useLayoutEffect(() => {
    const update = () => {
      if (!anchor?.isConnected || !popup.current || !text) return;
      const next = tooltipPosition(
        anchor.getBoundingClientRect(),
        popup.current.getBoundingClientRect(),
      );
      setPosition((previous) =>
        previous?.anchor === anchor &&
        previous.text === text &&
        previous.value.top === next.top &&
        previous.value.left === next.left &&
        previous.value.maxWidth === next.maxWidth &&
        previous.value.maxHeight === next.maxHeight
          ? previous
          : { anchor, text, value: next },
      );
    };
    reposition.current = update;
    update();
    return () => {
      reposition.current = () => {};
    };
  }, [anchor, text]);

  return anchor && text
    ? createPortal(
        <div
          ref={popup}
          id={id}
          className="app-tooltip"
          role="tooltip"
          style={
            position?.anchor === anchor && position.text === text
              ? position.value
              : { top: 0, left: 0, visibility: "hidden" }
          }
        >
          {text}
        </div>,
        document.body,
      )
    : null;
}
