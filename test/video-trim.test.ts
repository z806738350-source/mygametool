import { describe, expect, it, vi } from "vitest";
import {
  clampVideoTrim,
  isWholeVideo,
  MIN_TRIM_SECONDS,
  trimmedVideoType,
  videoFilmstrip,
} from "../src/renderer/video-trim.js";
import { formatTime } from "../src/renderer/video-trimmer.js";

describe("video trimming", () => {
  it("keeps WebM as WebM and saves everything else as MP4", () => {
    expect(trimmedVideoType("video/webm")).toEqual({
      mediaType: "video/webm",
      extension: "webm",
    });
    expect(trimmedVideoType("video/mp4")).toEqual({
      mediaType: "video/mp4",
      extension: "mp4",
    });
    expect(trimmedVideoType("video/quicktime")).toEqual({
      mediaType: "video/mp4",
      extension: "mp4",
    });
    expect(trimmedVideoType("")).toEqual({
      mediaType: "video/mp4",
      extension: "mp4",
    });
  });

  it("keeps a trim inside the video and at least the shortest length", () => {
    expect(clampVideoTrim({ start: -1, end: 12 }, 10)).toEqual({
      start: 0,
      end: 10,
    });
    expect(clampVideoTrim({ start: 4, end: 4 }, 10)).toEqual({
      start: 4 - MIN_TRIM_SECONDS,
      end: 4,
    });
    expect(clampVideoTrim({ start: 9.99, end: 30 }, 10)).toEqual({
      start: 10 - MIN_TRIM_SECONDS,
      end: 10,
    });
    expect(clampVideoTrim({ start: 0, end: 0 }, 10)).toEqual({
      start: 0,
      end: MIN_TRIM_SECONDS,
    });
  });

  it("knows when a trim keeps the whole video", () => {
    expect(isWholeVideo({ start: 0, end: 10 }, 10)).toBe(true);
    expect(isWholeVideo({ start: 0.001, end: 9.999 }, 10)).toBe(true);
    expect(isWholeVideo({ start: 0.5, end: 10 }, 10)).toBe(false);
    expect(isWholeVideo({ start: 0, end: 9 }, 10)).toBe(false);
  });

  it("formats times as minutes, seconds, and tenths", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(4.26)).toBe("0:04.3");
    expect(formatTime(5.399)).toBe("0:05.4");
    expect(formatTime(59.97)).toBe("1:00.0");
    expect(formatTime(64.2)).toBe("1:04.2");
    expect(formatTime(-1)).toBe("0:00.0");
  });

  it("disposes an in-progress filmstrip when cancelled", async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    const dispose = vi.fn(() => rejectRead?.(new Error("input disposed")));
    vi.doMock("mediabunny", () => ({
      ALL_FORMATS: [], BlobSource: class {}, CanvasSink: class {},
      Input: class {
        getPrimaryVideoTrack() { return new Promise((_resolve, reject) => { rejectRead = reject; }); }
        dispose() { dispose(); }
      },
    }));
    try {
      const controller = new AbortController();
      const pending = videoFilmstrip(new Blob(["fixture"]), 3, 44, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(rejectRead).toBeDefined());
      controller.abort();
      await rejected;
      expect(dispose).toHaveBeenCalledOnce();
    } finally { vi.doUnmock("mediabunny"); }
  });
});
