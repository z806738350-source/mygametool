import type { BlenderLiveViewLanguage } from "./blender-live-view-labels.js";

export interface BlenderWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  language?: BlenderLiveViewLanguage;
}

export interface BlenderWindowPlacement {
  bounds: BlenderWindowBounds;
  screenHeight: number;
  language?: BlenderLiveViewLanguage;
}

function isRectangle(value: unknown): value is BlenderWindowBounds {
  if (!value || typeof value !== "object") return false;
  const rect = value as BlenderWindowBounds;
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function intersect(
  a: BlenderWindowBounds,
  b: BlenderWindowBounds,
): BlenderWindowBounds {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** Electron rectangles are DIP; only renderer CSS coordinates need the page zoom factor. */
export function placeBlenderWindow(
  content: BlenderWindowBounds,
  workArea: BlenderWindowBounds,
  layout: unknown,
  zoom = 1,
): BlenderWindowBounds | undefined {
  if (
    !isRectangle(content) ||
    !isRectangle(workArea) ||
    !Number.isFinite(zoom) ||
    zoom <= 0
  )
    return;
  const panes = (layout && typeof layout === "object" ? layout : {}) as {
    canvas?: unknown;
    chat?: unknown;
    chatSide?: unknown;
  };
  const rightChat = panes.chatSide === "right";
  const screenRect = (rect: BlenderWindowBounds) =>
    intersect(
      {
        x: content.x + rect.x * zoom,
        y: content.y + rect.y * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom,
      },
      content,
    );
  const fit = (area: BlenderWindowBounds): BlenderWindowBounds | undefined => {
    // Leave room above the content for Blender's native title bar, and around its edges.
    const width = Math.min(900, Math.floor(area.width - 24)),
      height = Math.min(650, Math.floor(area.height - 44));
    if (width < 500 || height < 360) return;
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + 32 + (area.height - 44 - height) / 2),
      width,
      height,
    };
  };
  if (isRectangle(panes.canvas)) {
    const canvas = fit(intersect(screenRect(panes.canvas), workArea));
    if (canvas) return canvas;
  }
  const fallbackChatWidth = Math.min(430, content.width * 0.65);
  const chat = isRectangle(panes.chat)
    ? screenRect(panes.chat)
    : {
        ...content,
        width: fallbackChatWidth,
        x: content.x + (rightChat ? content.width - fallbackChatWidth : 0),
      };
  const left = intersect(workArea, {
    ...workArea,
    width: Math.max(0, chat.x - workArea.x),
  });
  const right = intersect(workArea, {
    ...workArea,
    x: chat.x + chat.width,
    width: Math.max(0, workArea.x + workArea.width - chat.x - chat.width),
  });
  const below = intersect(workArea, {
    ...workArea,
    y: chat.y + chat.height,
    height: Math.max(0, workArea.y + workArea.height - chat.y - chat.height),
  });
  const above = intersect(workArea, {
    ...workArea,
    height: Math.max(0, chat.y - workArea.y),
  });
  for (const area of [
    ...(rightChat ? [left, right] : [right, left]),
    below,
    above,
  ]) {
    const bounds = fit(area);
    if (bounds) return bounds;
  }
  // A collapsed canvas or very small display may leave no non-overlapping area.
  // Keep the fallback small, on the canvas side, without resizing the editor.
  if (workArea.width < 524 || workArea.height < 404) return;
  return {
    x: Math.round(
      rightChat ? workArea.x + 12 : workArea.x + workArea.width - 512,
    ),
    y: Math.round(workArea.y + 32),
    width: 500,
    height: 360,
  };
}

export function blenderWindowGeometry(
  value: unknown,
): BlenderWindowBounds | undefined {
  if (!value || typeof value !== "object") return;
  const placement = value as BlenderWindowPlacement;
  const bounds = placement.bounds;
  if (
    !isRectangle(bounds) ||
    !Number.isFinite(placement.screenHeight) ||
    placement.screenHeight <= 0 ||
    bounds.width < 500 ||
    bounds.width > 900 ||
    bounds.height < 360 ||
    bounds.height > 650
  )
    return;
  // macOS Blender CLI uses Cocoa points and the primary display's bottom-left origin.
  // Do not multiply by Retina scaleFactor or use the selected display's local height.
  return {
    x: Math.round(bounds.x),
    y: Math.round(placement.screenHeight - bounds.y - bounds.height),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    ...(placement.language === "en" || placement.language === "zh-CN"
      ? { language: placement.language }
      : {}),
  };
}
