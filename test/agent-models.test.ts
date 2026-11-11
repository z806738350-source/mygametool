import { describe, expect, it } from "vitest";
import { findAgentModel, preferredAgentModel, recommendedAgentModel } from "../src/shared/agent-models.js";
import { isAgentRuntimeId } from "../src/shared/agent-runtimes.js";
import { KUNPO_DEFAULT_MODEL_REFS, KUNPO_MODEL_OPTIONS, kunpoModelOption, kunpoProviderDetails, validateKunpoSelection } from "../src/shared/kunpo-models.js";

const models = [
  { provider: "one", id: "first", name: "First" },
  { provider: "two", id: "second", name: "Second" },
];

describe("agent model selection", () => {
  it("prefers an available explicit selection", () => {
    expect(preferredAgentModel(models, { provider: "two", id: "second" }, { provider: "one", id: "first" }))
      .toBe(models[1]);
  });

  it("falls back to the configured default and then the first model", () => {
    expect(preferredAgentModel(models, { provider: "missing", id: "missing" }, { provider: "two", id: "second" }))
      .toBe(models[1]);
    expect(preferredAgentModel(models, undefined, { provider: "missing", id: "missing" })).toBe(models[0]);
    expect(preferredAgentModel([], undefined, { provider: "one", id: "first" })).toBeUndefined();
  });

  it("finds only exact provider and model matches", () => {
    expect(findAgentModel(models, { provider: "one", id: "first" })).toBe(models[0]);
    expect(findAgentModel(models, { provider: "two", id: "first" })).toBeUndefined();
  });

  it("recognizes Qoder without replacing a saved Kunpo conversation selection", () => {
    const kunpo = { provider: "kunpo", id: "gpt-5.6-sol" };
    const qoder = { provider: "qoder-cli", id: "auto" };
    const catalog = [kunpo, qoder];

    expect(isAgentRuntimeId(qoder.provider)).toBe(true);
    expect(preferredAgentModel(catalog, kunpo, qoder)).toBe(kunpo);
    expect(preferredAgentModel(catalog, undefined, kunpo)).toBe(kunpo);
    expect(preferredAgentModel(catalog, qoder, kunpo)).toBe(qoder);
    expect(preferredAgentModel([kunpo], qoder, kunpo)).toBe(kunpo);
    expect(KUNPO_DEFAULT_MODEL_REFS.agent).toEqual(kunpo);
  });

  it("recommends Gemini 4 for new Google connections while preserving saved defaults", () => {
    const catalog = [
      { provider: "google", id: "gemini-3.1-pro-preview" },
      { provider: "google", id: "gemini-4-argon" },
    ];
    expect(recommendedAgentModel(catalog, "google")).toBe(catalog[1]);
    expect(preferredAgentModel(catalog, undefined, catalog[0])).toBe(catalog[0]);
    expect(recommendedAgentModel(catalog.slice(0, 1), "google")).toBe(catalog[0]);
  });

  it("recommends a provider's flagship model and falls back to its first model", () => {
    const catalog = [
      { provider: "anthropic", id: "claude-3-haiku" },
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "custom:local", id: "local" },
    ];
    expect(recommendedAgentModel(catalog, "anthropic")).toBe(catalog[1]);
    expect(recommendedAgentModel(catalog.slice(0, 1), "anthropic")).toBe(catalog[0]);
    expect(recommendedAgentModel(catalog, "custom:local")).toBe(catalog[2]);
    expect(recommendedAgentModel(catalog, "openai")).toBeUndefined();
  });
});

describe("reviewed Kunpo selections", () => {
  it("keeps operation defaults distinct and leaves full music without a default", () => {
    expect(KUNPO_DEFAULT_MODEL_REFS.agent).toEqual({ provider: "kunpo", id: "gpt-5.6-sol" });
    expect(KUNPO_DEFAULT_MODEL_REFS.image?.id).toBe("gpt-image-2.5-sunburst");
    expect(KUNPO_DEFAULT_MODEL_REFS["3d-generation"]?.id).toBe("v3.1-20260211");
    expect(KUNPO_DEFAULT_MODEL_REFS["3d-remesh"]?.id).toBe("v3.0");
    expect(KUNPO_DEFAULT_MODEL_REFS["3d-rig"]?.id).toBe("v3.0-20260909");
    expect(KUNPO_DEFAULT_MODEL_REFS.music).toBeUndefined();
    for (const [role, reference] of Object.entries(KUNPO_DEFAULT_MODEL_REFS)) {
      expect(KUNPO_MODEL_OPTIONS.some((entry) => entry.role === role && entry.provider === reference.provider && entry.id === reference.id)).toBe(true);
    }
  });

  it("allows retaining a pending candidate but fails execution and mismatched operations", () => {
    const pending = { provider: "kunpo", id: "gemini-3.8-flash" };
    expect(validateKunpoSelection("agent", pending).status).toBe("pending");
    expect(() => validateKunpoSelection("agent", pending, { forExecution: true })).toThrow("not integrated");
    expect(() => validateKunpoSelection("3d-generation", { provider: "tripo", id: "v3.0" })).toThrow("reviewed option");
    expect(kunpoModelOption("speech", KUNPO_DEFAULT_MODEL_REFS.speech)?.capabilities.strictText).toBe(false);
    expect(kunpoModelOption("image", { provider: "openai", id: "Image-GI2.1" })?.capabilities.transparency).toBe(false);
  });

  it("registers exact reviewed APIs and retains explicitly selected alternatives", () => {
    const provider = kunpoProviderDetails();
    const language = provider.models.filter((entry) => entry.usages?.language);
    expect(language.map((entry) => [entry.id, entry.api])).toEqual([
      ["gpt-5.6-sol", "openai-completions"], ["claude-opus-5-5", "anthropic-messages"], ["gpt-6.1-sol", "openai-responses"],
    ]);
    expect(language[0]!.reasoning).toBe(false);
    expect(language[2]!.supportsImages).toBe(false);
    expect(kunpoModelOption("agent", { provider: "kunpo", id: "gpt-6.1-sol" })).toMatchObject({ capabilities: { images: true }, imageInputStatus: "unverified" });
    const choices = language.map((entry) => ({ provider: provider.id, ...entry }));
    expect(recommendedAgentModel(choices, "kunpo")?.id).toBe("gpt-5.6-sol");
    expect(preferredAgentModel(choices, choices[1], KUNPO_DEFAULT_MODEL_REFS.agent)?.id).toBe("claude-opus-5-5");
  });
});
