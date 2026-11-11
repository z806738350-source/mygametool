// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentModelCatalog,
  CustomProviderDetails,
  ModelAuthEvent,
  ProviderSummary,
} from "../src/shared/contracts.js";
import {
  INITIAL_ONBOARDING_STATE,
  type OnboardingState,
  type OnboardingStep,
} from "../src/shared/onboarding.js";

const api = vi.hoisted(() => ({
  startModelProviderLogin: vi.fn(),
  cancelModelAuth: vi.fn(),
  respondToModelAuth: vi.fn(),
  subscribeToModelAuth: vi.fn(),
  notifyAgentModelsChanged: vi.fn(),
  getOnboardingState: vi.fn(),
  updateOnboardingState: vi.fn(),
  waitForRuntime: vi.fn(),
  listProviders: vi.fn(),
  listAgentRuntimes: vi.fn(),
  updateAgentRuntime: vi.fn(),
  loginAgentRuntime: vi.fn(),
  recheckAgentRuntime: vi.fn(),
  listModels: vi.fn(),
  listImageModelCatalog: vi.fn(),
  listVideoModelCatalog: vi.fn(),
  listModel3DCatalog: vi.fn(),
  setDefaultMediaModel: vi.fn(),
  getCustomProvider: vi.fn(),
  discoverCustomProviderModels: vi.fn(),
  saveCustomProvider: vi.fn(),
  setProviderEnabled: vi.fn(),
  updateAgentDefaults: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  ...api,
}));
const { Onboarding, OnboardingArrival } =
  await import("../src/renderer/onboarding.js");
const { useModelProviderAuth } =
  await import("../src/renderer/use-model-provider-auth.js");
const { useOnboarding } = await import("../src/renderer/use-onboarding.js");
const { CustomProviderDialog } =
  await import("../src/renderer/custom-provider-dialog.js");

