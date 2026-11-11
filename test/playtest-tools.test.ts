import { describe, expect, it, vi } from "vitest";
import { createGameUseTool, previewUrl } from "../src/daemon/playtest-tools.js";
import { WEB_GAME_USE_CAPABILITIES, playtestActionError, playtestOpenError, type GameRuntimeAdapter, type GameUseCapabilities, type PlaytestRequest, type PlaytestResult, type PlaytestSnapshot } from "../src/shared/playtest.js";
import { AutoContinueTools } from "../src/daemon/agent-auto-continue.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { OwnedPlaytestDriver } from "../src/daemon/owned-playtest.js";
import { reportIsolatedOperation } from "../src/daemon/isolated-tool-receipts.js";

const snapshot: PlaytestSnapshot = {
  sessionId: "session-1",
  runtime: "web",
  capabilities: WEB_GAME_USE_CAPABILITIES,
  url: "http://127.0.0.1:43210/level-1",
  title: "Test Game",
  readyState: "complete",
  viewport: { width: 1280, height: 720 },
  elements: [],
  canvases: [{ index: 0, width: 1280, height: 720, box: { x: 0, y: 0, width: 1280, height: 720 }, visible: true }],
  logs: [],
  failedRequests: [],
  gameState: { scene: "level-1", score: 10 },
  bridgeCapabilities: ["snapshot", "reset"],
};

class FakeDriver implements GameRuntimeAdapter {
  available = true;
  readonly capabilities: GameUseCapabilities;
  readonly requests: PlaytestRequest[] = [];
  close = vi.fn();

  constructor(capabilities: GameUseCapabilities = WEB_GAME_USE_CAPABILITIES) {
    this.capabilities = capabilities;
  }

  async request(request: PlaytestRequest): Promise<PlaytestResult> {
    this.requests.push(request);
    if (request.operation === "capture") {
      return {
        operation: "capture",
        capture: {
          sessionId: request.sessionId,
          mediaType: "image/jpeg",
          data: Buffer.from("jpeg").toString("base64"),
          width: 1280,
          height: 720,
          analysis: { sampledPixels: 100, opaqueRatio: 1, luminanceMean: 80, luminanceVariance: 12, likelyBlank: false },
        },
      };
    }
    if (request.operation === "close" || request.operation === "closeAll") return { operation: request.operation };
    return { operation: request.operation, snapshot };
  }
}

