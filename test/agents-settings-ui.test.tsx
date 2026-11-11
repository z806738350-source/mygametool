// @vitest-environment happy-dom
import path from "node:path";
import i18next from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeStatus } from "../src/shared/agent-runtimes.js";
import type { AgentModelCatalog } from "../src/shared/contracts.js";

const agent = (
  id: AgentRuntimeStatus["id"],
  name: string,
  enabled: boolean,
): AgentRuntimeStatus => ({
  id,
  name,
  enabled,
  installed: true,
  version: "1.0.0",
  auth: { status: "signed-in", billing: "subscription" },
  commandSandbox: "os",
  permissionMode: "standard",
  diagnostics: [],
});
let catalog: AgentModelCatalog;
const loginAgentRuntime = vi.fn<() => Promise<{ url?: string; command?: string }>>();
const api = {
  loginAgentRuntime,
  recheckAgentRuntime: vi.fn<(id: AgentRuntimeStatus["id"]) => Promise<AgentRuntimeStatus>>(),
  listModels: vi.fn(async () => catalog),
  waitForRuntime: vi.fn(async () => {}),
  updateAgentRuntime: vi.fn(
    async (
      id: AgentRuntimeStatus["id"],
      change: Partial<AgentRuntimeStatus>,
    ) => ({
      ...agent(id, "Claude Code", true),
      ...change,
    }),
  ),
  listAgentRuntimes: vi.fn(async () => [
    agent("claude-code-cli", "Claude Code", true),
    agent("codex-cli", "Codex", false),
    { ...agent("qoder-cli", "Qoder", false), auth: { status: "unknown" as const, billing: "unknown" as const } },
  ]),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { AgentsSettings } = await import("../src/renderer/agents-settings.js");
const initialLanguage = i18next.language;

const gpt = {
  provider: "openai",
  providerName: "OpenAI",
  id: "gpt-5",
  name: "GPT-5",
  reasoningLevels: [],
};
const sonnet = {
  provider: "claude-code-cli",
  providerName: "Claude Code",
  id: "sonnet",
  name: "Sonnet",
  reasoningLevels: [],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  api.recheckAgentRuntime.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await i18next.changeLanguage(initialLanguage);
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "ohMyGameDesktop");
});

async function render(
  onViewChange = vi.fn(),
  onOpenProviders = vi.fn(),
): Promise<void> {
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agents" }}
        onViewChange={onViewChange}
        onOpenProviders={onOpenProviders}
      />,
    ),
  );
}
const row = (name: string) =>
  [...host.querySelectorAll(".settings-provider-row")].find(
    (item) =>
      item.querySelector(".settings-provider-name > span")?.textContent ===
      name,
  );

it("lists OhMyGame's own agent with its default model above the coding agent CLIs", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "openai", id: "gpt-5" },
    defaultReasoningLevel: "medium",
  };
  const onOpenProviders = vi.fn();
  await render(vi.fn(), onOpenProviders);
  const names = [
    ...host.querySelectorAll(".settings-provider-name > span"),
  ].map((item) => item.textContent);
  expect(names).toEqual(["OhMyGame", "Codex", "Qoder"]);
  expect(
    row("OhMyGame")!.querySelector(".settings-provider-details"),
  ).toBeNull();
  expect(row("OhMyGame")!.querySelector("small")?.textContent).toBe("Default");
  expect(row("Claude Code")).toBeUndefined();
  expect(row("Qoder")!.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
  expect(row("Qoder")!.querySelector("small")).toBeNull();
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  await act(async () =>
    row("OhMyGame")!
      .querySelector<HTMLButtonElement>('button[aria-label="Manage models"]')!
      .click(),
  );
  expect(onOpenProviders).toHaveBeenCalled();
});

it("marks the CLI new conversations start with and opens its settings", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "codex-cli", id: "fixture-model" },
    defaultReasoningLevel: "medium",
  };
  const onViewChange = vi.fn();
  await render(onViewChange);
  expect(row("OhMyGame")!.querySelector("small")).toBeNull();
  expect(
    row("Codex")!.querySelector(".settings-provider-name small")
      ?.textContent,
  ).toBe("Default");
  await act(async () =>
    row("Codex")!
      .querySelector<HTMLButtonElement>('button[aria-label="Manage Codex"]')!
      .click(),
  );
  expect(onViewChange).toHaveBeenCalledWith({ page: "agent", id: "codex-cli" });
});

