// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { clearWebSearchCredentials, getWebSearchSettings } from "../src/renderer/api.js";
import { WebSearchSettingsPanel } from "../src/renderer/web-search-settings.js";

vi.mock("../src/renderer/api.js", () => ({ clearWebSearchCredentials: vi.fn(), getWebSearchSettings: vi.fn() }));

it("offers only explicit removal of the old keys", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = { enabled: false, provider: "exa" as const, fallback: false, exaApiKeyConfigured: true, parallelApiKeyConfigured: false };
  vi.mocked(getWebSearchSettings).mockResolvedValue(state);
  vi.mocked(clearWebSearchCredentials).mockResolvedValue({ ...state, exaApiKeyConfigured: false });
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<WebSearchSettingsPanel />));
    expect(host.querySelector("input, select, form")).toBeNull();
    expect(clearWebSearchCredentials).not.toHaveBeenCalled();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    await act(async () => host.querySelector("button")!.click());
    expect(clearWebSearchCredentials).toHaveBeenCalledOnce();
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
