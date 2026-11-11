import { LoaderCircle } from "./icons.js";
import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n.js";

type ModelViewerElement = HTMLElement & { loaded?: boolean; availableAnimations?: string[]; paused?: boolean; pause?: () => void; play?: () => void };

type ModelViewerError = CustomEvent<{
  type?: "loadfailure" | "webglcontextlost";
  sourceError?: unknown;
}>;

type ModelViewerProgress = CustomEvent<{
  totalProgress?: number;
}>;

export function ModelPreview({ source, label, minHeight = 320, interactive = true, autoRotate = interactive, animate = interactive, rotationPerSecond, clipPicker = true, onError }: { source: string; label: string; minHeight?: number; interactive?: boolean; autoRotate?: boolean; animate?: boolean; rotationPerSecond?: string; clipPicker?: boolean; onError?: () => void }) {
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const [componentReady, setComponentReady] = useState(Boolean(customElements.get("model-viewer")));
  const [componentError, setComponentError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [modelError, setModelError] = useState<string>();
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState<string>();
  const [inViewport, setInViewport] = useState(typeof IntersectionObserver === "undefined");
  const [documentVisible, setDocumentVisible] = useState(typeof document === "undefined" || document.visibilityState !== "hidden");
  const motionActive = inViewport && documentVisible;
  const playing = animate && motionActive && clips.length > 0;

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!componentReady || !container) return;
    if (typeof IntersectionObserver === "undefined") { setInViewport(true); return; }
    setInViewport(false);
    const observer = new IntersectionObserver(([entry]) => { if (entry) setInViewport(entry.isIntersecting); });
    observer.observe(container);
    return () => observer.disconnect();
  }, [componentReady, source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!playing) {
      if (viewer.paused === false) viewer.pause?.();
    } else if (viewer.paused !== false) viewer.play?.();
  }, [componentReady, source, playing]);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    return () => {
      if (!viewer || viewer.getAttribute("src") !== source) return;
      try { viewer.pause?.(); } catch { /* The viewer may already be detached. */ }
      viewer.removeAttribute("src");
    };
  }, [componentReady, source]);

  useEffect(() => {
    if (componentReady) return;
    let active = true;
    void import("@google/model-viewer").then(() => {
      if (active) setComponentReady(true);
    }).catch(() => {
      if (active) setComponentError(true);
      if (active) errorCallback.current?.();
    });
    return () => { active = false; };
  }, [componentReady]);

  useEffect(() => {
    setLoaded(false);
    setProgress(0);
    setModelError(undefined);
    setClips([]);
    setClip(undefined);
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;

    const handleLoad = () => {
      setProgress(1);
      setLoaded(true);
      // Rigged models carry one clip per move; model-viewer only autoplays the first unless one is named.
      setClips([...(viewer.availableAnimations ?? [])]);
    };
    const handleProgress = (event: Event) => {
      const nextProgress = (event as ModelViewerProgress).detail?.totalProgress;
      if (typeof nextProgress === "number") setProgress(nextProgress);
    };
    const handleError = (event: Event) => {
      const detail = (event as ModelViewerError).detail;
      console.error("3D preview failed", detail?.sourceError);
      const type = detail?.type;
      setModelError(type === "webglcontextlost"
        ? t("modelPreview.contextLost")
        : t("modelPreview.displayFailed"));
      errorCallback.current?.();
    };

    viewer.addEventListener("load", handleLoad);
    viewer.addEventListener("progress", handleProgress);
    viewer.addEventListener("error", handleError);
    if (viewer.loaded) handleLoad();

    return () => {
      viewer.removeEventListener("load", handleLoad);
      viewer.removeEventListener("progress", handleProgress);
      viewer.removeEventListener("error", handleError);
    };
  }, [componentReady, source]);

  if (!componentReady) {
    return <span className={`model-preview-standalone${componentError ? " model-preview-error" : ""}`} role={componentError ? "alert" : undefined}>
      {!componentError ? <LoaderCircle className="spin" size={16} /> : null}
      {componentError ? t("modelPreview.viewerFailed") : t("modelPreview.loadingViewer")}
    </span>;
  }

  return (
    <div ref={containerRef} className="model-preview" style={{ minHeight: `${minHeight}px` }}>
      {createElement("model-viewer", {
        key: source,
        ref: (element: ModelViewerElement | null) => { viewerRef.current = element; },
        src: source,
        alt: label,
        loading: "eager",
        "camera-controls": interactive || undefined,
        "auto-rotate": autoRotate && motionActive || undefined,
        "rotation-per-second": rotationPerSecond,
        // Plays the first clip of animated models (e.g. rigged characters); static models are unaffected.
        autoplay: playing || undefined,
        "animation-name": clip,
        "shadow-intensity": "1",
        tabIndex: interactive ? undefined : -1,
        "aria-hidden": interactive ? undefined : true,
      })}
      {!loaded && !modelError ? (
        <span className="model-preview-state">
          <LoaderCircle className="spin" size={16} />
          {progress > 0 ? t("modelPreview.loadingProgress", { percent: Math.round(progress * 100) }) : t("modelPreview.loading")}
        </span>
      ) : null}
      {modelError ? <span className="model-preview-state model-preview-error" role="alert">{modelError}</span> : null}
      {clipPicker && clips.length > 1 ? (
        // nodrag/nowheel keep canvas nodes from treating the picker as a drag or zoom.
        <select
          className="model-preview-clips nodrag nowheel"
          aria-label={t("modelPreview.clip")}
          value={clip ?? clips[0]}
          onChange={(event) => setClip(event.target.value)}
        >
          {clips.map((name) => <option key={name} value={name}>{name.replace(/_/g, " ")}</option>)}
        </select>
      ) : null}
    </div>
  );
}