it("waits for a CLI still listing its models before marking OhMyGame as the default", async () => {
  catalog = {
    models: [gpt],
    loadingRuntimes: ["claude-code-cli"],
    defaultReasoningLevel: "medium",
  };
  await render();
  expect(row("OhMyGame")!.querySelector("small")).toBeNull();
});

it("asks for a provider when OhMyGame has no models", async () => {
  catalog = { models: [sonnet], defaultReasoningLevel: "medium" };
  await render();
  expect(row("OhMyGame")!.textContent).toContain(
    "No models yet. Connect a provider in Providers & Models.",
  );
});

it("shows a CLI's command sandbox as one row on its detail page", async () => {
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "claude-code-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  const rows = [...host.querySelectorAll(".settings-provider-setting-row")].map(
    (item) => item.textContent,
  );
  expect(rows).toContain("Command sandboxOperating system");
  expect(host.textContent).toContain(
    "Leave empty and save to find the CLI automatically.",
  );
});

it("labels the verified version as a reference and identifies a missing CLI capability", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", true),
      version: "0.162.0-alpha.17.2",
      testedVersion: "0.163.0",
      diagnostics: [
        {
          code: "runtime-incompatible",
          message: "Probe details",
          capability: "permissions / activePermissionProfile",
        },
      ],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain("v0.163.0 (reference only)");
  expect(host.textContent).toContain("permissions / activePermissionProfile");
  expect(host.textContent).toContain("CLI incompatible");
  expect(host.textContent).not.toContain("too old");
});

it("switches a CLI to full access and says what that means", async () => {
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "claude-code-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector(".coding-agent-warning")).toBeNull();
  const full = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Full access",
  )!;
  await act(async () => full.click());
  expect(api.updateAgentRuntime).toHaveBeenCalledWith("claude-code-cli", {
    permissionMode: "full",
  });
  expect(host.querySelector(".coding-agent-warning")?.textContent).toContain(
    "without a sandbox or asking",
  );
  expect(
    [...host.querySelectorAll(".settings-provider-setting-row")].map(
      (row) => row.textContent,
    ),
  ).toContain("Command sandboxOff, full access");
});

it("offers Qoder through the existing agent list and keeps its detail controlled", async () => {
  catalog = { models: [gpt], defaultReasoningLevel: "medium" };
  const onViewChange = vi.fn();
  await render(onViewChange);
  await act(async () => row("Qoder")!.querySelector<HTMLButtonElement>('button[aria-label="Manage Qoder"]')!.click());
  expect(onViewChange).toHaveBeenCalledWith({ page: "agent", id: "qoder-cli" });
  api.listAgentRuntimes.mockResolvedValueOnce([{
    ...agent("qoder-cli", "Qoder", false),
    // A stale stored value must never present Full access as available.
    permissionMode: "full",
    auth: { status: "unknown", billing: "unknown" },
  }]);
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "qoder-cli" }} onViewChange={onViewChange} onOpenProviders={vi.fn()} />));
  const rows = [...host.querySelectorAll(".settings-provider-setting-row")].map(item => item.textContent);
  expect(rows).toContain("Command sandboxControlled OhMyGame tools only");
  expect(rows).toContain("AccountUnknownCheck again");
  expect(rows).toContain("BillingUnknown");
  expect(host.querySelector(".coding-agent-permission")).toBeNull();
  expect(host.querySelector(".coding-agent-warning")).toBeNull();
  expect(host.textContent).toContain("Qoder uses a separate sign-in and configuration");
  expect(host.textContent).toContain("Kunpo selections");
  expect(host.textContent).not.toContain("uses your CLI configuration");
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
});

