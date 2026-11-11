/** Unit fixtures for retired Files protocols. This does not enable a Kunpo Files API. */
export const LEGACY_IMAGE_FILES_ORIGIN = "http://127.0.0.1:43199";
const ORIGINAL_ORIGINS = new Set(["https://api.openai.com", "https://api.deepseek.com"]);

export function legacyImageFilesRequest(input: string | URL | Request, init?: RequestInit): Request {
  const request = new Request(input, init), target = new URL(request.url);
  if (target.username || target.password) throw new Error("Invalid legacy protocol fixture URL");
  if (ORIGINAL_ORIGINS.has(target.origin)) return new Request(`${LEGACY_IMAGE_FILES_ORIGIN}${target.pathname}${target.search}`, request);
  if (target.origin !== LEGACY_IMAGE_FILES_ORIGIN && target.origin !== "http://127.0.0.1:43200") throw new Error("Legacy protocol fixtures require an explicit loopback transport");
  return request;
}

/** Keep raw protocol errors for legacy recovery unit tests; production guard tests run without this mock. */
export function legacyImageFilesFetch(delegate: typeof fetch): typeof fetch {
  return (input, init) => delegate(legacyImageFilesRequest(input, init));
}
