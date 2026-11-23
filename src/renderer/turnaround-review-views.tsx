import { useEffect, useRef, useState } from "react";
import type { ApprovalRequestDetails } from "../shared/agent-runtimes.js";
import { getConversationImage } from "./api.js";
import { t } from "./i18n.js";
import { X } from "./icons.js";

type Review = NonNullable<ApprovalRequestDetails["turnaroundReview"]>;

export function TurnaroundReviewViews({ review, onReady }: {
  review: Review;
  onReady(id: string | undefined): void;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<number>();
  const dialog = useRef<HTMLDialogElement>(null);
  const loaded = useRef(new Set<number>());
  // The parent keys this component by the immutable review ID.
  const [entries] = useState(() => [
    ...(review.original ? [{ ...review.original, angle: "original" as const }] : []),
    ...review.views,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    const objects: string[] = [];
    loaded.current.clear();
    onReady(undefined);
    setUrls([]);
    setFailed(false);
    const load = async (source: string) => {
      const blob = await getConversationImage(source, controller.signal);
      controller.signal.throwIfAborted();
      const object = URL.createObjectURL(blob);
      objects.push(object);
      return object;
    };
    void Promise.all(entries.map(entry => load(entry.url))).then(loadedUrls => {
      if (!controller.signal.aborted) setUrls(loadedUrls);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      objects.forEach(object => URL.revokeObjectURL(object));
    };
  }, [entries, attempt, onReady]);

  useEffect(() => {
    if (expanded !== undefined) dialog.current?.showModal();
  }, [expanded]);
  function markLoaded(index: number) {
    loaded.current.add(index);
    if (!failed && review.views.length >= 3 && loaded.current.size === entries.length) onReady(review.reviewId);
  }
  function failPreview() {
    onReady(undefined);
    setFailed(true);
  }
  const angleLabel = (index: number) => t(`approval.turnaroundAngles.${entries[index].angle}`, { number: review.original ? index : index + 1 });
  const angleHint = (index: number) => {
    const angle = entries[index].angle;
    return angle === "additional" ? undefined : t(`approval.turnaroundCheck.${angle}`);
  };
  return <div className="turnaround-review">
    <p>{t("approval.turnaroundSummary")}</p>
    {failed ? <div className="turnaround-review-error">
      <span role="alert">{t("approval.turnaroundLoadFailed")}</span>
      <button type="button" className="settings-secondary-button" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</button>
    </div> : !urls.length ? <span role="status">{t("common.loading")}</span> : <div className="turnaround-review-grid">
      {urls.map((url, index) => <button type="button" className={entries[index].angle === "original" ? "turnaround-review-original" : undefined} key={index} onClick={() => setExpanded(index)} aria-haspopup="dialog"
        aria-label={t("approval.turnaroundInspect", { angle: angleLabel(index) })}>
        <img src={url} alt={angleLabel(index)} onLoad={() => markLoaded(index)} onError={failPreview} />
        <strong>{angleLabel(index)}</strong>
        {angleHint(index) && <small>{angleHint(index)}</small>}
      </button>)}
    </div>}
    {expanded !== undefined && urls[expanded] ? <dialog ref={dialog} className="turnaround-review-dialog" aria-label={angleLabel(expanded)}
      onClose={() => setExpanded(undefined)} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <header><strong>{angleLabel(expanded)}</strong><button type="button" className="icon-button" aria-label={t("common.close")} onClick={() => dialog.current?.close()}><X size={18} /></button></header>
      <div className="turnaround-review-comparison">
        {(review.original && expanded > 0 ? [0, expanded] : [expanded]).map(index =>
          <figure key={index}>
            <img src={urls[index]} alt={angleLabel(index)} />
            {review.original && expanded > 0 ? <figcaption>{angleLabel(index)}</figcaption> : null}
          </figure>)}
      </div>
      {angleHint(expanded) && <p>{angleHint(expanded)}</p>}
    </dialog> : null}
  </div>;
}
