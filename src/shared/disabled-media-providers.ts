/** Local product policy. Configuration, credentials and model arguments cannot enable Meshy. */
export const MESHY_DISABLED_MESSAGE = "Meshy is disabled in this edition. Select Kunpo Tripo for supported 3D models and animation. Existing local assets and task records are retained; Meshy requests and remote recovery are unavailable.";

export function isMeshyIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^meshy(?:$|[-_/:.\s]|\d)/i.test(value.trim());
}

export function isMeshyEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return host === "meshy.ai" || host.endsWith(".meshy.ai");
  } catch { return false; }
}

export function isMeshyModelReference(value: { provider?: unknown; id?: unknown; protocol?: unknown } | undefined): boolean {
  return !!value && (isMeshyIdentifier(value.provider) || isMeshyIdentifier(value.id) || value.protocol === "meshy");
}

export function isMeshyProviderConfiguration(value: { id?: unknown; preset?: unknown; baseUrl?: unknown } | undefined): boolean {
  return !!value && (isMeshyIdentifier(value.id) || value.preset === "meshy" || isMeshyEndpoint(value.baseUrl));
}
