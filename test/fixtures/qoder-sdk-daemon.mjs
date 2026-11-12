// Local protocol emulator for the real SDK. No login, credentials, model transport or network code.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv.length !== 3 || process.argv[2] !== "--sdk")
  throw new Error("Only SDK process mode is supported");
const config = process.env.QODER_CONFIG_DIR;
const record = (message) =>
  appendFileSync(
    path.join(config, "fixture-frames.jsonl"),
    JSON.stringify(message) + "\n",
  );
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const session = "11111111-1111-4111-8111-111111111111";
const capabilities = [
  "interrupt_receipt_v1",
  "interrupt_cancel_queued_v1",
  "msg_lifecycle_v1",
  "session_rewind_v1",
  "background_tasks_v1",
  "side_question_v1",
  "custom_context_v1",
  "goal_v1",
  "goal_max_turns_v1",
  "goal_resume_v1",
  "skill_evolution_v1",
  "plan_mode_v1",
  "session_store_fork_barrier_v1",
  "host_action",
  "byok_config_management_v1",
  "commands_changed_v1",
  "reload_skills_v1",
  "selected_skills_v1",
];
const agents = ["general-purpose", "Explore", "Plan"];
// Native 1.1.83 CK: --tools restricts built-ins, not subsequently injected MCP tools.
const builtInTools = [
  "CodeMode",
  "CodeModeWait",
  "Glob",
  "TodoWrite",
  "Write",
  "WebSearch",
  "ImageSearch",
  "WebFetch",
  "Edit",
  "Bash",
  "PowerShell",
  "Monitor",
  "TaskStop",
  "BashInput",
  "BashOutput",
  "BashResize",
  "Grep",
  "Read",
  "Skill",
  "AskUserQuestion",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "GetGoal",
  "CreateGoal",
  "UpdateGoal",
  "EnterPlanMode",
  "NotebookEdit",
  "ExitPlanMode",
  "UpdateTopic",
  "CompleteTask",
  "ImageGen",
  "VideoGen",
  "VideoGenRetrieve",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Agent",
  "EnterWorktree",
  "ExitWorktree",
  "Workflow",
  "SendMessage",
  "ListAgents",
];
const mcpMetaTools = ["mcp_list", "mcp_get", "mcp_call"];
const pending = new Map();
let sequence = 0,
  promptCount = 0,
  cwd,
  workerArgs,
  initialize,
  hookId,
  tools = [],
  user,
  model,
  runtimeSettings,
  initSnapshot;
const reply = (frame, response, sessionId = frame.session_id) =>
  send({
    type: "control_response",
    ...(sessionId ? { session_id: sessionId } : {}),
    response: {
      subtype: "success",
      request_id: frame.request_id,
      ...(response === undefined ? {} : { response }),
    },
  });
