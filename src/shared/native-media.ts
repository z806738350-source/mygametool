const assetId = "[A-Za-z0-9_-]{1,200}";
const libraryPath = new RegExp(`^/library/assets/${assetId}/content$`);
const workspacePath = new RegExp(`^/projects/${assetId}/files/raw$`);

/** Renderer eligibility and main-process validation share a contract; the digest grants no access. */
export function isPinnedNativeMediaUrl(
  value: string,
  runtime: { url: string },
): boolean {
  try {
    if (/[\\\x00-\x20]/.test(value)) return false;
    const url = new URL(value),
      base = new URL(runtime.url);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      base.username ||
      base.password
    )
      return false;
    if (url.origin !== base.origin || url.username || url.password || url.hash)
      return false;
    const query = url.searchParams;
    if (
      query.getAll("sha256").length !== 1 ||
      !/^[a-f0-9]{64}$/.test(query.get("sha256") ?? "")
    )
      return false;
    const library = libraryPath.test(url.pathname);
    const allowed = library
      ? ["sha256", "preview"]
      : workspacePath.test(url.pathname)
        ? ["sha256", "path"]
        : undefined;
    if (!allowed || [...query.keys()].some((key) => !allowed.includes(key)))
      return false;
    if (library)
      return (
        query.getAll("preview").length <= 1 &&
        (!query.has("preview") || query.get("preview") === "true")
      );
    if (query.getAll("path").length !== 1) return false;
    const file = query.get("path");
    return (
      !!file &&
      file.length <= 1000 &&
      !/[\\\x00-\x1f\x7f]/.test(file) &&
      !file
        .split("/")
        .some(
          (part) => !part || part.startsWith(".") || part === "node_modules",
        )
    );
  } catch {
    return false;
  }
}
