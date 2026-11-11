import { isMeshyEndpoint, MESHY_DISABLED_MESSAGE } from "./disabled-media-providers.js";

const CONTROL_HOSTS = new Set(["llm.ziy.cc"]);
const REMOTE_BASE_PATHS = new Set(["/", "/v1", "/tripo/v3", "/doubao/api/v3"]);
const REMOTE_CONTROL_PATH = /^\/(?:v1\/(?:chat\/completions|responses(?:\/[^/]+)?|messages|models(?:\/[^/]+)?|images\/(?:generations|edits|tasks(?:\/[^/]+)?)|audio\/speech|videos(?:\/[^/]+(?:\/content)?)?|tasks\/[^/]+\/artifacts(?:\/[^/]+\/content)?)|tripo\/v3\/(?:generation|animations|models|mesh|files|tasks)(?:\/[^/]+)*|doubao\/api\/v3\/contents\/generations\/tasks(?:\/[^/]+)?)\/?$/;

export function isLoopbackModelHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}

export function parseProviderUrl(value: string | URL): URL {
  let target: URL;
  try { target = new URL(value); } catch { throw new Error("Invalid provider URL"); }
  if (target.username || target.password || target.hash || /[\\\u0000-\u0020]/.test(String(value))) throw new Error("Invalid provider URL");
  return target;
}

/** No environment override: adding a remote inference destination needs source review. */
export function providerControlUrl(value: string | URL, base = false): URL {
  const target = parseProviderUrl(value);
  if (isMeshyEndpoint(target.href)) throw new Error(MESHY_DISABLED_MESSAGE);
  const local = isLoopbackModelHost(target.hostname);
  if ((!local && (target.protocol !== "https:" || !CONTROL_HOSTS.has(target.hostname))) ||
      (local && !["http:", "https:"].includes(target.protocol)) || (base && target.search)) {
    throw new Error("This provider endpoint is unavailable in local secure mode. Use the reviewed Kunpo endpoint or an explicit loopback model service.");
  }
  if (/%(?:2f|5c|2e)/i.test(target.pathname)) throw new Error("Invalid provider URL path");
  if (!local && (base ? !REMOTE_BASE_PATHS.has(target.pathname.replace(/\/$/, "") || "/") : !REMOTE_CONTROL_PATH.test(target.pathname))) throw new Error("Invalid provider API path");
  if ([...target.searchParams.keys()].some((name) => /^(?:api[-_]?key|key|token|authorization)$/i.test(name))) throw new Error("Provider credentials must use headers");
  return target;
}
