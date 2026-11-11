// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const trimVideo = vi.fn();
const videoFilmstrip = vi.fn();
const uploadLibraryAsset = vi.fn();
vi.doMock(path.resolve("src/renderer/video-trim.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/video-trim.js")>()),
  trimVideo,
  videoFilmstrip,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  uploadLibraryAsset,
}));
const { VideoTrimmer, saveTrimmedVideo } =
  await import("../src/renderer/video-trimmer.js");

let root: Root;
let container: HTMLDivElement;
let paused: boolean;
let play: ReturnType<typeof vi.spyOn>;
const loadSource = vi.fn();
const save = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  paused = true;
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
    () => paused,
  );
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      paused = false;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  loadSource.mockResolvedValue(new Blob(["original"], { type: "video/mp4" }));
  vi.mocked(videoFilmstrip).mockResolvedValue(["data:image/jpeg;base64,AA=="]);
  vi.mocked(trimVideo).mockResolvedValue(
    new Blob(["trimmed"], { type: "video/mp4" }),
  );
  save.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountAsset() {
  await act(async () =>
    root.render(
      <VideoTrimmer
        url="blob:asset-trim"
        label="Original"
        loadSource={loadSource}
        onSave={save}
      />,
    ),
  );
  await act(async () => button("Trim video").click());
  return metadata();
}
async function metadata() {
  const video = document.querySelector("video")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 12 });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  return video;
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  )!;
}
async function key(element: Element, value: string, shiftKey = false) {
  await act(async () =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}
function handle(edge: "start" | "end") {
  return document.querySelector<HTMLElement>(
    `.video-trimmer-handle.is-${edge}`,
  )!;
}

it("waits for an explicit trim action before loading or decoding the source", async () => {
  await act(async () => root.render(<VideoTrimmer url="blob:asset-trim" label="Original" loadSource={loadSource} onSave={save} />));
  expect(document.querySelector("video")).not.toBeNull();
  expect(loadSource).not.toHaveBeenCalled();
  expect(videoFilmstrip).not.toHaveBeenCalled();
  await act(async () => button("Trim video").click());
  expect(loadSource).toHaveBeenCalledTimes(1);
  expect(loadSource.mock.calls[0]).toHaveLength(1);
  expect(videoFilmstrip).toHaveBeenCalledTimes(1);
});

it("binds a native preview's trim source to its inspected digest", async () => {
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  const sha256 = "a".repeat(64);
  await act(async () => root.render(<VideoTrimmer url={`http://127.0.0.1:43110/projects/p/files/raw?path=video.mp4&sha256=${sha256}`} label="Original" loadSource={loadSource} onSave={save} />));
  await act(async () => button("Trim video").click());
  expect(loadSource).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), sha256);
});

it("keeps Blob previews on the unbound source path in native mode", async () => {
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  await act(async () => root.render(<VideoTrimmer url="blob:asset-trim" label="Original" loadSource={loadSource} onSave={save} />));
  await act(async () => button("Trim video").click());
  expect(loadSource.mock.calls[0]).toHaveLength(1);
});

it.each(["", "sha256=bad", `sha256=${"a".repeat(64)}&sha256=${"b".repeat(64)}`])("rejects an invalid native video binding %s without loading or encoding", async (query) => {
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  await act(async () => root.render(<VideoTrimmer url={`http://127.0.0.1:43110/library/assets/a/content?${query}`} label="Original" loadSource={loadSource} onSave={save} />));
  await act(async () => button("Trim video").click());
  expect(loadSource).not.toHaveBeenCalled();
  expect(videoFilmstrip).not.toHaveBeenCalled(); expect(trimVideo).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("integrity information is unavailable");
});

