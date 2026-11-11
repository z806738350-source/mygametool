import { isLoopbackHostname } from "./local-debug.js";

/** Host headers are untrusted even when the socket only listens on loopback. */
export function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    return isLoopbackHostname(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

export function isAllowedLocalOrigin(origin: string | undefined, host: string | undefined, allowed: ReadonlySet<string> = new Set()): boolean {
  if (!isLoopbackHostHeader(host)) return false;
  if (!origin) return true;
  if (origin === "null") return allowed.has(origin);
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin && isLoopbackHostHeader(url.host) && (origin === `http://${host}` || allowed.has(origin));
  } catch { return false; }
}

/** Local games may run their own scripts, but external resources require a separate, explicit policy. */
export function localPreviewCsp(origin: string): string {
  const websocket = origin.replace(/^http:/, "ws:");
  return `default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' blob: ${websocket}; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'`;
}
