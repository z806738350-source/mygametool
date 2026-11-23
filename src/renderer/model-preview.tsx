import { LoaderCircle, Pause, Play } from "./icons.js";
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n.js";

type ModelViewerElement = HTMLElement & { src?: string | null; loaded?: boolean; availableAnimations?: string[]; animationName?: string; currentTime?: number; updateComplete?: Promise<unknown>; paused?: boolean; pause?: () => void; play?: () => void };

export interface ModelPlaybackState { playing: boolean; clip?: string; time?: number }

// The node stays mounted when its offscreen model is released; retain only that node's current asset.
export function useModelPlayback(assetId: string | undefined) {
  const [saved, setSaved] = useState<{ assetId?: string; state: ModelPlaybackState }>({ assetId, state: { playing: true } });
  if (saved.assetId !== assetId) setSaved({ assetId, state: { playing: true } });
  const save = useCallback((state: ModelPlaybackState) => setSaved((current) => current.assetId === assetId ? { assetId, state } : current), [assetId]);
  return [saved.state, save] as const;
}

type ModelViewerError = CustomEvent<{
  type?: "loadfailure" | "webglcontextlost";
  sourceError?: unknown;
}>;

type ModelViewerProgress = CustomEvent<{
  totalProgress?: number;
}>;

export function ModelPreview({ source, label, minHeight = 320, interactive = true, autoRotate = false, animate = interactive, rotationPerSecond, clipPicker = true, playback, onPlaybackChange, onLoad, onError }: { source: string; label: string; minHeight?: number; interactive?: boolean; autoRotate?: boolean; animate?: boolean; rotationPerSecond?: string; clipPicker?: boolean; playback?: ModelPlaybackState; onPlaybackChange?: (state: ModelPlaybackState) => void; onLoad?: () => void; onError?: () => void }) {
  const loadCallback = useRef(onLoad); loadCallback.current = onLoad;
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const [componentReady, setComponentReady] = useState(Boolean(customElements.get("model-viewer")));
  const [componentError, setComponentError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [modelError, setModelError] = useState<string>();
  const [clips, setClips] = useState<string[]>([]);
  const [localPlayback, setLocalPlayback] = useState<ModelPlaybackState>({ playing: animate });
  const state = playback ?? localPlayback;
  const playbackRef = useRef(state); playbackRef.current = state;
  const { clip, playing: playRequested } = state;
  const updatePlayback = onPlaybackChange ?? setLocalPlayback;
  const [inViewport, setInViewport] = useState(typeof IntersectionObserver === "undefined");
  const [documentVisible, setDocumentVisible] = useState(typeof document === "undefined" || document.visibilityState !== "hidden");
  const motionActive = inViewport && documentVisible;
  const playing = playRequested && motionActive && clips.length > 0;

  useEffect(() => setLocalPlayback({ playing: animate }), [source, animate]);

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
      // React assigns custom-element properties; model-viewer's src does not reflect to its attribute.
      if (!viewer || ("src" in viewer ? viewer.src : viewer.getAttribute("src")) !== source) return;
      try { viewer.pause?.(); } catch { /* The viewer may already be detached. */ }
      if (viewer.loaded && Number.isFinite(viewer.currentTime)) onPlaybackChange?.({ ...playbackRef.current, time: viewer.currentTime });
      if ("src" in viewer) viewer.src = null;
      viewer.removeAttribute("src");
    };
  }, [componentReady, source, onPlaybackChange]);

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
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;
    let active = true;

    const handleLoad = () => {
      setProgress(1);
      setLoaded(true);
      loadCallback.current?.();
      // Rigged models carry one clip per move; model-viewer only autoplays the first unless one is named.
      setClips([...(viewer.availableAnimations ?? [])]);
      const saved = playbackRef.current;
      if (saved.time !== undefined) {
        if (saved.clip) viewer.animationName = saved.clip;
        // model-viewer applies animation-name asynchronously and resets the clip before seeking.
        void Promise.resolve(viewer.updateComplete).then(() => {
          if (active && playbackRef.current.clip === saved.clip && ("src" in viewer ? viewer.src : viewer.getAttribute("src")) === source) viewer.currentTime = saved.time;
        });
      }
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
      active = false;
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
    <div ref={containerRef} className={`model-preview${interactive ? " model-preview-interactive nodrag nopan nowheel nokey" : ""}`} style={{ minHeight: `${minHeight}px` }}
      onPointerDown={interactive ? (event) => event.stopPropagation() : undefined}
      onDoubleClick={interactive ? (event) => event.stopPropagation() : undefined}>
      {createElement("model-viewer", {
        key: source,
        ref: (element: ModelViewerElement | null) => { viewerRef.current = element; },
        src: source,
        alt: label,
        loading: "eager",
        "camera-controls": interactive || undefined,
        // The default interaction hint wiggles the camera even when auto-rotate is off.
        "interaction-prompt": "none",
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
      {!modelError && clips.length > 0 && (interactive || clipPicker && clips.length > 1) ? <div className="model-preview-controls nodrag nopan nowheel nokey" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        {interactive ? <button type="button" aria-label={t(playRequested ? "modelPreview.pause" : "modelPreview.play")} title={t(playRequested ? "modelPreview.pause" : "modelPreview.play")} onClick={() => {
          const viewer = viewerRef.current;
          if (playRequested) viewer?.pause?.();
          updatePlayback({ ...state, playing: !playRequested, ...(Number.isFinite(viewer?.currentTime) ? { time: viewer!.currentTime } : {}) });
        }}>
          {playRequested ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button> : null}
        {clipPicker && clips.length > 1 ? <select
            className="model-preview-clips"
            aria-label={t("modelPreview.clip")}
            value={clip ?? clips[0]}
            onChange={(event) => updatePlayback({ ...state, clip: event.target.value, time: 0 })}
          >
            {clips.map((name) => <option key={name} value={name}>{name.replace(/_/g, " ")}</option>)}
          </select> : null}
      </div> : null}
    </div>
  );
}
