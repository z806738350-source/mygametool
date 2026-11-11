import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, FileText, Film, Image as ImageIcon, Pause, Pencil, Play, X } from "./icons.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { t } from "./i18n.js";
import { useNearViewport } from "./asset-gallery.js";
import { releaseImage, releaseMedia } from "./release-media.js";

export interface CanvasNodeReferenceView {
  nodeId: string;
  name: string;
  type: "text" | "document" | "image";
  text?: string;
  assetId?: string;
}
export interface CanvasNodeReferencesRuntime {
  references: CanvasNodeReferenceView[];
  onRemoveReference(index: number): void;
}

export function CanvasNodeReferenceStrip({ references, onRemoveReference, busy = false }: CanvasNodeReferencesRuntime & { busy?: boolean }) {
  if (!references.length) return null;
  return <div className="story-media-references" aria-label={t("canvasNode.references")}>
    {references.map((reference, index) => <CanvasReferenceThumbnail key={reference.nodeId} reference={{ ...reference, label: reference.name }} caption={reference.name} disabled={busy} onRemove={() => onRemoveReference(index)} />)}
  </div>;
}

/** Shared by media generation nodes and the Text/Document reference strip. */
export function CanvasReferenceThumbnail({ reference, caption, disabled, removeDisabledReason, onReplace, onRemove }: {
  reference: { assetId?: string; name: string; label: string; type: "text" | "document" | "image" | "video" | "audio" | "model"; text?: string };
  caption?: string;
  disabled?: boolean;
  removeDisabledReason?: string;
  onReplace?(): void;
  onRemove(): void;
}) {
  const textual = reference.type === "text" || reference.type === "document";
  const [element, visible] = useNearViewport<HTMLDivElement>(true);
  const [requestedAudio, setRequestedAudio] = useState<string>();
  const audioRequested = reference.type === "audio" && reference.assetId !== undefined && requestedAudio === reference.assetId;
  const [playing, setPlaying] = useState(false);
  // A click can arrive before the first viewport observation.
  const enabled = reference.type === "audio" ? audioRequested : visible || playing;
  const preview = useWorkspaceAssetUrl(undefined, "", 0, enabled && ["image", "video", "audio"].includes(reference.type) ? reference.assetId : undefined);
  const audio = useRef<HTMLAudioElement>(null), video = useRef<HTMLVideoElement>(null), image = useRef<HTMLImageElement>(null);
  const [playFailed, setPlayFailed] = useState(false);
  useEffect(() => { setRequestedAudio(undefined); setPlaying(false); }, [reference.assetId, reference.type]);
  useLayoutEffect(() => {
    const audioElement = audio.current, videoElement = video.current, imageElement = image.current;
    return () => { releaseMedia(audioElement, preview.url); releaseMedia(videoElement, preview.url); releaseImage(imageElement, preview.url); };
  }, [reference.type, preview.url]);
  useEffect(() => { setPlaying(false); setPlayFailed(false); }, [preview.url]);
  function playAudio(element: HTMLAudioElement) {
    void element.play().catch(() => {
      if (audio.current === element && element.getAttribute("src") === preview.url) { setPlaying(false); setPlayFailed(true); }
    });
  }
  useEffect(() => {
    if (audioRequested && preview.url && audio.current) playAudio(audio.current);
  }, [audioRequested, preview.url]);
  useEffect(() => { if (!visible && !playing) setRequestedAudio(undefined); }, [visible, playing]);
  const title = preview.error ?? reference.text ?? `${reference.label}: ${reference.name}`;
  return <div ref={element} className={`story-media-reference${textual ? " story-text-reference" : ""}${preview.error ? " is-unavailable" : ""}`} title={title}>
    {preview.url && reference.type === "image" ? <img ref={image} src={preview.url} alt={reference.name} /> : null}
    {preview.url && reference.type === "video" ? <video ref={video} src={preview.url} muted playsInline preload="metadata" /> : null}
    {reference.type === "audio" ? <>
      {preview.url ? <audio ref={audio} src={preview.url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setPlayFailed(true); }} /> : null}
      <button className="canvas-reference-play nodrag nopan" type="button" disabled={playFailed || preview.loading || (disabled && !playing)}
        title={playFailed ? t("assetCanvas.referencePlaybackFailed") : t(playing ? "assetCanvas.pauseReference" : "assetCanvas.playReference", { name: reference.name })}
        aria-label={t(playing ? "assetCanvas.pauseReference" : "assetCanvas.playReference", { name: reference.name })}
        onClick={(event) => { event.stopPropagation(); if (!audioRequested) setRequestedAudio(reference.assetId); else if (playing) audio.current?.pause(); else if (audio.current) playAudio(audio.current); }}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
    </> : null}
    {textual ? <FileText size={19} /> : reference.type === "model" ? <Box size={18} /> : reference.type === "audio" ? null : !preview.url ? reference.type === "video" ? <Film size={18} /> : <ImageIcon size={18} /> : null}
    {caption ? <small>{caption}</small> : null}
    {onReplace ? <button className="canvas-view-replace" type="button" title={t("assetCanvas.replaceView", { view: reference.label })} aria-label={t("assetCanvas.replaceView", { view: reference.label })} disabled={disabled} onClick={onReplace}><Pencil size={11} /></button> : null}
    {preview.error ? <button className="canvas-reference-retry" type="button" title={t("canvasNode.recheckDetail", { name: reference.name, error: preview.error })} aria-label={t("canvasNode.recheck", { name: reference.name })} disabled={preview.loading} onClick={preview.retry}>↻</button> : null}
    <button type="button" title={removeDisabledReason ?? t("attachments.remove", { name: reference.name })} aria-label={t("attachments.remove", { name: reference.name })} aria-description={removeDisabledReason} disabled={disabled || Boolean(removeDisabledReason)} onClick={onRemove}><X size={11} /></button>
  </div>;
}
