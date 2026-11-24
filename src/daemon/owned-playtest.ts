import { playtestActionError, type GameRuntimeAdapter, type PlaytestRequest, type PlaytestResourceStatus, type PlaytestResult } from "../shared/playtest.js";

/** Restricts an agent's tools and cleanup to windows it opened. */
export class OwnedPlaytestDriver implements GameRuntimeAdapter {
  readonly #sessions = new Set<string>();
  readonly #closed = new Set<string>();
  readonly #pending = new Set<Promise<PlaytestResult>>();

  constructor(private readonly driver: GameRuntimeAdapter) {}

  get available() { return this.driver.available; }
  get capabilities() { return this.driver.capabilities; }
  ownedSessionIds(): readonly string[] { return [...this.#sessions]; }

  async sessionStatus(sessionId: string, signal?: AbortSignal): Promise<PlaytestResourceStatus> {
    signal?.throwIfAborted();
    if (this.#closed.has(sessionId)) return "closed";
    if (!this.#sessions.has(sessionId)) return "unknown";
    const observed = await this.driver.request({ operation: "sessionStatus", sessionId }, signal).catch(() => undefined);
    signal?.throwIfAborted();
    if (observed?.operation !== "sessionStatus" || observed.sessionId !== sessionId) return "unknown";
    if (observed.resourceStatus === "closed") this.#rememberClosed(sessionId);
    return observed.resourceStatus === "live" || observed.resourceStatus === "closing" || observed.resourceStatus === "closed" ? observed.resourceStatus : "unknown";
  }

  async request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult> {
    signal?.throwIfAborted();
    if (request.operation === "closeAll") {
      await this.cleanup();
      return { operation: "closeAll" };
    }
    if (request.operation === "sessionStatus" && (this.#sessions.has(request.sessionId) || this.#closed.has(request.sessionId)))
      return { operation: "sessionStatus", sessionId: request.sessionId, resourceStatus: await this.sessionStatus(request.sessionId, signal) };
    if (request.operation === "close" && this.#closed.has(request.sessionId)) return { operation: "close", resourceStatus: "closed" };
    if (request.operation === "act" && this.#closed.has(request.sessionId) && request.actions[0])
      throw playtestActionError("Game session is closed", { version: 1, sessionId: request.sessionId,
        completedActions: 0, failedAction: 1, actionType: request.actions[0].type, phase: "session_unavailable", inputDispatched: false });
    if (request.operation !== "open" && !this.#sessions.has(request.sessionId)) {
      throw new Error("Game session does not belong to this conversation");
    }
    const pending = signal ? this.driver.request(request, signal) : this.driver.request(request);
    this.#pending.add(pending);
    try {
      const result = await pending;
      if (result.operation === "open") this.#sessions.add(result.snapshot.sessionId);
      if (request.operation === "close" && result.operation === "close") {
        if (result.resourceStatus === "closed") this.#rememberClosed(request.sessionId);
        else if (result.resourceStatus === undefined) this.#sessions.delete(request.sessionId);
      }
      return result;
    } finally {
      this.#pending.delete(pending);
    }
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(this.#pending);
    await Promise.allSettled([...this.#sessions].map(async (sessionId) => {
      await this.request({ operation: "close", sessionId });
    }));
  }

  #rememberClosed(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#closed.add(sessionId);
    if (this.#closed.size > 64) this.#closed.delete(this.#closed.values().next().value!);
  }

  close(): void { void this.cleanup(); }
}
