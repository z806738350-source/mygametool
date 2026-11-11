import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProcessPlaytestDriver } from "../src/daemon/playtest-driver.js";
import { getPlaytestActionFailure, getPlaytestOpenFailure, type PlaytestIpcMessage } from "../src/shared/playtest.js";

class FakeIpc extends EventEmitter {
  connected = true;
  readonly sent: PlaytestIpcMessage[] = [];

  send(message: PlaytestIpcMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

describe("process playtest driver", () => {
  it.each(["valid", "version", "reason", "limit", "window", "operation", "message-only"])("trusts only a bound pre-window open rejection (%s)", async variant => {
    const ipc = new FakeIpc(), driver = new ProcessPlaytestDriver(ipc);
    const result = driver.request(variant === "operation" ? { operation: "inspect", sessionId: "session-1" }
      : { operation: "open", target: { runtime: "web", url: "http://127.0.0.1:1234/" }, viewport: { width: 800, height: 600 } });
    const sent = ipc.sent[0]!;
    const failure = { version: variant === "version" ? 2 : 1, reason: variant === "reason" ? "unexpected" : "session_limit", limit: variant === "limit" ? -1 : 4, windowCreated: variant === "window" };
    ipc.emit("message", { channel: "ohmygame:playtest-response", id: sent.id, error: "Close an existing game session", ...(variant === "message-only" ? {} : { openFailure: failure }) });
    const cause = await result.catch(error => error);
    if (variant === "valid") expect(getPlaytestOpenFailure(cause)).toEqual(failure);
    else expect(getPlaytestOpenFailure(cause)).toBeUndefined();
    driver.close();
  });
  it.each(["valid", "uncertain", "session", "count", "action", "phase", "request", "message-only"])("binds action progress to its exact pending request (%s)", async variant => {
    const ipc = new FakeIpc(), driver = new ProcessPlaytestDriver(ipc);
    const result = driver.request(variant === "request" ? { operation: "inspect", sessionId: "session-1" }
      : { operation: "act", sessionId: "session-1", actions: [{ type: "click", target: { text: "Start" } }] });
    const sent = ipc.sent[0]!;
    const failure = { version: 1, sessionId: variant === "session" ? "session-2" : "session-1", completedActions: variant === "count" ? 1 : 0,
      failedAction: 1, actionType: variant === "action" ? "press" : "click", phase: variant === "phase" ? "invented" : variant === "uncertain" ? "action" : "target_lookup", inputDispatched: variant === "uncertain" ? "unknown" : false };
    ipc.emit("message", { channel: "ohmygame:playtest-response", id: sent.id, error: "Target lookup failed", ...(variant === "message-only" ? {} : { actionFailure: failure }) });
    const cause = await result.catch(error => error);
    if (["valid", "uncertain"].includes(variant)) expect(getPlaytestActionFailure(cause)).toEqual(failure);
    else expect(getPlaytestActionFailure(cause)).toBeUndefined();
    driver.close();
  });
  it("correlates desktop responses with requests", async () => {
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc);
    const result = driver.request({ operation: "close", sessionId: "session-1" });
    const request = ipc.sent[0];
    if (request?.channel !== "ohmygame:playtest-request") throw new Error("Expected request");

    ipc.emit("message", {
      channel: "ohmygame:playtest-response",
      id: request.id,
      result: { operation: "close" },
    } satisfies PlaytestIpcMessage);

    await expect(result).resolves.toEqual({ operation: "close" });
    driver.close();
  });

  it("cancels the desktop request when the agent aborts", async () => {
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc);
    const controller = new AbortController();
    const result = driver.request({ operation: "inspect", sessionId: "session-1" }, controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(ipc.sent.map((message) => message.channel)).toEqual([
      "ohmygame:playtest-request",
      "ohmygame:playtest-cancel",
    ]);
    driver.close();
  });

  it("fails pending work when desktop disconnects", async () => {
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc);
    const result = driver.request({ operation: "inspect", sessionId: "session-1" });
    ipc.connected = false;
    ipc.emit("disconnect");

    await expect(result).rejects.toThrow("disconnected");
    expect(driver.available).toBe(false);
    driver.close();
  });

  it("times out requests that never receive a response", async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc, 25);
    const result = driver.request({ operation: "inspect", sessionId: "session-1" });
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(ipc.sent.at(-1)?.channel).toBe("ohmygame:playtest-cancel");
    driver.close();
    vi.useRealTimers();
  });
});
