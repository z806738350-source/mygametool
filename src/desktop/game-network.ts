import type { WebContents } from "electron";

export function localGameRequestAllowed(value: string, origin: string | undefined, hostPage?: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    if (hostPage && url.protocol === "file:") return url.href.startsWith(new URL("./", hostPage).href);
    if (hostPage && url.origin === new URL(hostPage).origin && new URL(hostPage).protocol !== "file:") return true;
    if (url.protocol === "ws:") url.protocol = "http:";
    return !!origin && url.origin === origin && (url.protocol === "http:" || url.protocol === "https:");
  } catch { return false; }
}

/** Each caller owns a private in-memory session, so this policy cannot affect the author UI. */
export function restrictLocalGameNetwork(contents: WebContents, origin: () => string | undefined, hostPage?: string): void {
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !localGameRequestAllowed(details.url, origin(), hostPage) });
  });
}