type Stream = { onEvent: (event: ModelAuthEvent) => void; onError: () => void };
const streams: Stream[] = [];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const provider: ProviderSummary = {
  id: "kunpo",
  name: "KunpoAPI",
  configured: false,
  capabilities: ["language"],
  status: "not_configured",
  methods: [{ type: "api_key", label: "API key" }],
};
const catalog: AgentModelCatalog = {
  models: [],
  defaultReasoningLevel: "medium",
};
const customProvider: CustomProviderDetails = {
  id: "custom:test",
  name: "Test provider",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  authentication: "none",
  models: [
    {
      id: "test-model",
      name: "Test model",
      api: "openai-completions",
      contextWindow: 32000,
      maxTokens: 4096,
      reasoning: false,
      supportsImages: false,
      usages: { language: true },
    },
  ],
  hiddenModelIds: [],
};
beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  streams.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: undefined,
  });
  api.startModelProviderLogin.mockResolvedValue("operation");
  api.cancelModelAuth.mockResolvedValue(undefined);
  api.respondToModelAuth.mockResolvedValue(undefined);
  api.notifyAgentModelsChanged.mockImplementation(() => {
    window.dispatchEvent(new Event("ohmygame-models-changed"));
  });
  api.subscribeToModelAuth.mockImplementation((_id, stream) => {
    streams.push(stream);
    return vi.fn();
  });
  api.waitForRuntime.mockResolvedValue(undefined);
  api.getOnboardingState.mockResolvedValue(INITIAL_ONBOARDING_STATE);
  api.updateOnboardingState.mockImplementation(async (state) => ({
    version: 1,
    ...state,
  }));
  api.listProviders.mockResolvedValue([provider]);
  api.listAgentRuntimes.mockResolvedValue([]);
  api.listModels.mockResolvedValue(catalog);
  api.listImageModelCatalog.mockResolvedValue({ models: [] });
  api.listVideoModelCatalog.mockResolvedValue({ models: [] });
  api.listModel3DCatalog.mockResolvedValue({ models: [] });
  api.getCustomProvider.mockResolvedValue(customProvider);
  api.discoverCustomProviderModels.mockResolvedValue({
    models: customProvider.models,
  });
  api.saveCustomProvider.mockImplementation(async () => {
    api.notifyAgentModelsChanged();
    return customProvider;
  });
  api.setProviderEnabled.mockImplementation(async (id, enabled) => {
    api.notifyAgentModelsChanged();
    return { ...provider, id, configured: true, enabled };
  });
  api.updateAgentDefaults.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (item) =>
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function stepButton(step: OnboardingStep) {
  return container.querySelector<HTMLButtonElement>(
    `.onboarding-progress > button:nth-child(${step === "welcome" ? 1 : step === "connect" ? 2 : 3})`,
  )!;
}
function providerButton(name: string, label: string) {
  const row = [...container.querySelectorAll('[role="group"]')].find(
    (item) => item.getAttribute("aria-label") === name,
  );
  const result = [...(row?.querySelectorAll("button") ?? [])].find(
    (item) =>
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!result) throw new Error(`Missing ${name} button: ${label}`);
  return result;
}
async function showConnection(element: ReactNode) {
  await act(async () => root.render(element));
}
async function fillInput(placeholder: string, value: string) {
  const input = [...container.querySelectorAll("input")].find(
    (item) => item.placeholder === placeholder,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function event(value: Omit<ModelAuthEvent, "id" | "operationId">) {
  await act(async () =>
    streams
      .at(-1)!
      .onEvent({ id: 1, operationId: "operation", ...value } as ModelAuthEvent),
  );
}
const secretPrompt = (id: string): ModelAuthEvent => ({
  id: 1,
  operationId: "operation",
  type: "prompt",
  promptId: id,
  prompt: { type: "secret", message: "API key" },
});

describe("local Kunpo onboarding", () => {
  const kunpo: ProviderSummary = { ...provider, id: "kunpo", name: "KunpoAPI", custom: true };
  it("offers Kunpo directly without CLI detection and allows starting without a key", async () => {
    api.listProviders.mockResolvedValue([{ ...provider, id: "openrouter", name: "OpenRouter" }, kunpo]);
    const onFinish = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={onFinish} />));
    expect(container.textContent).toContain("KunpoAPI");
    expect(container.textContent).not.toContain("OpenRouter");
    expect(container.textContent).not.toContain("Claude Code");
    expect(container.textContent).not.toContain("Codex");
    expect(container.textContent).not.toContain("OpenCode");
    expect(container.querySelector(".onboarding-agent-options")).toBeNull();
    expect(api.listAgentRuntimes).not.toHaveBeenCalled();
    expect(api.listModels).toHaveBeenCalledWith({ agentRuntimes: false });
    await act(async () => button("Skip and start").click());
    expect(onFinish).toHaveBeenCalledWith("skipped");
  });
  it("uses the existing Key form for built-in Kunpo instead of a custom-provider editor", async () => {
    api.listProviders.mockResolvedValue([kunpo]);
    await act(async () => root.render(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />));
    await act(async () => providerButton("KunpoAPI", "API key").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledWith("kunpo", "api_key");
    expect(api.getCustomProvider).not.toHaveBeenCalled();
    expect(api.listAgentRuntimes).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connect KunpoAPI");
  });
});

describe("shared model authorization lifecycle", () => {
  let auth: ReturnType<typeof useModelProviderAuth>;
  const completed = vi.fn(),
    cancelled = vi.fn(),
    failed = vi.fn();
  function Harness({ method = "api_key" }: { method?: "api_key" | "oauth" }) {
    auth = useModelProviderAuth({
      providerId: "openrouter",
      method,
      onCompleted: completed,
      onCancelled: cancelled,
      onFailed: failed,
    });
    return null;
  }
  beforeEach(() => {
    completed.mockClear();
    cancelled.mockClear();
    failed.mockClear();
  });

  it("cancels a start that resolves after its screen has closed", async () => {
    const start = deferred<string>();
    api.startModelProviderLogin.mockReturnValue(start.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(null));
    await act(async () => start.resolve("late-operation"));
    expect(api.cancelModelAuth).toHaveBeenCalledWith("late-operation");
    expect(api.subscribeToModelAuth).not.toHaveBeenCalled();
  });

  it("retains the next prompt when it arrives before the response request resolves", async () => {
    const response = deferred<void>();
    api.respondToModelAuth.mockReturnValue(response.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => streams[0]!.onEvent(secretPrompt("first")));
    let pending!: Promise<void>;
    await act(async () => {
      pending = auth.respond("test-key");
    });
    expect(auth.responding).toBe(true);
    await act(async () => streams[0]!.onEvent(secretPrompt("second")));
    await act(async () => {
      response.resolve();
      await pending;
    });
    expect(auth.prompt?.id).toBe("second");
    expect(auth.responding).toBe(false);
  });

  it("opens an OAuth URL once and does not cancel a completed flow", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await act(async () => root.render(<Harness method="oauth" />));
    const notification = {
      type: "notification" as const,
      notification: {
        type: "auth_url" as const,
        url: "https://auth.example.test/login",
      },
    };
    await event(notification);
    await event(notification);
    expect(open).toHaveBeenCalledOnce();
    await event({ type: "completed" });
    expect(completed).toHaveBeenCalledOnce();
    expect(api.notifyAgentModelsChanged).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(api.cancelModelAuth).not.toHaveBeenCalled();
  });

  it("ignores stale authorization events after cancellation", async () => {
    await act(async () => root.render(<Harness />));
    const stream = streams[0]!;
    await act(async () => auth.cancel());
    await act(async () => {
      stream.onEvent({ id: 1, operationId: "operation", type: "cancelled" });
      stream.onEvent({ id: 2, operationId: "operation", type: "completed" });
      stream.onError();
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("local first-run screens", () => {
  it("switches steps using the bottom navigation and cancels authorization when leaving", async () => {
    const change = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const [step, setStep] = useState<OnboardingStep>("welcome");
      return (
        <Onboarding
          step={step}
          onStepChange={async (next) => {
            await change(next);
            setStep(next);
          }}
          onFinish={vi.fn()}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    expect(stepButton("welcome").getAttribute("aria-current")).toBe("step");
    expect(container.querySelector(".onboarding-welcome-static")).toBeNull();
    await act(async () => stepButton("connect").click());
    expect(change).toHaveBeenLastCalledWith("connect");
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
    expect(container.textContent).not.toContain("Back");
    await act(async () => providerButton("KunpoAPI", "API key").click());
    await act(async () => stepButton("welcome").click());
    expect(change).toHaveBeenLastCalledWith("welcome");
    expect(
      container.querySelector(".onboarding-welcome-static"),
    ).not.toBeNull();
    expect(api.cancelModelAuth).toHaveBeenCalledWith("operation");
    await act(async () => stepButton("connect").click());
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
    expect(stepButton("connect").getAttribute("aria-current")).toBe("step");
    expect(stepButton("welcome").hasAttribute("aria-current")).toBe(false);
  });

  it.each(["connect", "media"] as const)(
    "skips the welcome intro when returning from a resumed %s step",
    async (step) => {
      const onStepChange = vi.fn();
      const onFinish = vi.fn();
      await act(async () =>
        root.render(
          <Onboarding
            step={step}
            onStepChange={onStepChange}
            onFinish={onFinish}
          />,
        ),
      );
      await act(async () =>
        root.render(
          <Onboarding
            step="welcome"
            onStepChange={onStepChange}
            onFinish={onFinish}
          />,
        ),
      );
      expect(
        container.querySelector(".onboarding-welcome-static"),
      ).not.toBeNull();
      expect(button("Next").disabled).toBe(false);
      expect(container.querySelector("h1")?.textContent).toBe(
        "Your own game studio.",
      );
    },
  );

  it("lets a failed step save be retried", async () => {
    const step = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not save setup"))
      .mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <Onboarding step="welcome" onStepChange={step} onFinish={finish} />,
      ),
    );
    expect(container.textContent).not.toContain("Skip for now");
    expect(container.textContent).not.toContain(
      "Your projects stay on this machine.",
    );
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Could not save setup");
    await act(async () => button("Retry").click());
    expect(step).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenLastCalledWith("connect");
    expect(finish).not.toHaveBeenCalled();
  });

  it("allows entering without a model and retries a failed preference save", async () => {
    const save = deferred<void>();
    const finish = vi
      .fn()
      .mockReturnValueOnce(save.promise)
      .mockResolvedValue(undefined);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    expect(container.textContent).not.toContain("Skip for now");
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Next").click());
    expect(finish).not.toHaveBeenCalled();
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
    expect(button("Skip and start").disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);
    expect(stepButton("connect").disabled).toBe(true);
    await act(async () => save.reject(new Error("Could not save setup")));
    expect(container.textContent).toContain("Could not save setup");
    expect(button("Skip and start").disabled).toBe(false);
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Retry").click());
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith("skipped");
    expect(container.textContent).not.toContain("Could not save setup");
  });

  it("records completion after connecting a provider with a visible language model", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    expect(button("Next").disabled).toBe(true);
    await act(async () => providerButton("KunpoAPI", "API key").click());
    expect(container.textContent).not.toContain("Next");
    expect(api.startModelProviderLogin).toHaveBeenCalledWith(
      "kunpo",
      "api_key",
    );
    await act(async () => streams[0]!.onEvent(secretPrompt("key")));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: "kunpo",
          id: "test",
          name: "Test model",
          reasoningLevels: ["off"],
        },
      ],
    });
    api.listProviders.mockResolvedValue([{ ...provider, configured: true }]);
    await event({ type: "completed" });
    expect(container.querySelector('[aria-label="Default model"]')).toBeNull();
    expect(button("Next").disabled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("completed");
  });

  it("keeps setup busy while saving the connected provider's default across catalog refreshes", async () => {
    const save = deferred<void>();
    const finish = vi.fn();
    const models: AgentModelCatalog["models"] = [
      {
        provider: provider.id,
        providerName: provider.name,
        id: "test-model",
        name: "Test model",
        reasoningLevels: ["medium"],
      },
    ];
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    await act(async () => providerButton(provider.name, "API key").click());
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({ ...catalog, models });
    api.updateAgentDefaults.mockReturnValue(save.promise);

    await event({ type: "completed" });
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledOnce();
    expect(button("Next").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);
    await act(async () => button("Next").click());
    expect(finish).not.toHaveBeenCalled();

    await act(async () => save.resolve());
    expect(button("Next").disabled).toBe(false);
  });

  it("retries saving the connected provider's default without repeating authorization", async () => {
    const models: AgentModelCatalog["models"] = [
      {
        provider: provider.id,
        providerName: provider.name,
        id: "test-model",
        name: "Test model",
        reasoningLevels: ["medium"],
      },
    ];
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    await act(async () => providerButton(provider.name, "API key").click());
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({ ...catalog, models });
    api.updateAgentDefaults.mockRejectedValueOnce(
      new Error("Saving default failed"),
    );

    await event({ type: "completed" });
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Saving default failed");
    await act(async () => button("Retry").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledTimes(2);
    expect(api.startModelProviderLogin).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Saving default failed");
  });

  it("retries selecting a re-enabled provider's default after the enable has already succeeded", async () => {
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, enabled: false },
    ]);
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: provider.id,
          providerName: provider.name,
          id: "test-model",
          name: "Test model",
          reasoningLevels: ["medium"],
        },
      ],
    });
    api.setProviderEnabled.mockImplementation(async () => {
      api.listProviders.mockResolvedValue([
        { ...provider, configured: true, enabled: true },
      ]);
      api.notifyAgentModelsChanged();
      return { ...provider, configured: true, enabled: true };
    });
    api.updateAgentDefaults.mockRejectedValueOnce(
      new Error("Saving default failed"),
    );
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );

    await act(async () => providerButton(provider.name, "Enable").click());
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Saving default failed");
    await act(async () => button("Retry").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledTimes(2);
    expect(api.setProviderEnabled).toHaveBeenCalledOnce();
  });

  it("changes the default model from the ready line", async () => {
    const models: AgentModelCatalog["models"] = [
      {
        provider: "kunpo",
        id: "first",
        name: "First",
        providerName: "KunpoAPI",
        reasoningLevels: ["medium"],
      },
      {
        provider: "kunpo",
        id: "second",
        name: "Second",
        providerName: "KunpoAPI",
        reasoningLevels: ["off"],
      },
    ];
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({
      ...catalog,
      models,
      defaultModel: { provider: "kunpo", id: "first" },
    });
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    const select = container.querySelector<HTMLButtonElement>(
      ".onboarding-model-select > button",
    )!;
    expect(select.getAttribute("aria-label")).toBe("Default model: First");
    await act(async () => select.click());
    const menu = document.querySelector<HTMLDivElement>(".canvas-chip-menu")!;
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    const second = menu.querySelector<HTMLButtonElement>(
      '[role="option"]:last-child',
    )!;
    expect(second.textContent).toContain("Second");
    await act(async () => second.click());
    expect(document.querySelector(".canvas-chip-menu")).toBeNull();
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    expect(select.getAttribute("aria-label")).toBe("Default model: Second");
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: models[1],
      reasoningLevel: "off",
    });
    expect(api.listModels).toHaveBeenCalledOnce();
  });

  it("retries failed authorization and lets users return to enter without a model", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    await act(async () => providerButton("KunpoAPI", "API key").click());
    await event({ type: "error", error: "Sign-in failed" } as Omit<
      ModelAuthEvent,
      "id" | "operationId"
    >);
    expect(container.textContent).toContain("Sign-in failed");
    await act(async () => button("Retry").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledTimes(2);
    await act(async () => stepButton("connect").click());
    expect(api.cancelModelAuth).toHaveBeenCalledWith("operation");
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
  });

  it("keeps catalog failures recoverable", async () => {
    api.listModels.mockRejectedValueOnce(new Error("Catalog unavailable"));
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    expect(container.textContent).toContain("Catalog unavailable");
    await act(async () => button("Retry").click());
    expect(container.textContent).not.toContain("Catalog unavailable");
    expect(providerButton("KunpoAPI", "API key")).toBeDefined();
  });

  it("allows entering the studio when the model catalog cannot load", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    api.listModels.mockRejectedValueOnce(new Error("Catalog unavailable"));
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    expect(container.textContent).toContain("Catalog unavailable");
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
  });

  it("retains the modal presentation for provider settings", async () => {
    const close = vi.fn();
    await act(async () =>
      root.render(
        <CustomProviderDialog
          settings={customProvider}
          onClose={close}
          onSaved={vi.fn()}
        />,
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.contains(dialog)).toBe(false);
    expect(document.querySelector(".project-settings-backdrop")).not.toBeNull();
    expect(
      dialog.querySelector<HTMLInputElement>('input[placeholder="My provider"]')
        ?.value,
    ).toBe("Test provider");
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("local edition setup boundaries", () => {
  it.each(["Codex", "Qoder"])("does not detect, enable, authenticate or install %s during initial setup", async (name) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    api.listModels.mockResolvedValue({ ...catalog, models: [{ provider: `${name.toLowerCase()}-cli`, providerName: name, id: "native", name: "Native model", reasoningLevels: [] }] });
    const finish = vi.fn();
    await showConnection(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />);
    expect(container.querySelector(".onboarding-agent-options")).toBeNull();
    expect(container.querySelector(".onboarding-ready")).toBeNull();
    expect(container.textContent).not.toContain(name);
    expect(api.listAgentRuntimes).not.toHaveBeenCalled();
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
    expect(api.loginAgentRuntime).not.toHaveBeenCalled();
    expect(api.recheckAgentRuntime).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(button("Next").disabled).toBe(true);
  });

  it("keeps saved Kunpo credentials and hides stale author or custom connections", async () => {
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
      { ...provider, id: "cloud-image", name: "Author Cloud", managed: "free_cloud", configured: true },
      { ...provider, id: customProvider.id, name: "Legacy custom", custom: true, configured: true },
    ]);
    await showConnection(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />);
    expect(providerButton("KunpoAPI", "Connected").disabled).toBe(true);
    expect(container.textContent).not.toContain("Author Cloud");
    expect(container.textContent).not.toContain("Legacy custom");
    expect(container.querySelector('[aria-label="Add custom provider"]')).toBeNull();
    expect(api.startModelProviderLogin).not.toHaveBeenCalled();
    expect(api.saveCustomProvider).not.toHaveBeenCalled();
  });

  it("refreshes a stale connection before reopening its Key form", async () => {
    await showConnection(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />);
    api.listProviders.mockResolvedValue([{ ...provider, configured: true, status: "connected" }]);
    await act(async () => providerButton("KunpoAPI", "API key").click());
    expect(providerButton("KunpoAPI", "Connected").disabled).toBe(true);
    expect(api.startModelProviderLogin).not.toHaveBeenCalled();
    expect(api.getCustomProvider).not.toHaveBeenCalled();
  });

  it("retries a failed Key-operation start without adding a custom endpoint", async () => {
    api.startModelProviderLogin.mockRejectedValueOnce(new Error("Key operation unavailable"));
    await showConnection(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />);
    await act(async () => providerButton("KunpoAPI", "API key").click());
    expect(container.textContent).toContain("Key operation unavailable");
    await act(async () => button("Retry").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledTimes(2);
    expect(api.startModelProviderLogin).toHaveBeenLastCalledWith("kunpo", "api_key");
    expect(api.saveCustomProvider).not.toHaveBeenCalled();
  });

  it("shows only Kunpo when searching providers and never offers arbitrary endpoint discovery", async () => {
    api.listProviders.mockResolvedValue([provider, { ...provider, id: "other", name: "Other provider" }]);
    await showConnection(<Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />);
    expect(container.querySelectorAll('.onboarding-picker [role="group"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("Other provider");
    await fillInput("Search providers…", "other");
    expect(container.querySelectorAll('.onboarding-picker [role="group"]')).toHaveLength(0);
    await fillInput("Search providers…", "Kunpo");
    expect(providerButton("KunpoAPI", "API key")).toBeDefined();
    expect(api.discoverCustomProviderModels).not.toHaveBeenCalled();
  });

  it("uses a single Kunpo Key across all optional creative-tool tabs", async () => {
    api.listProviders.mockResolvedValue([{ ...provider, capabilities: ["language", "image", "video", "3d", "audio"] }, { ...provider, id: "openai", name: "Legacy OpenAI", capabilities: ["image"] }]);
    await act(async () => root.render(<Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />));
    for (const tab of ["Image", "Video", "3D", "Audio"]) {
      await act(async () => button(tab).click());
      expect(providerButton("KunpoAPI", "Configure")).toBeDefined();
      expect(container.textContent).not.toContain("Legacy OpenAI");
      expect(container.querySelector('[aria-label="Add custom provider"]')).toBeNull();
    }
    await act(async () => providerButton("KunpoAPI", "Configure").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledWith("kunpo", "api_key");
    expect(api.getCustomProvider).not.toHaveBeenCalled();
    expect(api.listImageModelCatalog).not.toHaveBeenCalled();
    expect(api.listVideoModelCatalog).not.toHaveBeenCalled();
    expect(api.listModel3DCatalog).not.toHaveBeenCalled();
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
  });

  it("keeps media optional and retries provider loading without opening author services", async () => {
    const finish = vi.fn();
    api.listProviders.mockRejectedValueOnce(new Error("Media providers unavailable"));
    await act(async () => root.render(<Onboarding step="media" onStepChange={vi.fn()} onFinish={finish} />));
    expect(container.textContent).toContain("Media providers unavailable");
    expect(button("Start creating").disabled).toBe(false);
    api.listProviders.mockResolvedValue([{ ...provider, configured: true, capabilities: ["image"] }]);
    await act(async () => button("Retry").click());
    expect(container.textContent).not.toContain("Media providers unavailable");
    expect(container.querySelector('[aria-label="KunpoAPI"] [aria-label="Connected"]')).not.toBeNull();
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("skipped");
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
  });

  it("does not duplicate a pending setup completion on a same-frame double click", async () => {
    const saved = deferred<void>();
    const finish = vi.fn().mockReturnValue(saved.promise);
    await act(async () => root.render(<Onboarding step="media" onStepChange={vi.fn()} onFinish={finish} />));
    await act(async () => { button("Start creating").click(); button("Start creating").click(); });
    expect(finish).toHaveBeenCalledOnce();
    expect(button("Start creating").disabled).toBe(true);
    await act(async () => saved.resolve());
    expect(button("Start creating").disabled).toBe(false);
  });

  it("cancels arrival completion when its screen is removed", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    try {
      await act(async () => root.render(<OnboardingArrival onComplete={complete} />));
      await act(async () => root.render(null));
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(complete).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("onboarding navigation state", () => {
  let state: ReturnType<typeof useOnboarding>;
  function Harness({ eligible = true }: { eligible?: boolean }) {
    state = useOnboarding(eligible);
    return null;
  }

  it("reads the persisted connection step and keeps explicit writes ahead of stale reads", async () => {
    const read = deferred<OnboardingState>();
    api.getOnboardingState.mockReturnValue(read.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => state.save({ status: "skipped", step: "connect" }));
    await act(async () =>
      read.resolve({ version: 1, status: "pending", step: "connect" }),
    );
    expect(state.state?.status).toBe("skipped");
    await act(async () => root.render(null));
    api.getOnboardingState.mockResolvedValue({
      version: 1,
      status: "pending",
      step: "connect",
    });
    await act(async () => root.render(<Harness />));
    expect(state.state?.step).toBe("connect");
  });

  it("leaves project routes alone and reopens from settings without resetting saved state immediately", async () => {
    await act(async () => root.render(<Harness eligible={false} />));
    expect(api.getOnboardingState).not.toHaveBeenCalled();
    await act(async () => state.open());
    expect(state.replaying).toBe(true);
    expect(state.state).toEqual(INITIAL_ONBOARDING_STATE);
    expect(api.updateOnboardingState).not.toHaveBeenCalled();
    await act(async () => state.save({ status: "skipped", step: "welcome" }));
    expect(state.replaying).toBe(false);
  });
});

it("shows the arrival only after saving setup and reveals the interactive studio afterwards", async () => {
  vi.doMock(path.resolve("src/renderer/home.tsx"), () => ({
    Home: ({ inert }: { inert?: boolean }) => <main inert={inert}>Studio</main>,
  }));
  vi.doMock(
    path.resolve("src/renderer/asset-canvas-quick-start.ts"),
    async (original) => ({
      ...(await original<
        typeof import("../src/renderer/asset-canvas-quick-start.js")
      >()),
      invalidateQuickStartModels: vi.fn(),
      loadQuickStartModels: vi.fn().mockResolvedValue([]),
    }),
  );
  vi.doMock(
    path.resolve("src/renderer/app-navigation.ts"),
    async (original) => ({
      ...(await original<typeof import("../src/renderer/app-navigation.js")>()),
      useAppNavigation: () => ({ route: { page: "home" }, navigate: vi.fn() }),
    }),
  );
  const { App } = await import("../src/renderer/app.js");
  api.getOnboardingState.mockResolvedValue({
    version: 1,
    status: "pending",
    step: "media",
  });
  api.updateOnboardingState.mockRejectedValueOnce(
    new Error("Setup save failed"),
  );
  await act(async () => root.render(<App />));
  await act(async () => button("Start creating").click());
  expect(container.textContent).toContain("Setup save failed");
  expect(container.querySelector(".onboarding-arrival")).toBeNull();
  vi.useFakeTimers();
  try {
    await act(async () => button("Retry").click());
    expect(container.querySelector(".onboarding-arrival h1")?.textContent).toBe(
      "Welcome, Gamer!",
    );
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
    await act(async () => vi.advanceTimersByTime(1_900));
    expect(container.querySelector(".onboarding-arrival")).toBeNull();
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(container.textContent).toBe("Studio");
  } finally {
    vi.useRealTimers();
  }
});
