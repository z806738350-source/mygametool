// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AssetMedia, useNearViewport } from "../src/renderer/asset-gallery.js";
import { CanvasReferenceThumbnail } from "../src/renderer/canvas-node-references.js";
import * as api from "../src/renderer/api.js";
import { t } from "../src/renderer/i18n.js";
import { releaseMedia } from "../src/renderer/release-media.js";
import { ModelPreview } from "../src/renderer/model-preview.js";

it("models enter, exit and playback pin without unmounting the node", async () => {
  let notify!: (visible: boolean) => void;
  let observed!: Element;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = (visible) =>
        callback(
          [
            {
              isIntersecting: visible,
              target: observed,
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
    }
    observe(element: Element) {
      observed = element;
    }
    disconnect() {}
  }
  const load = vi.fn(),
    release = vi.fn();
  function SyntheticNode({
    selected = false,
    playing = false,
  }: {
    selected?: boolean;
    playing?: boolean;
  }) {
    const [element, visible] = useNearViewport<HTMLDivElement>(true);
    const active = visible || selected || playing;
    useEffect(() => {
      if (!active) return;
      load();
      return release;
    }, [active]);
    return (
      <div ref={element} data-node="retained">
        {active ? "loaded" : "placeholder"}
      </div>
    );
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", Observer);
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(<SyntheticNode />));
    expect(load).not.toHaveBeenCalled();
    await act(async () => notify(true));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<SyntheticNode playing />));
    await act(async () => notify(false));
    expect(release).not.toHaveBeenCalled();
    await act(async () => root.render(<SyntheticNode />));
    expect(release).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-node]")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("loads a reference audio only after play and keeps it while playing offscreen", async () => {
  let notify!: (visible: boolean) => void;
  let observed!: Element;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = (visible) =>
        callback(
          [
            {
              isIntersecting: visible,
              target: observed,
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
    }
    observe(element: Element) {
      observed = element;
    }
    disconnect() {}
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", Observer);
  const read = vi
    .spyOn(api, "getLibraryAsset")
    .mockResolvedValue(new Blob(["audio"], { type: "audio/mpeg" }));
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("pause"));
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <CanvasReferenceThumbnail
          reference={{
            assetId: "sound",
            name: "Sound",
            label: "Sound",
            type: "audio",
          }}
          onRemove={() => {}}
        />,
      ),
    );
    await act(async () => notify(true));
    expect(read).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".canvas-reference-play")!
        .click(),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    await act(async () => notify(false));
    expect(revoke).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLAudioElement>("audio")!
        .dispatchEvent(new Event("pause")),
    );
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:audio");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});

it("stops a viewer's native media on close without clearing a newer source", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(() => {});
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AssetMedia
          type="video"
          url="http://127.0.0.1/media/one"
          label="Video"
        />,
      ),
    );
    const video = container.querySelector("video")!;
    releaseMedia(video, "http://127.0.0.1/media/old");
    expect(video.getAttribute("src")).toBe("http://127.0.0.1/media/one");
    expect(pause).not.toHaveBeenCalled();
    await act(async () => root.render(<div />));
    expect(video.getAttribute("src")).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});

