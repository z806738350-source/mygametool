// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CustomProviderDetails, ProviderSummary } from "../src/shared/contracts.js";
import { t } from "../src/renderer/i18n.js";
import { defaultModel3DSettings } from "../src/shared/custom-models.js";

const api = { balance: vi.fn(), providers: vi.fn(), custom: vi.fn(), keys: vi.fn(), clearKey: vi.fn() };
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  listLegacyMediaKeys: api.keys, clearLegacyMediaKey: api.clearKey,
  model3DBalance: api.balance, listProviders: api.providers, getCustomProvider: api.custom, MODELS_CHANGED_EVENT: "ohmygame-models-changed",
}));
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({ useAuth: () => ({ state: { status: "signed-in", user: { id: "u", name: "Player" } }, openSignIn: vi.fn() }) }));
vi.doMock(path.resolve("src/renderer/provider-models.tsx"), () => ({ ProviderModels: () => <div>Models</div> }));
vi.doMock(path.resolve("src/renderer/media-model-defaults.tsx"), async (original) => ({ ...await original<typeof import("../src/renderer/media-model-defaults.js")>(), GlobalMediaModelDefaults: () => null }));
const { ModelsSettings } = await import("../src/renderer/models-settings.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.keys.mockResolvedValue([]);
  api.balance.mockResolvedValue({ balance: 10 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const provider = (id: string, custom = false): ProviderSummary => ({ id, name: id, configured: true, status: "connected", capabilities: ["3d"], methods: [{ type: "api_key", label: "API key" }], custom });
const render = (value: ProviderSummary) => act(async () => root.render(<ModelsSettings view={{ page: "provider", provider: value }} onViewChange={() => {}} onOpenAgents={() => {}} />));

it("shows the complete Kunpo role catalog read-only without a custom endpoint or model editor", async () => {
  await render({ ...provider("kunpo", true), name: "KunpoAPI" });
  const agentRows = container.querySelectorAll('[role="list"][aria-label="Agent"] [role="listitem"]');
  expect(Array.from(agentRows, row => row.querySelector("strong")?.textContent)).toEqual(["gpt-5.6-sol", "claude-opus-5-5", "claude-fable-5-2", "gpt-6.2-astra"]);
  for (const row of agentRows) expect(row.getAttribute("title")).toBe(t("kunpoModels.agentHelp"));
  expect(container.textContent).toContain("gpt-image-2.5-sunburst");
  expect(container.textContent).toContain("doubao-seedance-2-5-260628");
  expect(container.textContent).toContain("seed-audio-1.0");
  expect(container.textContent).toContain("v3.0-20260909");
  expect(container.textContent).not.toContain("Custom endpoint");
  expect(container.querySelector('[aria-label="Edit models"]')).toBeNull();
  expect(api.custom).not.toHaveBeenCalled();
});

it("does not invent unconfigured local-provider cards ahead of Kunpo", async () => {
  api.providers.mockResolvedValue([{ ...provider("kunpo", true), name: "KunpoAPI", configured: false, status: "not_configured" }]);
  await act(async () => root.render(<ModelsSettings view={{ page: "providers" }} onViewChange={() => {}} onOpenAgents={() => {}} />));
  expect(container.textContent).toContain("KunpoAPI");
  expect(container.textContent).not.toContain("Ollama");
  expect(container.textContent).not.toContain("LM Studio");
  expect(container.querySelector(".settings-provider-more")).toBeNull();
});

it.each(["tripo", "hyper3d", "volcengine-ark", "byteplus-modelark", "minimax-video-cn", "minimax-video-global"])("shows %s as retired when opened from a stale view", async (id) => {
  await render(provider(id));
  expect(container.textContent).toContain("This independent connection is retired.");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(api.balance).not.toHaveBeenCalled();
});

it.each([provider("meshy"), { ...provider("custom:old", true), preset: "meshy" as const }])("shows saved Meshy references as unavailable without reading keys or custom connection details", async value => {
  await render(value);
  expect(container.textContent).toContain(t("modelUsage.meshyUnavailable"));
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(api.custom).not.toHaveBeenCalled(); expect(api.keys).not.toHaveBeenCalled();
  expect(api.clearKey).not.toHaveBeenCalled(); expect(api.balance).not.toHaveBeenCalled();
});

it("does not query a saved custom Meshy-protocol balance but keeps a separate Tripo connection", async () => {
  const fields = { api: "openai-completions", contextWindow: 4096, maxTokens: 1024, reasoning: false, supportsImages: false };
  const details: CustomProviderDetails = { id: "studio", name: "Studio", baseUrl: "https://studio.test/v3", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2, hiddenModelIds: [], models: [
    { ...fields, id: "old-mesh", name: "Old", usages: { "3d": defaultModel3DSettings("standard", "meshy") } },
    { ...fields, id: "tripo", name: "Tripo", usages: { "3d": defaultModel3DSettings("standard", "tripo") } },
  ] };
  api.custom.mockResolvedValue(details);
  await render(provider("studio", true));
  expect(api.balance).toHaveBeenCalledTimes(1); expect(api.balance).toHaveBeenCalledWith({ provider: "studio", id: "tripo" });
  expect(details.models[0]!.usages!["3d"]!.protocol).toBe("meshy");
});

it("offers to clear only the selected saved media key from the provider list", async () => {
  api.providers.mockResolvedValue([]);
  api.keys.mockResolvedValue([{ id: "meshy", name: "Meshy" }, { id: "minimax-video-cn", name: "MiniMax China" }]);
  await act(async () => root.render(<ModelsSettings view={{ page: "providers" }} onViewChange={() => {}} onOpenAgents={() => {}} />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Clear saved key for Meshy"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(api.clearKey).toHaveBeenCalledWith("meshy");
  expect(container.querySelector('[aria-label="Clear saved key for Meshy"]')).toBeNull();
  expect(container.querySelector('[aria-label="Clear saved key for MiniMax China"]')).not.toBeNull();
  expect(api.balance).not.toHaveBeenCalled();
});

it("does not query a hosted provider opened through a stale view", async () => {
  await render({ ...provider("cloud-hyper3d"), managed: "free_cloud" });
  expect(container.textContent).toContain("Local edition");
  expect(api.balance).not.toHaveBeenCalled();
  expect(api.providers).not.toHaveBeenCalled();
});

it("deduplicates custom balances while keeping distinct model-level endpoints separate", async () => {
  const modelFields = { api: "openai-completions", contextWindow: 4096, maxTokens: 1024, reasoning: false, supportsImages: false };
  const details: CustomProviderDetails = { id: "studio", name: "Studio", baseUrl: "https://studio.test/v3", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2, hiddenModelIds: ["first"], models: [
    { ...modelFields, id: "first", name: "First", usages: { "3d": defaultModel3DSettings("standard", "tripo") } },
    { ...modelFields, id: "second", name: "Second", usages: { "3d": { ...defaultModel3DSettings("standard", "tripo"), baseUrl: "https://studio.test/v3/" } } },
    { ...modelFields, id: "other", name: "Other account", usages: { "3d": { ...defaultModel3DSettings("standard", "tripo"), baseUrl: "https://other.test/v3" } } },
  ] };
  api.custom.mockResolvedValue(details);
  await render(provider("studio", true));
  expect(api.balance).toHaveBeenCalledTimes(2);
  expect(api.balance).toHaveBeenCalledWith({ provider: "studio", id: "first" });
  expect(api.balance).toHaveBeenCalledWith({ provider: "studio", id: "other" });
  expect(container.querySelector('[aria-label="API balance · First"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="API balance · Other account"]')).not.toBeNull();
});