it("surfaces a changed native source without encoding or saving it", async () => {
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  loadSource.mockRejectedValue(new Error("Media changed (409)"));
  const sha256 = "a".repeat(64);
  await act(async () => root.render(<VideoTrimmer url={`http://127.0.0.1:43110/library/assets/a/content?sha256=${sha256}`} label="Original" loadSource={loadSource} onSave={save} />));
  await act(async () => button("Trim video").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Media changed (409)");
  expect(trimVideo).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

it("does not cache a failed bound read and retries with the same digest on explicit save", async () => {
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  loadSource.mockRejectedValueOnce(new Error("Media changed (409)"));
  const sha256 = "a".repeat(64);
  await act(async () => root.render(<VideoTrimmer url={`http://127.0.0.1:43110/library/assets/a/content?sha256=${sha256}`} label="Original" loadSource={loadSource} onSave={save} />));
  await act(async () => button("Trim video").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Media changed (409)");
  await metadata(); await key(handle("start"), "ArrowRight");
  await act(async () => button("Save as new video").click());
  expect(loadSource).toHaveBeenCalledTimes(2);
  expect(loadSource.mock.calls.map((call) => call[1])).toEqual([sha256, sha256]);
  expect(trimVideo).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
});

it("drops the cached trim source when the native preview URL changes", async () => {
  vi.stubGlobal("ohMyGameDesktop", { nativeMedia: true });
  const first = "a".repeat(64), second = "b".repeat(64);
  const view = (sha256: string) => <VideoTrimmer url={`http://127.0.0.1:43110/library/assets/a/content?sha256=${sha256}`} label="Original" loadSource={loadSource} onSave={save} />;
  await act(async () => root.render(view(first)));
  await act(async () => button("Trim video").click());
  await act(async () => root.render(view(second)));
  expect(loadSource.mock.calls.map((call) => call[1])).toEqual([first, second]);
});

it("aborts a pending trim-source request when the editor unmounts", async () => {
  let signal: AbortSignal | undefined;
  loadSource.mockImplementationOnce((value: AbortSignal) => new Promise((_resolve, reject) => {
    signal = value;
    value.addEventListener("abort", () => reject(value.reason), { once: true });
  }));
  await act(async () => root.render(<VideoTrimmer url="blob:asset-trim" label="Original" loadSource={loadSource} onSave={save} />));
  await act(async () => button("Trim video").click());
  await act(async () => root.render(<div />));
  expect(signal?.aborted).toBe(true);
  expect(videoFilmstrip).not.toHaveBeenCalled();
});

it("stops both the ordinary player and the trim player when they are removed", async () => {
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  await act(async () => root.render(<VideoTrimmer url="http://127.0.0.1/media" label="Original" loadSource={loadSource} onSave={save} />));
  const original = container.querySelector("video")!;
  await act(async () => button("Trim video").click());
  expect(original.getAttribute("src")).toBeNull();
  const editor = container.querySelector("video")!;
  await act(async () => root.render(<div />));
  expect(editor.getAttribute("src")).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

it.each([
  ".video-trimmer-track",
  ".video-trimmer-handle.is-start",
  ".video-trimmer-handle.is-end",
])("toggles playback exactly once for Space on %s", async (selector) => {
  await mountAsset();
  await key(document.querySelector(selector)!, " ");
  expect(play).toHaveBeenCalledTimes(1);
  expect(paused).toBe(false);
  await key(document.querySelector(selector)!, " ");
  expect(paused).toBe(true);
});

it("uses the Asset Studio filmstrip and handles, without encoding until Save", async () => {
  await mountAsset();
  expect(document.querySelectorAll(".video-trimmer-frames img")).toHaveLength(
    1,
  );
  expect(button("Save as new video").disabled).toBe(true);
  await key(handle("start"), "ArrowRight");
  await key(handle("end"), "ArrowLeft", true);
  expect(handle("start").getAttribute("aria-valuenow")).toBe("1");
  expect(handle("end").getAttribute("aria-valuenow")).toBe("11.9");
  expect(trimVideo).not.toHaveBeenCalled();
  await act(async () => button("Save as new video").click());
  expect(trimVideo).toHaveBeenCalledExactlyOnceWith(
    expect.any(Blob),
    { start: 1, end: 11.9 },
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }),
  );
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), {
    start: 1,
    end: 11.9,
  });
  expect(loadSource).toHaveBeenCalledTimes(1);
});

it("resets as a draft without saving or encoding", async () => {
  const video = await mountAsset();
  await key(handle("start"), "ArrowRight");
  await act(async () => button("Reset").click());
  expect(handle("start").getAttribute("aria-valuenow")).toBe("0");
  expect(video.currentTime).toBe(0);
  expect(trimVideo).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("stops preview playback at the selected out point", async () => {
  let tick: FrameRequestCallback | undefined;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
    (callback) => {
      tick = callback;
      return 1;
    },
  );
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const video = await mountAsset();
  await key(handle("start"), "ArrowRight");
  await key(handle("end"), "ArrowLeft");
  await act(async () =>
    document.querySelector<HTMLButtonElement>(".video-trimmer-play")!.click(),
  );
  video.currentTime = 11.5;
  await act(async () => tick!(0));
  expect(paused).toBe(true);
  expect(video.currentTime).toBe(11);
  expect(save).not.toHaveBeenCalled();
});

it("disables range edits while encoding and can cancel without saving", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(trimVideo).mockImplementationOnce(
    (_blob, _trim, options) =>
      new Promise((_resolve, reject) => {
        signal = options!.signal;
        signal!.addEventListener("abort", () =>
          reject(new DOMException("cancelled", "AbortError")),
        );
      }),
  );
  await mountAsset();
  await key(handle("start"), "ArrowRight");
  await act(async () => button("Save as new video").click());
  await key(handle("start"), "ArrowRight");
  expect(handle("start").getAttribute("aria-valuenow")).toBe("1");
  expect(handle("start").getAttribute("aria-disabled")).toBe("true");
  await act(async () => button("Cancel").click());
  expect(signal?.aborted).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(button("Save as new video").disabled).toBe(false);
});

it("reports encode failures and preserves the range for retry", async () => {
  vi.mocked(trimVideo).mockRejectedValueOnce(new Error("Encoder unavailable"));
  await mountAsset();
  await key(handle("start"), "ArrowRight");
  await act(async () => button("Save as new video").click());
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "Encoder unavailable",
  );
  expect(handle("start").getAttribute("aria-valuenow")).toBe("1");
  expect(save).not.toHaveBeenCalled();
});

it("uploads a new asset with derivation, leaving the original untouched", async () => {
  const video = new Blob(["trimmed"], { type: "video/mp4" });
  await saveTrimmedVideo(
    video,
    { start: 2.2, end: 5.4 },
    { name: "opening.mp4", libraryAssetId: "original" },
  );
  expect(uploadLibraryAsset).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: "opening (trimmed).mp4",
      type: "video/mp4",
    }),
    "video/mp4",
    3.2,
    undefined,
    { assetId: "original", trim: { start: 2.2, end: 5.4 } },
  );
});
