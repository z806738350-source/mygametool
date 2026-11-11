// @vitest-environment happy-dom
import * as api from "../src/renderer/api.js";
import { GlobalMediaModelDefaults } from "../src/renderer/media-model-defaults.js";
import { CustomProviderForm } from "../src/renderer/custom-provider-dialog.js";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomModelUsageFields } from "../src/renderer/custom-model-usage-fields.js";
import { customModel3D, defaultImageSettings, defaultModel3DSettings, defaultVideoSettings, normalizeModelUsages } from "../src/shared/custom-models.js";
import { modelError } from "../src/renderer/custom-provider-models.js";
import { ProviderModel3DForm } from "../src/renderer/provider-model3d-form.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { t } from "../src/renderer/i18n.js";
import type { CustomModelUsages } from "../src/shared/contracts.js";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("custom image reference settings", () => {
  it.each([
    ["gpt-image-2", undefined, 16],
    ["google/gemini-3.1-flash-image", "openrouter", 14],
    ["gemini-2.5-flash-image", "google", 3],
    ["doubao-seedream-5-0-pro-260628", "seedance", 10],
    ["doubao-seedream-5-0-260128", "seedance", 14],
    ["my-image-alias", undefined, 1],
  ] as const)("enables %s with its known reference count", async (modelId, preset, limit) => {
    const onChange = vi.fn();
    await act(async () => root.render(<CustomModelUsageFields usages={{}} modelId={modelId} preset={preset} onChange={onChange} />));
    const checkbox = [...host.querySelectorAll("label")].find((label) => label.textContent === "Image")!.querySelector("input")!;
    await act(async () => checkbox.click());
    expect(onChange).toHaveBeenCalledWith({ image: expect.objectContaining({ maxReferenceImages: limit }) });
  });

  it("preserves a saved count until the user restores the reference default", async () => {
    const usages: CustomModelUsages = { language: true, video: defaultVideoSettings(), image: {
      ...defaultImageSettings(), maxReferenceImages: 1, baseUrl: "https://relay.test/images", resolutions: ["2K"], aspectRatios: ["16:9"],
    } };
    const onChange = vi.fn();
    await act(async () => root.render(<CustomModelUsageFields usages={usages} modelId="gpt-image-2" onChange={onChange} />));
    const input = [...host.querySelectorAll("label")].find((label) => label.textContent === "Max reference images")!.querySelector("input")!;
    expect(input.value).toBe("1");
    expect(input.max).toBe("16");
    expect(onChange).not.toHaveBeenCalled();
    const restore = [...host.querySelectorAll("button")].find((button) => button.textContent === "Use model default (16 references)")!;
    await act(async () => restore.click());
    expect(onChange).toHaveBeenCalledWith({ ...usages, image: { ...usages.image, maxReferenceImages: 16 } });
  });
});