it.each([
  { locale: "en", account: "Not checked", recheck: "Check again", prepare: "Prepare sign-in command", notice: "Sign-in status has not been checked during this app session. Check again.", signedOut: "Not signed in" },
  { locale: "zh-CN", account: "待检查", recheck: "重新检查", prepare: "准备登录命令", notice: "本次启动尚未检查登录状态，请重新检查。", signedOut: "未登录" },
])("keeps Qoder's cold login state unverified until an explicit check in $locale", async ({ locale, account, recheck, prepare, notice, signedOut }) => {
  await i18next.changeLanguage(locale);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const pending: AgentRuntimeStatus = {
    ...agent("qoder-cli", "Qoder", false),
    auth: { status: "unknown", billing: "unknown", account: "previous-account" },
    diagnostics: [{ code: "check-required", message: "No account check in this daemon process" }],
  };
  api.listAgentRuntimes.mockResolvedValueOnce([pending]);
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "qoder-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />));
  const accountRow = host.querySelector(".settings-provider-auth-row")!;
  expect(accountRow.querySelector(".settings-provider-setting-value")?.textContent).toBe(account);
  expect(host.textContent).toContain(notice);
  expect(host.textContent).not.toContain(signedOut);
  expect(host.textContent).not.toContain("previous-account");
  const check = accountRow.querySelector<HTMLButtonElement>(`button[aria-label="${recheck}"]`)!;
  expect(check.textContent).toBe(recheck);
  expect(check.classList.contains("settings-add-button")).toBe(true);
  expect(host.querySelectorAll(`button[aria-label="${recheck}"]`)).toHaveLength(1);
  const manual = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === prepare)!;
  expect(manual.classList.contains("coding-agent-link")).toBe(true);
  expect(api.recheckAgentRuntime).not.toHaveBeenCalled();
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  expect(api.listModels).not.toHaveBeenCalled();

  let finish!: (status: AgentRuntimeStatus) => void;
  api.recheckAgentRuntime.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => check.click());
  expect(check.disabled).toBe(true);
  expect(manual.disabled).toBe(true);
  expect(api.recheckAgentRuntime).toHaveBeenCalledExactlyOnceWith("qoder-cli");
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  await act(async () => finish({ ...agent("qoder-cli", "Qoder", false), auth: { status: "signed-in", billing: "subscription", account: "verified-fixture-account" } }));
  expect(accountRow.querySelector(".settings-provider-setting-value")?.textContent).toBe("verified-fixture-account");
  expect(host.textContent).not.toContain(notice);
  expect(host.querySelectorAll(`button[aria-label="${recheck}"]`)).toHaveLength(1);
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it.each([
  { locale: "en", code: "probe-failed" as const, account: "Unknown", recheck: "Check again", notice: "Qoder’s sign-in status could not be confirmed. Check again.", signedOut: "Not signed in" },
  { locale: "zh-CN", code: "probe-failed" as const, account: "未知", recheck: "重新检查", notice: "未能确认 Qoder 的登录状态，请重新检查。", signedOut: "未登录" },
  { locale: "en", code: "models-unavailable" as const, account: "verified-fixture-account", recheck: "Check again", notice: "Qoder did not list its models.", signedOut: "Not signed in" },
  { locale: "zh-CN", code: "models-unavailable" as const, account: "verified-fixture-account", recheck: "重新检查", notice: "Qoder 没有返回模型列表。", signedOut: "未登录" },
])("asks to recheck Qoder after $code without claiming sign-out in $locale", async ({ locale, code, account, recheck, notice, signedOut }) => {
  await i18next.changeLanguage(locale);
  api.listAgentRuntimes.mockResolvedValueOnce([{
    ...agent("qoder-cli", "Qoder", false),
    auth: code === "models-unavailable" ? { status: "signed-in", billing: "subscription", account } : { status: "unknown", billing: "unknown" },
    diagnostics: [{ code, message: "Fixture check failed without an authentication verdict" }],
  }]);
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "qoder-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />));
  const accountRow = host.querySelector(".settings-provider-auth-row")!;
  expect(accountRow.querySelector(".settings-provider-setting-value")?.textContent).toBe(account);
  expect(accountRow.querySelector("button")?.textContent).toBe(recheck);
  expect(host.querySelectorAll(`button[aria-label="${recheck}"]`)).toHaveLength(1);
  expect(host.textContent).toContain(notice);
  expect(host.textContent).not.toContain(signedOut);
  expect(api.recheckAgentRuntime).not.toHaveBeenCalled();
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  expect(loginAgentRuntime).not.toHaveBeenCalled();
});

