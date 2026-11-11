/** Remote image URLs never load automatically in the local authoring UI. */
export function isLocalImageSource(src?: string): boolean {
  if (!src) return false;
  const value = src.trim();
  if (!value) return false;
  if (/^(?:blob:|data:image\/(?:png|jpe?g|webp|gif|avif|bmp)[;,])/i.test(value)) return true;
  return !/^[a-z][a-z\d+.-]*:|^\/\//i.test(value) && !value.includes("\\");
}
