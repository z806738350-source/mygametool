export const PROJECT_BROWSER_CLEANUP_DIRECTORY = "project-browser-cleanup";

export function storedBrowserProjectId(key: string): string | undefined {
  const match = /^(?:canvas-(?:board|documents|tables|document-generations|table-generations|active):|ohmygame:(?:composer-draft:v1:|playable:project:|playtest:(?:request|ask):))([^:]+)(?::|$)/.exec(key);
  if (!match) return;
  try { return decodeURIComponent(match[1]!); } catch { return; }
}
