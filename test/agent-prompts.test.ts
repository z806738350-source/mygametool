import { describe, expect, it } from "vitest";
import { appendSystemPromptForProject, readProjectWorkflow } from "../src/daemon/agent-prompts.js";

function prompt(project: Parameters<typeof appendSystemPromptForProject>[0]): string {
  return appendSystemPromptForProject(project).join("\n\n");
}

function projectGuide(project: Parameters<typeof readProjectWorkflow>[0]): string {
  return readProjectWorkflow(project, "project.md");
}

describe("OhMyGame system prompt", () => {
  it("keeps ordinary questions independent of workflow guides and retains critical permissions in each project", () => {
    for (const type of ["general", "web-game", "godot-game", "interactive-story", "asset-canvas"] as const) {
      const text = prompt({ type });

      expect(text).toContain("brief commentary update before the first tool call");
      expect(text).toContain("update_plan");
      expect(text).toContain("list_media_capabilities");
      expect(text).toContain("Do not create or change files for casual conversation");
      expect(text).toContain("do not revert changes you did not make");
      expect(text).toContain("reuse the relevant text still visible from this user turn");
      expect(text).toContain("failed match, uncertain mutation or changed source");
      expect(text).toContain("Answer ordinary questions from the conversation");
      expect(text).toContain("Recover uncertain submissions");
      expect(text).toContain("never buy a replacement without explicit authorization");
      expect(text).toContain("user approval of the inspected turnaround");
      expect(text).toContain("final acceptance before replacing approved art");
      expect(text).toContain("read_workflow_guide with guide ohmygame");
      for (const reference of ["canvas.md", "media.md", "images.md", "textures.md", "modeling.md", "isolated-recovery.md", "project.md"])
        expect(text).toContain(reference);
      expect(text).not.toContain("may be empty");
      expect(text).not.toMatch(/GLTFLoader|gl.getParameter|imagePaths|keep the whole|stopped or incomplete guest capacity|data-clip-end|viewport.deviceScaleFactor/);
    }
  });

  it("preserves the production directions in their focused references", () => {
    const guide = (reference: string) => readProjectWorkflow({ type: "asset-canvas" }, reference);
    const modeling = guide("modeling.md");
    const images = guide("images.md");
    const recovery = guide("isolated-recovery.md");
    const canvas = guide("canvas.md");
    const textures = guide("textures.md");
    expect(modeling).toContain("front, left profile and back images of the entire subject; right profile is optional");
    expect(modeling).toContain("generate_reference_image with the original design in imagePaths");
    expect(modeling).toContain("Use read to inspect the pixels of each view");
    expect(modeling).toMatch(/view-generation prompt.*true left profile.*subject's own left and right.*thumb.*heel and toe/);
    expect(modeling).toMatch(/inspect_3d_views.*final ordered imagePaths.*originalPath.*images returned.*In chat.*each angle.*full revised set again/);
    expect(modeling).toMatch(/stale inspection blocks review.*turnaround review card.*revised set for a new review/);
    expect(images).toContain("image content blocks separately from text receipts");
    expect(images).toContain("Do not invent system-generated captions");
    expect(images).toContain("cannot inspect the provider's internal image handling");
    expect(images).toContain("Separate visual descriptions from numeric pixel measurements");
    expect(images).toContain("reading an image does not authorize generation");
    expect(canvas).toContain("relevant boards/documents before canvas, design or asset work");
    expect(canvas).toContain("For game implementation, also read the main document if one is selected");
    expect(canvas).toContain("an index entry alone does not display a node");
    expect(canvas).toContain("before starting the next long-running step");
    expect(guide("media.md")).toContain("save the generation node on the Canvas before submitting");
    expect(modeling).toContain("blender_status");
    expect(modeling).toMatch(/read blender-assets.*open the reference for the current stage/);
    expect(modeling).toMatch(/turnaround reference before the first view.*user's approval.*before submission/);
    expect(modeling).toContain("main Agent reviews intermediate Blender stages");
    expect(modeling).toContain("previous run's unchanged scene.blend");
    expect(modeling).toMatch(/bundled export stage.*reimported GLB.*actual rendered evidence.*recover_blender_run/);
    expect(modeling).toContain("Wait for the user's final acceptance");
    expect(modeling).toContain("Never switch to paid provider rigging as a fallback");
    expect(recovery).toContain("recover_isolated_changes instead of rerunning the command");
    expect(recovery).toContain("action capacity and no other arguments");
    expect(recovery).toContain("stopped or incomplete guest capacity is unknown");
    expect(recovery).toContain("does not start the VM, choose a generation, release a reservation or authorize recovery");
    expect(recovery).toContain("Metadata does not mean the image pixels were read");
    expect(recovery).toContain("Capacity-profile changes remain a future design/simulation only");
    expect(recovery).toContain("not per transfer batch or transport chunk");
    expect(recovery).toContain("Copies at different paths count separately even when hashes match");
    expect(recovery).toContain("never exclude an entire generated directory");
    expect(recovery).toContain("dynamic URLs may load it");
    expect(recovery).toContain("omit maxEdge to preserve dimensions");
    expect(textures).toContain("not a universal art specification");
    expect(textures).toContain("Keeping the original and stopping an unsuitable return path is valid");
    expect(textures).toContain("a smaller encoded file does not reduce pixel count or decoded texture size");
    expect(textures).toContain("full mip estimate includes the base level");
    expect(textures).toContain("not measured GPU memory");
    expect(textures).toContain("decodeLimitPixels is this tool's decoding boundary");
    expect(textures).toContain("Default to the unchanged image and original dimensions");
    expect(textures).toContain("do not automatically increase quality, resolution or texture size");
    expect(textures).toContain("atlas or sprite sheet");
    expect(textures).toContain("layout, frame rectangles and anchors");
    expect(textures).toContain("target device or FPS goal is unknown");
    expect(textures).toContain("Only actual game_use runtime measurements support performance claims");
    expect(textures).toContain("controlled game_use and existing project instrumentation");
    expect(textures).toContain("gl.getParameter(gl.MAX_TEXTURE_SIZE)");
    expect(textures).toContain("check both atlas width and height");
    expect(textures).toContain("capability ceiling, not a performance budget");
    expect(textures).toContain("frame mapping, anchors, transparent edges and padding");
    expect(textures).toContain("measure batching, draw calls and frame time");
    expect(textures).toContain("rather than judging texture bytes alone");
    expect(textures).toContain("report these checks as untested");
    expect(textures).toContain("Do not claim target-device measurements from a different preview environment");
  });

  it("carries the Web Game platform contract in its production guide", () => {
    const text = projectGuide({ type: "web-game" });

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
    const images = readProjectWorkflow({ type: "web-game" }, "images.md");
    expect(images).toContain("outputFormat=png and background=transparent");
    expect(images).toContain("never switch these assets to JPEG");
    expect(images).toContain("background removal as an approximation");
    expect(text).not.toContain("playable_check");
    expect(text).not.toContain("existing folder as the workspace");
  });

  it("uses the configured static directory for a Three.js game without requiring a package script", () => {
    const text = projectGuide({ type: "web-game", previewMode: "static", startupDirectory: "client" });
    expect(text).toContain("Static files preview serves index.html and its relative assets from the client/ folder");
    expect(text).toContain("prepare_three_runtime");
    expect(text).not.toContain('Preview runs the "dev" script');
    expect(projectGuide({ type: "asset-canvas" })).not.toContain("prepare_three_runtime");
  });

  it("uses Game Studio for general games and keeps the Web contract conditional", () => {
    const text = projectGuide({ type: "general", webPreviewEnabled: true, startupDirectory: "client", startupScript: "start", packageManager: "pnpm", workspaceLocation: "external" });

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
    const text = projectGuide({ type: "general", integration: { pluginId: "ohmygame:taptap-maker", preview: "external" } });
    expect(text).toContain("Native plugin preview commands are disabled");
    expect(text).not.toContain("project_preview or View");
    expect(text).toContain("Preserve its engine and project binding");
    expect(text).not.toContain("viewport.deviceScaleFactor");
    expect(text).not.toContain("Web preview switch in Project settings");
    expect(text).not.toContain("Local Web distribution is independent");
  });
  it("keeps disabled General previews under user control without requiring a Node stack", () => {
    const text = projectGuide({ type: "general" });
    expect(text).toContain("Web preview is disabled");
    expect(text).toContain("Do not start a persistent dev server or enable the capability yourself");
    expect(text).toContain("Local Web distribution is independent of the preview switch");
    expect(text).not.toContain("The game is a Node project");
    expect(text).not.toContain("starts it after your turn");
  });

  it("explains how an explicitly referenced design revision should be used", () => {
    const text = readProjectWorkflow({ type: "web-game" }, "canvas.md");

    expect(text).toContain("explicitly referenced document snapshots");
    expect(text).toContain("canvas/AGENTS.md");
    expect(text).toContain("read/edit/write");
    expect(text).toContain("canvas_check");
    expect(text).toContain("Read actual image files");
    expect(text).toContain("Editing a prompt or reference does not request generation");
  });

  it("describes the configured run settings and external workspaces", () => {
    const text = projectGuide({ type: "web-game", startupDirectory: "client", startupScript: "start", packageManager: "pnpm", workspaceLocation: "external" });

    expect(text).toContain("self-contained index.html in the client/ folder");
    expect(text).toContain("external workspace is outside the managed script runtime");
    expect(text).not.toContain('Preview runs the "start" script');
    expect(projectGuide({ type: "web-game", previewMode: "command" })).toContain("Custom preview commands are disabled");
    expect(projectGuide({ type: "web-game", packageManager: "pnpm" })).toContain("only supports npm");
    expect(text).toContain("existing folder as the workspace");
  });

  it("tells the Interactive Story agent how to build, use media in, and check Playable Nodes", () => {
    const text = projectGuide({ type: "interactive-story" });

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
