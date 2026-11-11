import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runToolCall, type AgentToolCall } from "@earendil-works/pi-agent-core";
import { expect, it, vi } from "vitest";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { model3DJournal } from "../src/daemon/model3d-journal.js";
import { ToolRunner } from "../src/daemon/tools.js";

it("keeps direct generation inputs separate from recovery through Pi and direct dispatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-media-entry-"));
  try {
    const projects = new ProjectManager(directory), project = await projects.create("Local test", "web-game");
    const runner = new ToolRunner(directory, { generate: vi.fn() });
    const run = vi.spyOn(runner, "run").mockRejectedValue(new Error("fixture reached local runner"));
    const tools = createAgentTools(project, runner, projects);
    const image = tools.find(tool => tool.name === "generate_image")!;
    const recover = tools.find(tool => tool.name === "recover_media")!;
    const ctx = {} as never;
    async function submit(tool: typeof image, args: AgentToolCall["arguments"]) {
      const result = await runToolCall({ type: "toolCall", name: tool.name, id: "current", arguments: args }, {
        tools: [{ ...tool, execute: (id, input) => tool.execute(id, input, undefined, undefined, ctx) }],
        assistantMessage: {} as never, context: { messages: [] },
      });
      return result.result.content.filter(block => block.type === "text").map(block => block.text).join(" ");
    }

    for (const tool of tools.filter(tool => ["generate_image", "generate_video", "generate_3d_asset", "animate_3d_asset", "generate_speech", "generate_sound_effect", "generate_music"].includes(tool.name))) {
      expect(tool.parameters).not.toHaveProperty("properties.recoverCallId");
    }
    expect(image.parameters).not.toHaveProperty("properties.size");
    expect(image.parameters).toHaveProperty("required", ["prompt"]);
    expect(await submit(image, { prompt: "Autumn forest", recoverCallId: "real-original" })).toContain("recover_media");
    await expect(image.execute("direct", {}, undefined, undefined, ctx)).rejects.toThrow("Missing required field prompt");
    const invalid: AgentToolCall["arguments"][] = [
      { tool: "generate_image", recoverCallId: "new" },
      { tool: "generate_image", recoverCallId: "old", originalArguments: [] },
      { tool: "generate_image", recoverCallId: "old", originalArguments: { recoverCallId: "nested" } },
      { tool: "generate_image", recoverCallId: "old", originalArguments: { prompt: "Autumn", typo: true } },
    ];
    for (const input of invalid) {
      expect(await submit(recover, input)).toContain("No generation was submitted");
    }
    expect(run).not.toHaveBeenCalled();

    const originalArguments = { prompt: "Forest", size: "1024x1024" };
    expect(await submit(recover, { tool: "generate_image", recoverCallId: "old", originalArguments })).toContain("fixture reached local runner");
    expect(run).toHaveBeenCalledExactlyOnceWith("generate-image", originalArguments, undefined, project.id,
      expect.objectContaining({ imageRecoveryOnly: true, agentCall: expect.objectContaining({ callId: "old" }) }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["unsent", "old-id-journal", "placeholder-journal", "different-error", "real-receipt"])(
  "reconciles a legacy 3D path conflict conservatively with %s evidence", async (scenario) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-3d-entry-"));
    try {
      const projects = new ProjectManager(directory), project = await projects.create("Legacy 3D check", "web-game");
      const runner = new ToolRunner(directory, { generate: vi.fn() });
      const tool = createAgentTools(project, runner, projects).find(tool => tool.name === "generate_3d_asset")!;
      const parts = [project.id, project.id, "image-to-3d"];
      const id = (fields: string[]) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");
      const callId = "legacy-3d", originalId = id([...parts, callId]), scope = id(parts);
      await runner.agentMedia.adopt({ scope, callId }, originalId, scenario !== "real-receipt");
      if (scenario === "old-id-journal" || scenario === "placeholder-journal") {
        const journalId = scenario === "old-id-journal" ? originalId : id([...parts, "null"]);
        const journal = await model3DJournal(path.join(directory, "tools", "model3d-tasks"), journalId);
        await journal.submitted("generate", "fixture", {}, async () => ({ taskId: "fixture-task" }));
      }
      const ctx = { sessionManager: { getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: tool.name, id: callId,
          arguments: { operation: "image", imagePath: "front.png", imagePaths: [], sourcePath: "", recoverCallId: "null" } }] } },
        { type: "message", message: { role: "toolResult", toolName: tool.name, toolCallId: callId, isError: true, durationMs: 0,
          content: [{ type: "text", text: scenario === "different-error" ? "Connection interrupted" : "Use imagePath or imagePaths, not both" }] } },
      ] } } as never;
      // Stop once session history has been reconciled, without sending a new model request.
      vi.spyOn(runner, "run").mockRejectedValue(new Error("Reached fixture runner"));
      await expect(tool.execute("fresh", { operation: "text", prompt: "Cube" }, undefined, undefined, ctx)).rejects.toThrow("Reached fixture runner");
      const receipts = await readdir(path.join(directory, "tools", "agent-media", scope));
      expect(receipts.includes(originalId + ".json")).toBe(scenario !== "unsent");
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
);