describe("disabled Meshy settings", () => {
  it("starts new 3D usage with Tripo and does not offer Meshy", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<CustomModelUsageFields usages={{}} modelId="custom-model" onChange={onChange} />));
    const checkbox = [...host.querySelectorAll("label")].find(label => label.textContent === "3D")!.querySelector("input")!;
    await act(async () => checkbox.click());
    expect(onChange).toHaveBeenCalledWith({ "3d": expect.objectContaining({ protocol: "tripo" }) });
    expect(defaultModel3DSettings().protocol).toBe("tripo");
    await act(async () => root.render(<CustomModelUsageFields usages={{ "3d": defaultModel3DSettings() }} modelId="custom-model" onChange={onChange} />));
    expect(host.querySelector('option[value="meshy"]')).toBeNull();
  });

  it("shows a saved Meshy protocol as unavailable and changes it only after an explicit selection", async () => {
    const usages: CustomModelUsages = { "3d": defaultModel3DSettings("standard", "meshy") };
    const onChange = vi.fn();
    await act(async () => root.render(<CustomModelUsageFields usages={usages} modelId="legacy" onChange={onChange} />));
    expect(host.textContent).toContain(t("modelUsage.meshyUnavailable"));
    const option = host.querySelector<HTMLOptionElement>('option[value="meshy"]')!;
    expect(option.disabled).toBe(true); expect(onChange).not.toHaveBeenCalled();
    const select = option.parentElement as HTMLSelectElement;
    await act(async () => { select.value = "tripo"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith({ "3d": expect.objectContaining({ protocol: "tripo" }) });
    expect(usages["3d"]!.protocol).toBe("meshy");
  });

  it("keeps legacy settings readable while excluding Meshy aliases and endpoints from executable models", () => {
    const usages = { "3d": defaultModel3DSettings("standard", "meshy") };
    expect(normalizeModelUsages(usages)).toEqual(usages);
    const model = { id: "old-alias", name: "Old", api: "openai-completions", contextWindow: 1000, maxTokens: 500, reasoning: false, supportsImages: false, usages };
    const provider = { id: "custom:legacy", name: "Legacy", baseUrl: "https://relay.test", api: "openai-completions", authentication: "none" as const, models: [model] };
    expect(customModel3D(provider, model)).toBeUndefined();
    expect(modelError(model, true)).toBe(t("modelUsage.meshyUnavailable"));
    const tripo = { ...model, usages: { "3d": defaultModel3DSettings() } };
    expect(customModel3D(provider, tripo)).toMatchObject({ protocol: "tripo" });
    expect(customModel3D({ ...provider, baseUrl: "https://api.meshy.ai/openapi/v2" }, tripo)).toBeUndefined();
  });

  it("cannot save or reset an old native Meshy preset", async () => {
    const onSave = vi.fn(), onReset = vi.fn();
    await act(async () => root.render(<ProviderModel3DForm protocol="meshy" initial={MODEL_3D_PRESETS.meshy[0]} busy={false} onSave={onSave} onReset={onReset} onCancel={vi.fn()} />));
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("model3dForm.restore"))!.disabled).toBe(true);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).not.toHaveBeenCalled(); expect(onReset).not.toHaveBeenCalled();
  });
});


it("cannot discover or save a disabled custom Meshy endpoint even after a synthetic form submission", async () => {
  const discover = vi.spyOn(api, "discoverCustomProviderModels").mockRejectedValue(new Error("No provider requests in this fixture"));
  const save = vi.spyOn(api, "saveCustomProvider").mockRejectedValue(new Error("No provider requests in this fixture"));
  const settings = { id: "old", name: "Old", baseUrl: "https://api.meshy.ai/openapi/v2", api: "openai-completions", authentication: "none" as const, modelConfigurationVersion: 2 as const, models: [], hiddenModelIds: [] };
  await act(async () => root.render(<CustomProviderForm settings={settings} onClose={vi.fn()} onSaved={vi.fn()} />));
  expect(host.textContent).toContain(t("modelUsage.meshyUnavailable"));
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  const fetch = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("customProvider.fetch"))!;
  expect(fetch.disabled).toBe(true);
  await act(async () => { fetch.click(); host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(discover).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(settings.baseUrl).toBe("https://api.meshy.ai/openapi/v2");
});


it("keeps an unavailable saved 3D default and excludes Meshy from new default choices", async () => {
  vi.spyOn(api, "listImageModelCatalog").mockResolvedValue({ models: [], providers: [] });
  vi.spyOn(api, "listVideoModelCatalog").mockResolvedValue({ models: [], providers: [] });
  const meshy = { provider: "meshy", providerName: "Meshy", id: "meshy-7.1", name: "Meshy 7.1", protocol: "meshy" as const, maxReferenceImages: 4, polycount: { min: 100, max: 300000, default: 30000, presets: [30000] } };
  const tripo = { ...meshy, provider: "tripo", providerName: "Tripo", id: "v3.1-20260211", name: "Tripo V3.1", protocol: "tripo" as const };
  vi.spyOn(api, "listModel3DCatalog").mockResolvedValue({ models: [meshy, tripo], providers: [], defaultModel: { provider: "meshy", id: meshy.id } });
  const save = vi.spyOn(api, "setDefaultMediaModel").mockRejectedValue(new Error("Fixture records explicit changes only"));
  await act(async () => root.render(<GlobalMediaModelDefaults capability="3d" />));
  expect(host.textContent).toContain(meshy.id); expect(save).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>(".canvas-chip")!.click());
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  expect(options.filter(option => option.textContent?.includes(meshy.name))).toHaveLength(0);
  expect(options.find(option => option.textContent?.includes(meshy.id))!.disabled).toBe(true);
  const choice = options.find(option => option.textContent === tripo.name)!;
  await act(async () => choice.click());
  expect(save).toHaveBeenCalledWith("3d", { provider: "tripo", id: tripo.id });
});