it("does not animate thumbnail models and removes their source on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pause = vi.fn();
  if (!customElements.get("model-viewer"))
    customElements.define(
      "model-viewer",
      class extends HTMLElement {
        pause() {
          pause();
        }
      },
    );
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ModelPreview source="blob:model" label="Model" interactive={false} />,
      ),
    );
    const viewer = container.querySelector("model-viewer")!;
    expect(viewer.hasAttribute("auto-rotate")).toBe(false);
    expect(viewer.hasAttribute("autoplay")).toBe(false);
    await act(async () => root.render(<div />));
    expect(viewer.getAttribute("src")).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([false, true])("rotates a visible canvas model independently of controls and pauses/resumes its saved clip (animated=%s)", async animated => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let notify!: (visible: boolean) => void;
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect = disconnect;
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  if (!customElements.get("model-viewer")) customElements.define("model-viewer", class extends HTMLElement {});
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<ModelPreview source="blob:canvas-model" label="Canvas model" interactive={false} autoRotate animate rotationPerSecond="10deg" />));
    const viewer = container.querySelector("model-viewer")! as HTMLElement & { paused: boolean; currentTime: number; pause: () => void; play: () => void };
    const pause = vi.fn(() => { viewer.paused = true; }), play = vi.fn(() => { viewer.paused = false; });
    Object.assign(viewer, { pause, play, paused: true, currentTime: 1.25, availableAnimations: animated ? ["Walk", "Run"] : [] });
    await act(async () => viewer.dispatchEvent(new Event("load")));
    expect(viewer.hasAttribute("auto-rotate")).toBe(false); expect(viewer.hasAttribute("autoplay")).toBe(false); expect(play).not.toHaveBeenCalled();
    await act(async () => notify(true));
    expect(viewer.hasAttribute("auto-rotate")).toBe(true); expect(viewer.getAttribute("rotation-per-second")).toBe("10deg");
    expect(viewer.hasAttribute("camera-controls")).toBe(false); expect(viewer.hasAttribute("autoplay")).toBe(animated);
    if (animated) {
      expect(play).toHaveBeenCalledOnce();
      const select = container.querySelector("select")!;
      await act(async () => { select.value = "Run"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(viewer.getAttribute("animation-name")).toBe("Run");
    } else expect(play).not.toHaveBeenCalled();
    await act(async () => notify(false));
    expect(viewer.hasAttribute("auto-rotate")).toBe(false); expect(viewer.hasAttribute("autoplay")).toBe(false);
    expect(viewer.getAttribute("src")).toBe("blob:canvas-model");
    if (animated) expect(pause).toHaveBeenCalledOnce(); else expect(pause).not.toHaveBeenCalled();
    await act(async () => notify(true));
    expect(viewer.hasAttribute("auto-rotate")).toBe(true); expect(viewer.currentTime).toBe(1.25);
    if (animated) { expect(play).toHaveBeenCalledTimes(2); expect(viewer.getAttribute("animation-name")).toBe("Run"); }
    await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(viewer.hasAttribute("auto-rotate")).toBe(false); expect(viewer.hasAttribute("autoplay")).toBe(false);
    await act(async () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(viewer.hasAttribute("auto-rotate")).toBe(true); expect(viewer.currentTime).toBe(1.25);
    if (animated) expect(play).toHaveBeenCalledTimes(3);
    await act(async () => root.render(null));
    expect(viewer.getAttribute("src")).toBeNull(); expect(disconnect).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("preserves interactive camera controls and the viewer's interaction rotation delay", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("IntersectionObserver", undefined);
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<ModelPreview source="blob:interactive" label="Interactive model" />));
    const viewer = container.querySelector("model-viewer")!;
    expect(viewer.hasAttribute("camera-controls")).toBe(true); expect(viewer.hasAttribute("auto-rotate")).toBe(true);
    expect(viewer.hasAttribute("auto-rotate-delay")).toBe(false);
    expect(viewer.hasAttribute("rotation-per-second")).toBe(false);
    await act(async () => viewer.dispatchEvent(new CustomEvent("camera-change", { detail: { source: "user-interaction" } })));
    expect(viewer.getAttribute("src")).toBe("blob:interactive");
  } finally { await act(async () => root.unmount()); }
});

function audioThumbnailFixture() {
  let notify!: (visible: boolean) => void;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = (visible) =>
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", Observer);
  const read = vi
    .spyOn(api, "getLibraryAsset")
    .mockResolvedValue(new Blob(["synthetic audio"], { type: "audio/wav" }));
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:requested-audio");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("pause"));
    });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const container = document.createElement("div"),
    root = createRoot(container);
  return {
    read,
    create,
    revoke,
    play,
    pause,
    container,
    render: (assetId = "sound") =>
      act(async () =>
        root.render(
          <CanvasReferenceThumbnail
            reference={{
              assetId,
              name: assetId,
              label: assetId,
              type: "audio",
            }}
            onRemove={() => {}}
          />,
        ),
      ),
    visible: (value: boolean) => act(async () => notify(value)),
    click: () =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>(".canvas-reference-play")!
          .click(),
      ),
    close: async () => {
      await act(async () => root.unmount());
    },
  };
}

