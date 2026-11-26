import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentManager } from "./agent.js";

export class ProjectWriteError extends Error {
  readonly statusCode = 409;
  constructor(
    message: string,
    readonly code: "workspace_busy" | "workspace_stale",
  ) {
    super(message);
  }
}

/** How long a request waits for a workspace operation before it is refused. */
const ENTER_WAIT_MS = 120_000;

/** These requests operate on project/session metadata outside the game workspace. */
export function isProjectMetadataRequest(method: string, route: string): boolean {
  const project = "/projects/:projectId";
  const conversations = project + "/conversations";
  const chat = conversations + "/:conversationId";
  return method === "PATCH" && (route === project || route === chat) ||
    method === "POST" && (route === conversations || route === chat + "/branch" || route === chat + "/plan/refine" || route === chat + "/queue/:turnId/steer") ||
    method === "PUT" && (route === chat + "/model" || route === chat + "/reasoning") ||
    method === "DELETE" && (route === chat + "/queue/:turnId" || route === chat + "/plan");
}

/** Only a live, matching question can resume an authorized generation. */
export function isConversationControlReply(request: FastifyRequest, agents: AgentManager): boolean {
  if (request.method !== "POST") return false;
  const route = request.routeOptions.url;
  const answer = request.body as { decision?: string; cancelled?: boolean; requestId?: string; answers?: { value: string }[] } | undefined;
  if (route === "/projects/:projectId/conversations/:conversationId/approvals/*") return answer?.decision === "deny";
  if (route !== "/projects/:projectId/conversations/:conversationId/questionnaire" || !answer) return false;
  if (answer.cancelled || answer.answers?.length === 1 && answer.answers[0]?.value === "keep") return true;
  const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
  return agents.activeItems(projectId, conversationId).some(item =>
    item.type === "userInputRequest" && item.status === "inProgress" && item.requestId === answer.requestId && !item.paidMediaTool);
}

export function releasesPreview(method: string, route: string): boolean {
  return method === "DELETE" && (route === "/projects/:projectId/preview" || route === "/projects/:projectId/preview/leases/:leaseId");
}

/** HTTP requests already in flight drain before an exclusive workspace
 * operation. A snapshot only reads the workspace, so reads go on during one
 * and writes wait for it. A restore replaces the files: reads wait for its
 * result, and writes are refused rather than applied over the restored
 * content. */
export class ProjectWrites {
  #requests = new WeakMap<FastifyRequest, () => void>();
  #running = new WeakSet<FastifyRequest>();
  track(request: FastifyRequest, release: () => void): void {
    this.#requests.set(request, release);
  }
  release(request: FastifyRequest): void {
    this.#requests.get(request)?.();
    this.#requests.delete(request);
  }
  install(app: FastifyInstance): void {
    const writes = this;
    app.addHook("preHandler", async (request) => {
      const id = (request.params as { projectId?: string } | undefined)?.projectId;
      if (id) await writes.#states.get(id)?.reloadVersion?.().catch(() => {});
    });
    // A disconnected client does not cancel its handler. Drain the actual
    // operation before restoring, rather than releasing on socket abort.
    app.addHook("onRoute", (route) => {
      const handler = route.handler;
      route.handler = async function (request, reply) {
        writes.#running.add(request);
        try {
          return await handler.call(this, request, reply);
        } finally {
          writes.#running.delete(request);
          writes.release(request);
        }
      };
    });
    app.addHook("onResponse", async (request) => {
      if (!writes.#running.has(request)) writes.release(request);
    });
    app.addHook("onError", async (request) => {
      if (!writes.#running.has(request)) writes.release(request);
    });
  }
  #states = new Map<
    string,
    {
      version: string;
      reloadVersion?: () => Promise<void>;
      active: number;
      lock?: { kind: "snapshot" | "mutation"; done: Promise<void> };
      drained?: () => void;
    }
  >();
  #state(id: string) {
    let state = this.#states.get(id);
    if (!state) {
      state = { version: "0", active: 0 };
      this.#states.set(id, state);
    }
    return state;
  }
  isMutating(id: string): boolean {
    return this.#state(id).lock?.kind === "mutation";
  }
  version(id: string): string {
    return this.#state(id).version;
  }
  async initialize(id: string, readVersion: (requireExisting: boolean) => Promise<string>): Promise<void> {
    const state = this.#state(id);
    state.version = "";
    const reload = async (requireExisting = true) => {
      const version = await readVersion(requireExisting);
      if (state.reloadVersion === reload) {
        state.version = version;
        delete state.reloadVersion;
      }
    };
    state.reloadVersion = reload;
    await reload(false);
  }
  changed(id: string): string {
    const state = this.#state(id);
    delete state.reloadVersion;
    return (state.version = randomUUID());
  }
  assertVersion(id: string, version?: string): void {
    const state = this.#state(id);
    if (!state.version)
      throw new ProjectWriteError("Could not read this project's workspace version. Repair its workspace restore notice, then reload before saving.", "workspace_busy");
    if (
      (version !== undefined && version !== state.version) ||
      (version === undefined && state.version !== "0")
    ) {
      throw new ProjectWriteError(
        "The workspace was restored. Reload it before saving changes.",
        "workspace_stale",
      );
    }
  }
  /**
   * Admits a request to the workspace. `read` requests do not change it; a
   * write carries the workspace version its content was made from. Metadata
   * writes keep write coordination without depending on a file version.
   */
  async enter(id: string, access: boolean | "metadata", version?: string): Promise<() => void> {
    const read = access === true;
    const state = this.#state(id);
    const deadline = Date.now() + ENTER_WAIT_MS;
    while (state.lock && !(read && state.lock.kind === "snapshot")) {
      const remaining = deadline - Date.now();
      if (state.lock.kind === "mutation" && !read || remaining <= 0)
        throw new ProjectWriteError(
          "The workspace is being checkpointed or restored. Try again when it finishes.",
          "workspace_busy",
        );
      let timer!: ReturnType<typeof setTimeout>;
      await Promise.race([
        state.lock.done,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      clearTimeout(timer);
    }
    // A read gets the workspace as it is now, so it has no version to match.
    if (!read && access !== "metadata") this.assertVersion(id, version);
    state.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--state.active === 0) state.drained?.();
    };
  }
  async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#exclusive(id, operation, "mutation");
  }
  /** Snapshots can wait for another snapshot or restore without failing a new
   * turn. Editor writes still drain and are refused while a snapshot reads. */
  async snapshot<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const state = this.#state(id);
    while (state.lock) await state.lock.done;
    return this.#exclusive(id, operation, "snapshot");
  }
  async #exclusive<T>(
    id: string,
    operation: () => Promise<T>,
    kind: "snapshot" | "mutation",
  ): Promise<T> {
    const state = this.#state(id);
    if (state.lock)
      throw new ProjectWriteError(
        "Another workspace operation is running.",
        "workspace_busy",
      );
    let unlock!: () => void;
    const done = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    state.lock = { kind, done };
    try {
      if (state.active)
        await new Promise<void>((resolve) => {
          state.drained = resolve;
        });
      return await operation();
    } finally {
      state.drained = undefined;
      state.lock = undefined;
      unlock();
    }
  }
}