describe("game use tool", () => {
  it("uses a provider-compatible object schema at the function root", () => {
    const tool = createGameUseTool(new FakeDriver(), async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters).not.toHaveProperty("anyOf");
    expect(tool.parameters.required).toContain("operation");
  });

  it("starts the current preview and opens a project-local route", async () => {
    const driver = new FakeDriver();
    const resolveOpenTarget = vi.fn(async () => ({ runtime: "web" as const, url: "http://127.0.0.1:43210/" }));
    const tool = createGameUseTool(driver, resolveOpenTarget);

    const result = await tool.execute("open-1", {
      operation: "open",
      path: "/level-1?difficulty=hard",
      viewport: { width: 390, height: 844 },
    }, undefined, undefined, {} as never);

    expect(resolveOpenTarget).toHaveBeenCalledOnce();
    expect(driver.requests).toEqual([{
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43210/level-1?difficulty=hard" },
      viewport: { width: 390, height: 844 },
    }]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"score": 10') });
  });

  it("returns screenshots to the model as image content", async () => {
    const tool = createGameUseTool(new FakeDriver(), async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    const result = await tool.execute("capture-1", {
      operation: "capture",
      sessionId: "session-1",
    }, undefined, undefined, {} as never);

    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining('"likelyBlank": false') },
      { type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("waits for the initial snapshot and runs open actions once in order on the new session", async () => {
    const driver = new FakeDriver();
    let ready!: (result: PlaytestResult) => void;
    const opening = new Promise<PlaytestResult>((resolve) => { ready = resolve; });
    const afterClick = { ...snapshot, gameState: { scene: "playing", clicks: 1 } };
    const request = vi.spyOn(driver, "request")
      .mockReturnValueOnce(opening)
      .mockResolvedValueOnce({ operation: "act", snapshot: afterClick });
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: snapshot.url }));
    const actions = [{ type: "click", target: { text: "Start" } }, { type: "press", key: "ArrowUp" }] as const;
    const running = tool.execute("open-act", { operation: "open", actions: [...actions] }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0].operation).toBe("open");
    ready({ operation: "open", snapshot });
    expect((await running).details).toEqual({ playtest: afterClick });
    expect(request.mock.calls.slice(1)).toEqual([[{ operation: "act", sessionId: snapshot.sessionId, actions }, undefined]]);
  });

  it("reports the open session on action failure without sending the batch again", async () => {
    const driver = new FakeDriver();
    const request = vi.spyOn(driver, "request")
      .mockResolvedValueOnce({ operation: "open", snapshot })
      .mockRejectedValueOnce(new Error("Playtest target was not found or is not visible"));
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: snapshot.url }));
    await expect(tool.execute("open-failure", { operation: "open", actions: [{ type: "click", target: { text: "Missing" } }] }, undefined, undefined, {} as never))
      .rejects.toThrow(/target was not found.*Inspect session "session-1"/);
    expect(request.mock.calls.map(([request]) => request.operation)).toEqual(["open", "act"]);
  });

  it.each([0, 1])("retains %i completed actions and requires successful inspection before more input", async completedActions => {
    const driver = new FakeDriver();
    const request = vi.spyOn(driver, "request").mockRejectedValueOnce(playtestActionError("Target missing", {
      version: 1, sessionId: snapshot.sessionId, completedActions, failedAction: completedActions + 1,
      actionType: "click", phase: "target_lookup", inputDispatched: false,
    }));
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: snapshot.url }));
    const guard = new AutoContinueTools([tool]); guard.reset();
    const watched = guard.wrap()[0]!;
    const actions = Array.from({ length: completedActions + 1 }, () => ({ type: "click" as const, target: { text: "Start" } }));
    const result = await watched.execute("lookup-failed", { operation: "act", sessionId: snapshot.sessionId, actions }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ playtestAction: { status: completedActions ? "partially_completed" : "not_executed", completedActions, inputDispatched: false, requiresInspection: true } });
    await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
    const remaining = { operation: "act" as const, sessionId: snapshot.sessionId, actions: [{ type: "press" as const, key: "Enter" }] };
    const blocked = await watched.execute("without-inspect", remaining, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(blocked)).toMatchObject({ effect: "none", reason: "playtest_inspection_required", disposition: "correctable" });
    // A new tool view over the same owned driver cannot forget the failed batch.
    const reopened = createGameUseTool(driver, async () => ({ runtime: "web", url: snapshot.url }));
    await expect(reopened.execute("new-view", remaining, undefined, undefined, {} as never)).rejects.toThrow("Inspect session");
    request.mockRejectedValueOnce(new Error("Inspection unavailable"));
    await expect(watched.execute("inspect-failed", { operation: "inspect", sessionId: snapshot.sessionId }, undefined, undefined, {} as never)).rejects.toThrow("Inspection unavailable");
    await watched.execute("capture", { operation: "capture", sessionId: snapshot.sessionId }, undefined, undefined, {} as never);
    await expect(reopened.execute("still-uninspected", remaining, undefined, undefined, {} as never)).rejects.toThrow("Inspect session");
    await watched.execute("inspect", { operation: "inspect", sessionId: snapshot.sessionId }, undefined, undefined, {} as never);
    await watched.execute("continue", remaining, undefined, undefined, {} as never);
    expect(request.mock.calls.filter(([call]) => call.operation === "act")).toHaveLength(2);
    expect(request.mock.calls.at(-1)?.[0]).toEqual(remaining);
  });
  it("keeps uncertain delivery and forged action receipts unconfirmed", async () => {
    for (const forged of [false, true]) {
      const receipt = { version: 1 as const, sessionId: snapshot.sessionId, completedActions: 0, failedAction: 1, actionType: "click" as const, phase: "target_lookup" as const, inputDispatched: false as const };
      const cause = forged ? Object.assign(new Error("Untrusted receipt"), { actionFailure: receipt })
        : playtestActionError("Dispatch failed", { ...receipt, phase: "action", inputDispatched: "unknown" });
      const driver = new FakeDriver(); vi.spyOn(driver, "request").mockRejectedValueOnce(cause);
      const guard = new AutoContinueTools([createGameUseTool(driver, async () => ({ runtime: "web", url: snapshot.url }))]); guard.reset();
      await expect(guard.wrap()[0]!.execute("uncertain", { operation: "act", sessionId: snapshot.sessionId, actions: [{ type: "click", target: { text: "Start" } }] }, undefined, undefined, {} as never)).rejects.toThrow("Inspect session");
      await expect(guard.prepare(new AbortController().signal)).rejects.toThrow("unconfirmed");
    }
  });

  it("corrects a session-limit rejection through owned inspection and cleanup without replaying the rejected open", async () => {
    const shared = new FakeDriver();
    const request = vi.spyOn(shared, "request").mockResolvedValueOnce({ operation: "open", snapshot })
      .mockResolvedValueOnce({ operation: "open", snapshot: { ...snapshot, sessionId: "foreign-session" } })
      .mockRejectedValueOnce(playtestOpenError("Session limit", { version: 1, reason: "session_limit", limit: 4, windowCreated: false }));
    const owned = new OwnedPlaytestDriver(shared), foreign = new OwnedPlaytestDriver(shared);
    const open = { operation: "open" as const, target: { runtime: "web" as const, url: snapshot.url }, viewport: snapshot.viewport };
    await owned.request(open); await foreign.request(open);
    const guard = new AutoContinueTools([createGameUseTool(owned, async () => ({ runtime: "web", url: snapshot.url }))]); guard.reset();
    const tool = guard.wrap()[0]!, args = { operation: "open", actions: [{ type: "press", key: "Enter" }] };
    const failure = await tool.execute("open-full", args, undefined, undefined, {} as never).catch(error => error);
    expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", reason: "playtest_session_limit", disposition: "correctable" });
    expect(failure.message).toContain('"session-1"'); expect(failure.message).not.toContain("foreign-session");
    expect(request.mock.calls.map(([call]) => call.operation)).toEqual(["open", "open", "open"]);
    await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
    await tool.execute("inspect-owned", { operation: "inspect", sessionId: snapshot.sessionId }, undefined, undefined, {} as never);
    await tool.execute("close-finished", { operation: "close", sessionId: snapshot.sessionId }, undefined, undefined, {} as never);
    await tool.execute("new-open", args, undefined, undefined, {} as never);
    expect(request.mock.calls.map(([call]) => call.operation)).toEqual(["open", "open", "open", "inspect", "close", "open", "act"]);
    await expect(tool.execute("open-full", args, undefined, undefined, {} as never)).rejects.toBe(failure);
    await expect(owned.request({ operation: "close", sessionId: "foreign-session" })).rejects.toThrow("belong");
  });
  it.each(["text", "properties", "isolated-effects"])("keeps %s open failures unknown rather than trusting a false no-effect claim", async variant => {
    const receipt = { version: 1 as const, reason: "session_limit" as const, limit: 4, windowCreated: false as const };
    const cause = variant === "isolated-effects" ? playtestOpenError("Session limit", receipt)
      : Object.assign(new Error("Close an existing game session before opening more than 4"), variant === "properties" ? { openFailure: receipt } : {});
    const driver = new FakeDriver(); vi.spyOn(driver, "request").mockRejectedValueOnce(cause);
    const resolve = async () => {
      if (variant === "isolated-effects") {
        const binding = { scope: "project_command" as const, namespace: "test" as const, projectId: "11111111-1111-4111-8111-111111111111", operationId: "a".repeat(32) };
        await reportIsolatedOperation({ ...binding, phase: "input_preflight" });
        await reportIsolatedOperation({ ...binding, phase: "prepare_submitting" });
      }
      return { runtime: "web" as const, url: snapshot.url };
    };
    const guard = new AutoContinueTools([createGameUseTool(driver, resolve)]); guard.reset();
    await expect(guard.wrap()[0]!.execute("uncertain-open", { operation: "open" }, undefined, undefined, {} as never)).rejects.toThrow();
    await expect(guard.prepare(new AbortController().signal)).rejects.toThrow("unconfirmed");
    expect(guard.recoverySummary).not.toContain("not_executed");
  });

  it("refuses routes outside the current preview origin", () => {
    expect(() => previewUrl("http://127.0.0.1:43210/", "https://example.com/game"))
      .toThrow("current project preview");
  });

  it("fails clearly when the desktop driver disconnects", async () => {
    const driver = new FakeDriver();
    driver.available = false;
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    await expect(tool.execute("inspect-1", {
      operation: "inspect",
      sessionId: "session-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("not available");
  });

  it("validates fields required by session operations", async () => {
    const tool = createGameUseTool(new FakeDriver(), async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    await expect(tool.execute("inspect-1", {
      operation: "inspect",
    }, undefined, undefined, {} as never)).rejects.toThrow("sessionId is required for inspect");
    await expect(tool.execute("act-1", {
      operation: "act",
      sessionId: "session-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("actions are required for act");
  });

  it("rejects actions that the runtime does not advertise", async () => {
    const driver = new FakeDriver({ ...WEB_GAME_USE_CAPABILITIES, input: ["keyboard"], observation: ["screenshot"] });
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    await expect(tool.execute("act-unsupported", {
      operation: "act",
      sessionId: "session-1",
      actions: [{ type: "click", target: { x: 20, y: 20 } }],
    }, undefined, undefined, {} as never)).rejects.toThrow("does not support pointer input");
    expect(driver.requests).toHaveLength(0);
    const openTarget = vi.fn(async () => ({ runtime: "web" as const, url: snapshot.url }));
    const openTool = createGameUseTool(driver, openTarget);
    await expect(openTool.execute("open-unsupported", {
      operation: "open",
      actions: [{ type: "press", key: "Enter" }, { type: "click", target: { x: 20, y: 20 } }],
    }, undefined, undefined, {} as never)).rejects.toThrow("does not support pointer input");
    expect(openTarget).not.toHaveBeenCalled();
    expect(driver.requests).toHaveLength(0);
  });

  it("does not apply web preview paths to non-web targets", async () => {
    const driver = new FakeDriver({
      ...WEB_GAME_USE_CAPABILITIES,
      runtime: "godot",
      projectTypes: ["godot-game"],
    });
    const tool = createGameUseTool(driver, async () => ({ runtime: "godot", projectPath: "/tmp/game" }));

    await expect(tool.execute("open-godot-path", {
      operation: "open",
      path: "/level-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("path is only supported by the web game runtime");
    expect(driver.requests).toHaveLength(0);
  });
});