it("refreshes account limits when the model probe finishes after the first status read", async () => {
  catalog = { models: [gpt], defaultReasoningLevel: "medium" };
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  api.listModels.mockImplementationOnce(async () => {
    await waiting;
    return catalog;
  });
  api.listAgentRuntimes
    .mockResolvedValueOnce([agent("codex-cli", "Codex", true)])
    .mockResolvedValueOnce([
      {
        ...agent("codex-cli", "Codex", true),
        limits: [{ id: "codex/primary", usedPercent: 42, windowMinutes: 300 }],
      },
    ]);
  await render();
  expect(row("Codex")!.querySelector(".agent-usage-inline")).toBeNull();
  await act(async () => finish());
  expect(row("Codex")!.querySelector(".agent-usage-inline")?.textContent).toBe(
    "5-hour42% used",
  );
});

it("shows each CLI's usage limits in its row and on its detail page", async () => {
  const limits = [
    { id: "claude/five_hour", usedPercent: 13, windowMinutes: 300 },
    { id: "claude/seven_day", usedPercent: 33, windowMinutes: 10080 },
  ];
  api.listAgentRuntimes.mockResolvedValue([
    { ...agent("claude-code-cli", "Claude Code", true), limits },
    agent("codex-cli", "Codex", false),
    agent("opencode-cli", "OpenCode", true),
  ]);
  catalog = { models: [gpt], defaultReasoningLevel: "medium" };
  await render();
  expect(row("Claude Code")).toBeUndefined();
  expect(row("Codex")!.querySelector(".agent-usage-inline")).toBeNull();
  const detail = async (id: "claude-code-cli" | "codex-cli" | "opencode-cli") =>
    act(async () =>
      root.render(
        <AgentsSettings
          view={{ page: "agent", id }}
          onViewChange={vi.fn()}
          onOpenProviders={vi.fn()}
        />,
      ),
    );
  await detail("claude-code-cli");
  expect(host.textContent).toContain("Claude Code uses your CLI configuration");
  expect(host.textContent).not.toContain("Use my own CLI configuration");
  expect(host.textContent).toContain("Usage limits");
  expect(host.textContent).toContain("33% used");
  await detail("codex-cli");
  expect(host.textContent).toContain("Codex uses a separate sign-in and configuration");
  expect(host.textContent).toContain("media keeps the project’s Kunpo selections");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Full access")).toBe(false);
  expect(host.textContent).not.toContain("Use my own CLI configuration");
  expect(host.textContent).toContain("Shown after a conversation with Codex.");
  await detail("opencode-cli");
  expect(host.textContent).not.toContain("Usage limits");
  expect(host.textContent).toContain("uses your CLI configuration");
  expect(host.textContent).not.toContain("Use my own CLI configuration");
});

it("shows the resolved CLI source separately from an empty automatic path override", async () => {
  const binaryPath =
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", false),
      binaryPath,
      binarySource: "codex-app",
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(
    host.querySelector<HTMLInputElement>("#codex-cli-executable")!.value,
  ).toBe("");
  expect(host.textContent).toContain("Bundled with Codex");
  expect(
    host.querySelector(".coding-agent-executable-path code")?.textContent,
  ).toBe(binaryPath);
});

it("keeps an invalid manual path editable and explains how to restore automatic detection", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", false),
      installed: false,
      configuredBinaryPath: "/missing/codex",
      diagnostics: [{ code: "invalid-executable", message: "Missing" }],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(
    host.querySelector<HTMLInputElement>("#codex-cli-executable")!.value,
  ).toBe("/missing/codex");
  expect(host.textContent).toContain("Configured executable unavailable");
  expect(host.textContent).toContain(
    "clear it and save to restore automatic detection",
  );
  expect(host.textContent).not.toContain("Installation guide");
});

it("does not label a failed CLI probe as a successful installation check", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", false),
      diagnostics: [{ code: "probe-failed", message: "Failed to start" }],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain("CLI check failed");
});

it("explains a Windows sandbox incompatibility instead of reporting an empty model catalog", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", true),
      diagnostics: [
        {
          code: "runtime-incompatible",
          capability: "Windows sandbox filesystem read restrictions",
          message: "Codex sandbox cannot enforce read restrictions",
        },
      ],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain("unelevated Windows sandbox");
  expect(host.textContent).toContain("Set up the elevated sandbox");
  expect(host.textContent).toContain("Windows sandbox guide");
  expect(host.textContent).not.toContain("Codex did not list its models");
});


