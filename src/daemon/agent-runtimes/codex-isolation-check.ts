import { randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRuntimeCompatibilityError } from "./compatibility.js";
import { CodexAppServer, checkCodexCompatibility } from "./codex-app-server.js";
import { CODEX_AUDIT_PROVIDER, CODEX_TOOL_NAMESPACE, controlledCodexEnvironment } from "./controlled-codex.js";

const TOOL = "ohmygame_compatibility_probe";
const MODEL = "gpt-5.4";
const TIMEOUT_MS = 12_000;
const PATCH_FILE = "native-write-probe.txt";
const PROGRAM = `
const name = "${CODEX_TOOL_NAMESPACE}__${TOOL}";
if (typeof process !== "undefined" || typeof require !== "undefined" ||
    typeof fetch !== "undefined" || ALL_TOOLS.length !== 1 || ALL_TOOLS[0].name !== name)
  throw new Error("Unexpected capabilities in the isolated runner");
text(await tools[name]({}));
`;

function reply(res: ServerResponse, step: number, tool?: Record<string, unknown>) {
  const id = `resp-audit-${step}`;
  const item = tool ? { id, status: "completed", call_id: `call-${id}`, ...tool } : {
    id, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Local isolation check complete", annotations: [] }],
  };
  const event = (type: string, value: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  event("response.created", { response: { id, status: "in_progress" } });
  event("response.output_item.added", { item, output_index: 0 });
  event("response.output_item.done", { item, output_index: 0 });
  event("response.completed", { response: { id, status: "completed", output: [item] } });
  res.end();
}

/** Exercise the installed CLI and V8 runner with a private provider on loopback. */
export async function checkCodexIsolation(binary: string, directory: string): Promise<void> {
  const env = await controlledCodexEnvironment(directory);
  const cwd = path.join(directory, "session");
  await mkdir(cwd, { mode: 0o700 });
  const secret = randomUUID();
  const receipt = randomUUID();
  let step = 0;
  let hasPatch = false;
  let worked = false;
  let calls = 0;
  let failure: string | undefined;
  const fixture = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/responses" ||
          req.headers.authorization !== `Bearer ${secret}`)
        throw new Error("Unexpected request to the local fixture");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("The local fixture request exceeded its size limit");
      }
      const request = JSON.parse(body);
      if (++step === 1) {
        const supported = new Map([
          ["exec", "custom"], ["wait", "function"],
          ["request_user_input", "function"], ["apply_patch", "custom"],
          [CODEX_TOOL_NAMESPACE, "namespace"],
        ]);
        if (!Array.isArray(request.tools) || request.tools.some((tool: { name: string; type: string }) => supported.get(tool.name) !== tool.type) ||
            !request.tools.some((tool: { name: string }) => tool.name === "exec"))
          throw new Error("Codex exposed an unexpected native tool or omitted its isolated runner");
        const namespace = request.tools.find((tool: { name: string }) => tool.name === CODEX_TOOL_NAMESPACE);
        if (namespace?.tools?.length !== 1 || namespace.tools[0].name !== TOOL)
          throw new Error("Codex did not retain the controlled tool namespace");
        hasPatch = request.tools.some((tool: { name: string }) => tool.name === "apply_patch");
        return reply(res, step, { type: "custom_tool_call", name: "exec", input: PROGRAM });
      }
      if (step === 2 && calls === 1 && JSON.stringify(request.input).includes(receipt)) {
        if (hasPatch)
          return reply(res, step, { type: "custom_tool_call", name: "apply_patch",
            input: `*** Begin Patch\n*** Add File: ${PATCH_FILE}\n+isolation fixture\n*** End Patch\n` });
      } else if (step !== 3 || !hasPatch) {
        throw new Error("The isolated runner did not dispatch the controlled tool");
      }
      worked = true;
      return reply(res, step);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
      res.writeHead(400).end();
    }
  });
  let server: CodexAppServer | undefined;
  const timeout = new AbortController();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", () => {
        const address = fixture.address();
        if (!address || typeof address === "string") reject(new Error("Could not open the local fixture"));
        else resolve(address.port);
      });
    });
    await writeFile(path.join(env.CODEX_HOME!, "config.toml"), [
      `[model_providers.${CODEX_AUDIT_PROVIDER}]`, 'name = "OhMyGame local check"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'env_key = "OHMYGAME_CODEX_FIXTURE_KEY"',
      'wire_api = "responses"', "supports_websockets = false", "max_retries = 0",
      "request_max_retries = 0", "stream_max_retries = 0", "",
    ].join("\n"), { mode: 0o600 });
    env.OHMYGAME_CODEX_FIXTURE_KEY = secret;
    env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = "http://127.0.0.1:1";
    env.NO_PROXY = "127.0.0.1";
    let complete!: (value: boolean) => void;
    const finished = new Promise<boolean>(resolve => { complete = resolve; });
    server = new CodexAppServer(binary, cwd, env, {
      localIsolationAudit: true,
      exit: () => complete(false),
      notification: (method, params) => {
        if (method === "turn/completed") complete((params.turn as { status?: string } | undefined)?.status === "completed");
      },
      request: async (method, params) => {
        if (method !== "item/tool/call" || params.namespace !== CODEX_TOOL_NAMESPACE ||
            params.tool !== TOOL || ++calls !== 1) throw new Error("Unexpected request from the test CLI");
        return { success: true, contentItems: [{ type: "inputText", text: receipt }] };
      },
    });
    await server.initialize(TIMEOUT_MS);
    const threadId = await checkCodexCompatibility(server, cwd, TIMEOUT_MS, true);
    await server.request("turn/start", {
      threadId, model: MODEL,
      input: [{ type: "text", text: "OhMyGame local isolation check", text_elements: [] }],
    }, TIMEOUT_MS);
    const completed = await Promise.race([finished, delay(TIMEOUT_MS, false, { signal: timeout.signal })]);
    const wrote = await lstat(path.join(cwd, PATCH_FILE)).then(() => true, cause => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    });
    if (!completed || !worked || wrote || failure)
      throw new Error(failure ?? (wrote ? "Native file writes were enabled" : "The isolated tool check did not complete"));
  } catch (cause) {
    throw new AgentRuntimeCompatibilityError(
      `The installed Codex did not pass the local tool-isolation check. ${cause instanceof Error ? cause.message : String(cause)}`,
      "controlled Codex tool isolation",
    );
  } finally {
    timeout.abort();
    await server?.stop();
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}
