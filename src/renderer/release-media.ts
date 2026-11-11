/** Stop an old media source without clearing a replacement already set on the same element. */
export function releaseMedia(
  element: HTMLMediaElement | null,
  source: string | undefined,
): void {
  if (!element || !source || element.getAttribute("src") !== source) return;
  try {
    element.pause();
  } catch {
    /* The element may already be detached. */
  }
  element.removeAttribute("src");
  try {
    element.load();
  } catch {
    /* The element may already be detached. */
  }
}

/** Stop a pending image load without clearing a newer source. */
export function releaseImage(
  element: HTMLImageElement | null,
  source: string | undefined,
): void {
  if (element && source && element.getAttribute("src") === source)
    element.removeAttribute("src");
}