async function loginDetail() {
  api.listAgentRuntimes.mockResolvedValueOnce([{ ...agent("codex-cli", "Codex", false), auth: { status: "signed-out", billing: "unknown" } }]);
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "codex-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />));
  return [...host.querySelectorAll("button")].find(button => button.textContent === "Sign in")!;
}

it("opens the prepared Codex URL through its own desktop channel without claiming browser success", async () => {
  const url = "https://auth.openai.com/oauth/authorize?state=fixture";
  loginAgentRuntime.mockResolvedValue({ url });
  const open = vi.fn(async () => {}), retired = vi.fn(async () => {});
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { openCodexLogin: open, openExternal: retired } });
  const button = await loginDetail();
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(open).toHaveBeenCalledWith(url);
  expect(retired).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Your sign-in link is ready");
  expect(host.textContent).not.toContain("page opened");
  expect(host.querySelector('a[href="' + url + '"]')).not.toBeNull();
});

it("reports failed browser opening, keeps a copyable link, and catches a failed retry", async () => {
  const url = "https://auth.openai.com/oauth/authorize?state=fixture";
  loginAgentRuntime.mockResolvedValue({ url });
  const open = vi.fn(async () => { throw new Error("SENSITIVE_BROWSER_DETAIL"); });
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { openCodexLogin: open } });
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const button = await loginDetail();
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not open your browser");
  expect(host.textContent).not.toContain("SENSITIVE_BROWSER_DETAIL");
  const link = host.querySelector('a[href="' + url + '"]')!;
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(open).toHaveBeenCalledTimes(2);
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Copy sign-in link")!.click());
  expect(copy).toHaveBeenCalledWith(url);
  expect(host.textContent).toContain("Copied");
  copy.mockRejectedValue(new Error("denied"));
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Copied")!.click());
  expect(host.textContent).toContain("Right-click the sign-in link");
  Reflect.deleteProperty(navigator, "clipboard");
});

it("shows preparation and backend failures without opening a stale sign-in link", async () => {
  let fail!: (cause: unknown) => void;
  loginAgentRuntime.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const button = await loginDetail();
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(host.textContent).toContain("Preparing the sign-in link");
  await act(async () => fail(new Error("Fixture could not prepare sign-in")));
  expect(button.disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Fixture could not prepare sign-in");
  expect(host.querySelector('a[target="_blank"]')).toBeNull();
});


it("explains an empty login response and an older desktop preload", async () => {
  loginAgentRuntime.mockResolvedValueOnce({});
  const button = await loginDetail();
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("No sign-in link was returned");
  const retired = vi.fn();
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { openExternal: retired } });
  loginAgentRuntime.mockResolvedValueOnce({ url: "https://auth.openai.com/oauth/authorize?state=fixture" });
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("save your work and restart");
  expect(retired).not.toHaveBeenCalled();
});

it("prepares Qoder's server-provided command only after a click without opening a browser", async () => {
  const command = "fixture-independent-qoder-sign-in";
  const open = vi.fn(async () => {});
  const copy = vi.fn(async () => {});
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { openCodexLogin: open, openExternal: open } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  api.listAgentRuntimes.mockResolvedValueOnce([{ ...agent("qoder-cli", "Qoder", false), auth: { status: "unknown", billing: "unknown" } }]);
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "qoder-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />));
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === "Prepare sign-in command")!;
  expect(loginAgentRuntime).not.toHaveBeenCalled();
  let finish!: (value: { command: string; url: string }) => void;
  loginAgentRuntime.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button.click());
  expect(host.textContent).toContain("Preparing the sign-in command");
  expect(button.disabled).toBe(true);
  await act(async () => finish({ command, url: "https://example.invalid/unexpected-login" }));
  expect(loginAgentRuntime).toHaveBeenCalledExactlyOnceWith("qoder-cli");
  expect(host.querySelector("code")?.textContent).toBe(command);
  expect(host.textContent).toContain("Run this command yourself, complete sign-in, then check again");
  expect(host.textContent).not.toContain("Your sign-in link is ready");
  expect(host.querySelector('a[target="_blank"]')).toBeNull();
  expect(open).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')!.click());
  expect(copy).toHaveBeenCalledWith(command);
  loginAgentRuntime.mockResolvedValueOnce({ url: "https://example.invalid/unexpected-login" });
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("No sign-in command was returned");
  expect(host.querySelector("code")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, "clipboard");
});
