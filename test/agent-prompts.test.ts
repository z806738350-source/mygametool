import { describe, expect, it } from "vitest";
import { appendSystemPromptForProject } from "../src/daemon/agent-prompts.js";

function prompt(project: Parameters<typeof appendSystemPromptForProject>[0]): string {
  return appendSystemPromptForProject(project).join("\n\n");
}

describe("OhMyGame system prompt", () => {
  it("preserves shared interaction guidance for every project type", () => {
    for (const type of ["general", "web-game", "godot-game", "interactive-story", "asset-canvas"] as const) {
      const text = prompt({ type });

      expect(text).toContain("brief commentary update before the first tool call");
      expect(text).toContain("update_plan");
      expect(text).toContain("list_media_capabilities");
      expect(text).toContain("front, left profile and back images of the entire subject; right profile is optional");
      expect(text).toContain("generate_reference_image with the original design in imagePaths");
      expect(text).toContain("Use read to inspect the pixels of each view");
      expect(text).toContain("image content blocks separately from text receipts");
      expect(text).toContain("Do not invent system-generated captions");
      expect(text).toContain("cannot inspect the provider's internal image handling");
      expect(text).toContain("Separate visual descriptions from numeric pixel measurements");
      expect(text).toContain("reading an image does not authorize generation");
      expect(text).toContain("Do not create or change files for casual conversation");
      expect(text).toContain("do not revert changes you did not make");
      expect(text).toContain("relevant boards/documents before canvas, design or asset work");
      expect(text).toContain("For game implementation, also read the main document if one is selected");
      expect(text).toContain("an index entry alone does not display a node");
      expect(text).toContain("before starting the next long-running step");
      expect(text).toContain("save the generation node on the Canvas before submitting");
      expect(text).toContain("read_workflow_guide");
      expect(text).toContain("blender_status");
      expect(text).toContain("recover_blender_run");
      expect(text).toContain("Do not switch to paid provider rigging as a fallback");
      expect(text).toContain("Never mark artistic acceptance from a numeric report");
      expect(text).toContain("recover_isolated_changes instead of rerunning the command");
      expect(text).toContain("action capacity and no other arguments");
      expect(text).toContain("stopped or incomplete guest capacity is unknown");
      expect(text).toContain("does not start the VM, choose a generation, release a reservation or authorize recovery");
      expect(text).toContain("Metadata does not mean the image pixels were read");
      expect(text).toContain("Capacity-profile changes remain a future design/simulation only");
      expect(text).toContain("not per transfer batch or transport chunk");
      expect(text).toContain("Copies at different paths count separately even when hashes match");
      expect(text).toContain("never exclude an entire generated directory");
      expect(text).toContain("dynamic URLs may load it");
      expect(text).toContain("omit maxEdge to preserve dimensions");
      expect(text).toContain("not a universal art specification");
      expect(text).toContain("Keeping the original and stopping an unsuitable return path is valid");
      expect(text).toContain("a smaller encoded file does not reduce pixel count or decoded texture size");
      expect(text).toContain("full mip estimate includes the base level");
      expect(text).toContain("not measured GPU memory");
      expect(text).toContain("decodeLimitPixels is this tool's decoding boundary");
      expect(text).toContain("Default to the unchanged image and original dimensions");
      expect(text).toContain("do not automatically increase quality, resolution or texture size");
      expect(text).toContain("atlas or sprite sheet");
      expect(text).toContain("layout, frame rectangles and anchors");
      expect(text).toContain("target device or FPS goal is unknown");
      expect(text).toContain("Only actual game_use runtime measurements support performance claims");
      expect(text).toContain("controlled game_use and existing project instrumentation");
      expect(text).toContain("gl.getParameter(gl.MAX_TEXTURE_SIZE)");
      expect(text).toContain("check both atlas width and height");
      expect(text).toContain("capability ceiling, not a performance budget");
      expect(text).toContain("frame mapping, anchors, transparent edges and padding");
      expect(text).toContain("measure batching, draw calls and frame time");
      expect(text).toContain("rather than judging texture bytes alone");
      expect(text).toContain("report these checks as untested");
      expect(text).toContain("Do not claim target-device measurements from a different preview environment");
      expect(text).not.toContain("may be empty");
    }
  });

  it("carries the Web Game platform contract in the system prompt", () => {
    const text = prompt({ type: "web-game" });

    expect(text).toContain("create and evolve browser games");
    expect(text).toContain("smallest reliable change");
    expect(text).toContain("OhMyGame owns the dev server");
    expect(text).toContain("v3 package-lock.json even for a dependency-free game");
    expect(text).toContain("prepare_three_runtime");
    expect(text).toContain("reuse its working project runtime");
    expect(text).toContain("including its license, in static and built output");
    expect(text).toContain("hidden hosting metadata such as .nojekyll");
    expect(text).toContain("inside an iframe of any size");
    expect(text).toContain("viewport.deviceScaleFactor 1, then resize to 2 and back to 1 in the same session");
    expect(text).toContain("__OHMYGAME_PLAYTEST__");
    expect(text).toContain("the workspace root");
    expect(text).toContain('a "dev" script and a "build" script');
    expect(text).toContain("--host 127.0.0.1 --port <port> --strictPort");
    expect(text).toContain("process.env.PORT");
    expect(text).toContain("process.env.HOST");
    expect(text).toContain("Custom Node scripts receive no automatic flags");
    expect(text).toContain("dist/, build/, or out/");
    expect(text).toContain("missing from a standalone build");
    expect(text).toContain("outputFormat=png and background=transparent");
    expect(text).toContain("never switch these assets to JPEG");
    expect(text).toContain("background removal as an approximation");
    expect(text).not.toContain("playable_check");
    expect(text).not.toContain("existing folder as the workspace");
  });

  it("uses the configured static directory for a Three.js game without requiring a package script", () => {
    const text = prompt({ type: "web-game", previewMode: "static", startupDirectory: "client" });
    expect(text).toContain("Static files preview serves index.html and its relative assets from the client/ folder");
    expect(text).toContain("prepare_three_runtime");
    expect(text).not.toContain('Preview runs the "dev" script');
    expect(prompt({ type: "asset-canvas" })).not.toContain("prepare_three_runtime");
  });

  it("uses Game Studio for general games and keeps the Web contract conditional", () => {
    const text = prompt({ type: "general", webPreviewEnabled: true, startupDirectory: "client", startupScript: "start", packageManager: "pnpm", workspaceLocation: "external" });

    expect(text).toContain("use game-studio when available");
    expect(text).toContain("Applications, tools, and content");
    expect(text).toContain("Web preview is enabled by the user");
    expect(text).toContain("viewport.deviceScaleFactor");
    expect(text).toContain("self-contained index.html in the client/ folder");
    expect(text).toContain("external workspace is outside the managed script runtime");
    expect(text).not.toContain("use web-game-studio");
    expect(text).not.toContain("playable_add_node");
  });

  it("explains the native preview boundary for a saved plugin binding", () => {
    const text = appendSystemPromptForProject({ type: "general", integration: { pluginId: "ohmygame:taptap-maker", preview: "external" } }).join("\n");
    expect(text).toContain("Native plugin preview commands are disabled");
    expect(text).not.toContain("project_preview or View");
    expect(text).toContain("Preserve its engine and project binding");
    expect(text).not.toContain("viewport.deviceScaleFactor");
    expect(text).not.toContain("Web preview switch in Project settings");
    expect(text).not.toContain("Local Web distribution is independent");
  });
  it("keeps disabled General previews under user control without requiring a Node stack", () => {
    const text = prompt({ type: "general" });
    expect(text).toContain("Web preview is disabled");
    expect(text).toContain("Do not start a persistent dev server or enable the capability yourself");
    expect(text).toContain("Local Web distribution is independent of the preview switch");
    expect(text).not.toContain("The game is a Node project");
    expect(text).not.toContain("starts it after your turn");
  });

  it("explains how an explicitly referenced design revision should be used", () => {
    const text = prompt({ type: "web-game" });

    expect(text).toContain("explicitly referenced document snapshots");
    expect(text).toContain("canvas/AGENTS.md");
    expect(text).toContain("read/edit/write");
    expect(text).toContain("canvas_check");
    expect(text).toContain("Read actual image files");
    expect(text).toContain("Editing a prompt or reference does not request generation");
  });

  it("describes the configured run settings and external workspaces", () => {
    const text = prompt({ type: "web-game", startupDirectory: "client", startupScript: "start", packageManager: "pnpm", workspaceLocation: "external" });

    expect(text).toContain("self-contained index.html in the client/ folder");
    expect(text).toContain("external workspace is outside the managed script runtime");
    expect(text).not.toContain('Preview runs the "start" script');
    expect(prompt({ type: "web-game", previewMode: "command" })).toContain("Custom preview commands are disabled");
    expect(prompt({ type: "web-game", packageManager: "pnpm" })).toContain("only supports npm");
    expect(text).toContain("existing folder as the workspace");
  });

  it("tells the Interactive Story agent how to build, use media in, and check Playable Nodes", () => {
    const text = prompt({ type: "interactive-story" });

    expect(text).toContain("playable_add_node");
    expect(text).toContain("playable_check");
    expect(text).toContain('mode "publish"');
    expect(text).toContain('"kind": "workspace"');
    expect(text).toContain("viewport from graph.json");
    expect(text).toContain("<editor-context>");
    expect(text).toContain("drawing");
    expect(text).not.toContain("create and evolve browser games");
    expect(text).not.toContain("OhMyGame owns the dev server");
  });
});