function request(value) {
  const requestId = `fixture-${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({
      type: "control_request",
      request_id: requestId,
      session_id: session,
      request: value,
    });
  });
}
const mcp = (message) =>
  request({ subtype: "mcp_message", server_name: "ohmygame", message });

function selectedTools() {
  const core = workerArgs[workerArgs.indexOf("--tools") + 1].split(",");
  const denied = new Set(
    core.some((name) => name.toLowerCase() === "default")
      ? []
      : builtInTools.filter((name) => !core.includes(name)),
  );
  // The host uses bare names. Native Ga/mn/cr accept these unchanged into deny.cliArg.
  const explicitDeny = workerArgs.flatMap((value, index) =>
    value === "--disallowed-tools" ? [workerArgs[index + 1]] : [],
  );
  for (const name of explicitDeny) {
    if (
      workerArgs.includes("fixture-ignored-meta-deny") &&
      mcpMetaTools.includes(name)
    )
      continue;
    denied.add(name);
  }
  // Native getInjectedMcpTools includes meta tools in both full and lazy modes.
  const registered = [
    ...builtInTools,
    ...tools.map((tool) => `mcp__ohmygame__${tool.name}`),
    ...mcpMetaTools,
  ];
  const active = registered.filter((name) => !denied.has(name));
  record({ inventory: { registered, explicitDeny, active } });
  return active;
}

function emitSnapshot(stage, changes = {}) {
  const snapshot = { ...initSnapshot, ...changes, uuid: randomUUID() };
  record({
    snapshot: { stage, sessionId: snapshot.session_id, tools: snapshot.tools },
  });
  send(snapshot);
}

function narration() {
  const messageId = "fixture-assistant";
  const text = "Local SDK protocol completed.";
  const stream = (event) =>
    send({
      type: "stream_event",
      uuid: randomUUID(),
      session_id: session,
      parent_tool_use_id: null,
      event,
    });
  stream({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Local fixture reasoning" },
  });
  stream({ type: "content_block_stop", index: 0 });
  stream({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  });
  stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: text.slice(0, 10) },
  });
  stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: text.slice(10) },
  });
  // Native emits a one-block completed snapshot before its original stream index stops.
  send({
    type: "assistant",
    uuid: randomUUID(),
    session_id: session,
    parent_tool_use_id: null,
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  stream({ type: "content_block_stop", index: 1 });
  stream({ type: "message_stop" });
}

async function initialized(frame) {
  initialize = frame.request;
  if (workerArgs.includes("fixture-malformed-control")) {
    send({
      type: "control_response",
      session_id: session,
      response: {
        subtype: "success",
        request_id: frame.request_id,
        PRIVATE_SDK_PROTOCOL_CANARY: true,
      },
    });
    return;
  }
  hookId = initialize.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
  await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "local-sdk-fixture", version: "1" },
    },
  });
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await mcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  tools = listed.mcp_response.result.tools;
  // Native 1.1.83 shapes, including its built-in agent metadata and current wire capabilities.
  const active = selectedTools();
  const mode = workerArgs.includes("fixture-unsafe-inventory")
    ? [...active, "Bash"]
    : active;
  const registeredSkills =
    runtimeSettings.skills?.enabled === false &&
    !workerArgs.includes("fixture-ignored-skills")
      ? []
      : ["imagegen"];
  initSnapshot = {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.83",
    protocol_version: "1.5.0",
    cwd,
    tools: mode,
    mcp_servers: [{ name: "ohmygame", status: "connected" }],
    model,
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    agents,
    skills: registeredSkills,
    plugins: [],
    capabilities: [...capabilities, "title_source_message_v1"],
    fast_mode_state: "off",
    uuid: randomUUID(),
    session_id: session,
  };
  emitSnapshot("initialize");
  reply(frame, {
    commands: [],
    permissionPolicy: {},
    agents: agents.map((name) => ({
      name,
      description: `${name} built-in metadata`,
    })),
    skills: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: {},
    capabilities: [
      ...capabilities,
      "title_source_message_v1",
      "daemon_async_session_teardown_v1",
    ],
    permissionMode: "default",
    pid: process.pid,
  });
}

async function prompt(frame) {
  if (model.startsWith("fixture-steering") && frame.priority === "next") {
    user = frame;
    send({ type: "command_lifecycle", state: "queued", command_uuid: frame.uuid, session_id: session });
    return;
  }
  promptCount++;
  user = frame;
  // ThreadSession.runTurn emits another sessionSnapshot before submitting the user message.
  const changedTools = workerArgs.includes("fixture-changed-snapshot-tools");
  const changedSession = workerArgs.includes(
    "fixture-changed-snapshot-session",
  );
  emitSnapshot("turn-start", {
    ...(changedTools ? { tools: [...initSnapshot.tools, "Bash"] } : {}),
    ...(changedSession
      ? { session_id: "22222222-2222-4222-8222-222222222222" }
      : {}),
  });
  if (changedTools || changedSession) return;
  const visual = model.startsWith("fixture-vision-");
  const policy = async (afterTool = false) => {
    const missing = model.endsWith("missing");
    const denied = model.endsWith("false") || afterTool && model.endsWith("drift");
    const metadata = { value: model, displayName: "Local vision fixture", description: "PRIVATE_VISION_POLICY_CANARY", ...missing ? {} : { isVl: !denied } };
    try {
      const result = await request({
        subtype: "get_model_policy", purpose: "main", sessionId: session,
        turnIndex: afterTool ? 1 : 0, resolvedModel: model, models: visual ? [metadata] : [],
      });
      record({ modelPolicy: result, afterTool });
      record({ modelRequest: { afterTool } });
      return true;
    } catch {
      record({ modelPolicyDenied: { afterTool } });
      return false;
    }
  };
  if (initialize.modelPolicyProvider) {
    if (!await policy()) return;
  }
  narration();
  const arguments_ = { path: "fixture.txt", content: "SDK transport result" };
  const denied = await request({
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "must never run" },
    tool_use_id: "blocked-native-tool",
  });
  record({ permission: "native", response: denied });
  if (model === "fixture-edit-preflight-recover") {
    for (const operation of [
      { callId: "rejected-edit", arguments: { path: "fixture.txt", oldText: "absent", newText: "after" } },
      { callId: promptCount === 1 ? "corrected-edit" : "continuation-edit", arguments: { path: "fixture.txt", oldText: "before", newText: "after" } },
    ]) {
      const name = "mcp__ohmygame__edit";
      await request({ subtype: "hook_callback", callback_id: hookId, tool_use_id: operation.callId,
        input: { hook_event_name: "PreToolUse", tool_name: name, tool_input: operation.arguments, tool_use_id: operation.callId, session_id: session, cwd } });
      const response = await request({ subtype: "can_use_tool", tool_name: name, input: operation.arguments, tool_use_id: operation.callId });
      record({ permission: "controlled", callId: operation.callId, response });
      const called = await mcp({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: "edit", arguments: operation.arguments } });
      record({ toolResult: called, callId: operation.callId });
    }
  } else {
    const hook = await request({
      subtype: "hook_callback",
      callback_id: hookId,
      tool_use_id: "runtime-call-1",
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__ohmygame__write",
        tool_input: arguments_,
        tool_use_id: "runtime-call-1",
        session_id: session,
        cwd,
      },
    });
    record({ permission: "hook", response: hook });
    if (workerArgs.includes("fixture-snapshot-after-hook"))
      emitSnapshot("after-hook");
    const allowed = await request({
      subtype: "can_use_tool",
      tool_name: "mcp__ohmygame__write",
      input: arguments_,
      tool_use_id: "runtime-call-1",
    });
    record({ permission: "controlled", response: allowed });
    const called = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "write", arguments: arguments_ },
    });
    record({ toolResult: called });
    if (model.startsWith("fixture-steering")) {
      if (user.priority !== "next") throw new Error("Expected queued steering before the tool receipt");
      send({ type: "command_lifecycle", state: "started", command_uuid: user.uuid, session_id: session });
      if (!await policy(true)) {
        send({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session });
        return;
      }
    }
    if (visual && !await policy(true)) return;
    if (workerArgs.includes("fixture-snapshot-after-hook")) {
      await request({
        subtype: "hook_callback",
        callback_id: hookId,
        tool_use_id: "runtime-call-1",
        input: {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__ohmygame__write",
          tool_input: arguments_,
          tool_use_id: "runtime-call-1",
          session_id: session,
          cwd,
        },
      });
      emitSnapshot("after-tool-result");
      const replayed = await mcp({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "write", arguments: arguments_ },
      });
      record({ replayedToolResult: replayed });
    }
  }
  send({
    type: "command_lifecycle",
    state: "completed",
    command_uuid: user.uuid,
    session_id: session,
  });
  send({
    type: "result",
    subtype: "success",
    uuid: randomUUID(),
    session_id: session,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: 1,
    result: "Local SDK protocol completed.",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    ...((workerArgs.includes("fixture-result-turn-limit") || (workerArgs.includes("fixture-result-turn-limit-recover") || model === "fixture-edit-preflight-recover") && promptCount === 1) ? { subtype: "error_max_turns", is_error: true, num_turns: 64, terminal_reason: "max_turns", stop_reason: "tool_use", errors: ["PRIVATE_TERMINAL_CANARY"], error_message: "PRIVATE_TERMINAL_CANARY" } : {}),
  });
}

async function handle(frame) {
  record({ received: frame });
  if (frame.type === "control_response") {
    const request = pending.get(frame.response.request_id);
    if (!request) throw new Error("Unexpected fake protocol response");
    pending.delete(frame.response.request_id);
    if (frame.response.subtype !== "success") request.reject(new Error("SDK control handler rejected the local fixture"));
    else request.resolve(frame.response.response);
    return;
  }
  if (frame.type === "control_cancel_request") return;
  if (frame.type === "user") {
    await prompt(frame);
    return;
  }
  if (frame.type !== "control_request") throw new Error("Unexpected SDK frame");
  const kind = frame.request.type ?? frame.request.subtype;
  if (kind === "daemon.initialize") {
    if (
      JSON.stringify(frame.request.auth) !==
      JSON.stringify({ type: "qodercli" })
    )
      throw new Error(
        "No credentials or authentication metadata are accepted by this fixture",
      );
    reply(frame, {
      daemon_protocol_version: 2,
      daemon_version: "1.1.83",
      // Query-plane availability is not authentication; only explicit local fixture data enables reads below.
      capabilities: [
        "multi_session_v2",
        "session_delete_v1",
        "daemon_queries_v1",
      ],
    });
  } else if (kind === "daemon.account_info" || kind === "daemon.get_models") {
    // This file is synthetic public response data, never a CLI authentication file.
    const fixture = JSON.parse(
      readFileSync(path.join(config, "fixture-account-catalog.json"), "utf8"),
    );
    if (
      JSON.stringify(fixture.account) !==
      JSON.stringify({ userId: "local-fixture-user" })
    )
      throw new Error("Only the synthetic local account is accepted");
    reply(
      frame,
      kind === "daemon.account_info"
        ? { account: fixture.account }
        : { models: fixture.models },
    );
  } else if (kind === "daemon.open_session") {
    cwd = frame.request.cwd;
    workerArgs = frame.request.worker_args;
    model = workerArgs[workerArgs.indexOf("--model") + 1];
    runtimeSettings = JSON.parse(
      workerArgs[workerArgs.indexOf("--settings") + 1],
    );
    reply(frame, undefined, session);
  } else if (kind === "initialize") await initialized(frame);
  else if (kind === "set_plan_mode")
    reply(frame, { active: false, permissionMode: "default" });
  else if (kind === "mcp_status")
    reply(frame, {
      servers: [
        {
          name: "ohmygame",
          status: "connected",
          tools: tools.map((tool) => ({
            ...tool,
            name: `mcp__ohmygame__${tool.name}`,
          })),
        },
      ],
    });
  else if (kind === "daemon.close_session") reply(frame, undefined, session);
  else if (kind === "daemon.shutdown") reply(frame, undefined, undefined);
  else
    throw new Error(
      `No account or unexpected control request is allowed: ${kind}`,
    );
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    record({ failure: error.message });
    process.stderr.write("The isolated protocol fixture failed\n");
    process.exitCode = 1;
    process.stdin.destroy();
  });
});
process.stdin.on("end", () => {
  process.exitCode ??= 0;
});