it("starts requested reference audio before the first viewport observation arrives", async () => {
  const f = audioThumbnailFixture();
  try {
    await f.render();
    expect(f.read).not.toHaveBeenCalled();
    await f.click();
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.play).toHaveBeenCalledOnce();
    expect(f.container.querySelector("audio")?.getAttribute("src")).toBe(
      "blob:requested-audio",
    );
  } finally {
    await f.close();
  }
  expect(f.pause).toHaveBeenCalled();
  expect(f.revoke).toHaveBeenCalledWith("blob:requested-audio");
});

it("aborts pending reference audio when it leaves the viewport and ignores its late result", async () => {
  const f = audioThumbnailFixture();
  let finish!: (blob: Blob) => void;
  f.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await f.render();
    await f.visible(true);
    await f.click();
    const signal = f.read.mock.calls[0]![2]!;
    expect(signal.aborted).toBe(false);
    await f.visible(false);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(new Blob(["late audio"])));
    expect(f.create).not.toHaveBeenCalled();
    expect(f.play).not.toHaveBeenCalled();
    expect(f.container.querySelector("audio")).toBeNull();
  } finally {
    await f.close();
  }
});

it("does not carry a reference audio play request to a different reference or consume a stale read", async () => {
  const f = audioThumbnailFixture();
  let finishOld!: (blob: Blob) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  try {
    await f.render("old");
    await f.visible(true);
    await f.click();
    const oldSignal = f.read.mock.calls[0]![2]!;
    await f.render("new");
    expect(oldSignal.aborted).toBe(true);
    expect(f.read).toHaveBeenCalledOnce();
    await act(async () => finishOld(new Blob(["old audio"])));
    expect(f.create).not.toHaveBeenCalled();
    expect(f.play).not.toHaveBeenCalled();
    await f.click();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.read.mock.calls[1]![0]).toBe("new");
    expect(f.play).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
  expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:requested-audio");
});

it("shows a failed initial reference audio play without automatically retrying it", async () => {
  const f = audioThumbnailFixture();
  f.play.mockRejectedValue(new Error("Synthetic playback rejection"));
  try {
    await f.render();
    await f.visible(true);
    await f.click();
    expect(f.play).toHaveBeenCalledOnce();
    const button = f.container.querySelector<HTMLButtonElement>(
      ".canvas-reference-play",
    )!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(t("assetCanvas.referencePlaybackFailed"));
    await f.click();
    expect(f.play).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("ignores a late reference audio play rejection after an explicit different reference starts", async () => {
  const f = audioThumbnailFixture();
  let rejectOld!: (cause: Error) => void;
  f.create
    .mockReturnValueOnce("blob:old-audio")
    .mockReturnValueOnce("blob:new-audio");
  f.play.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  try {
    await f.render("old");
    await f.visible(true);
    await f.click();
    expect(f.play).toHaveBeenCalledOnce();
    await f.render("new");
    expect(f.read).toHaveBeenCalledOnce();
    await f.click();
    expect(f.play).toHaveBeenCalledTimes(2);
    await act(async () =>
      rejectOld(new Error("Old reference failed after replacement")),
    );
    const button = f.container.querySelector<HTMLButtonElement>(
      ".canvas-reference-play",
    )!;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe(t("assetCanvas.pauseReference", { name: "new" }));
    expect(f.container.querySelector("audio")?.getAttribute("src")).toBe(
      "blob:new-audio",
    );
    expect(f.play).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
  expect(f.revoke).toHaveBeenCalledWith("blob:old-audio");
  expect(f.revoke).toHaveBeenCalledWith("blob:new-audio");
});
