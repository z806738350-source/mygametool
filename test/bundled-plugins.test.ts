import { mkdir, writeFile } from "node:fs/promises";
import { temporaryTestDirectory } from "./temporary-test-directory.js";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { workflowGuideTools } from "../src/daemon/workflow-guide.js";

describe("bundled plugins", () => {
  it("serves only the requested operating reference when no studio plugins are installed", async () => {
    const directory = await temporaryTestDirectory("ohmygame-built-in-guides-");
    const store = new BundledPluginStore(directory);
    await store.load();
    const settings = new PluginSettingsStore(directory);
    await settings.load();
    const tool = workflowGuideTools({ type: "web-game", startupDirectory: "client", previewMode: "static" }, store, settings)[0]!;
    const read = async (guide: string, reference?: string) => {
      const result = await tool.execute("guide", { guide, reference }, undefined, undefined, {} as never);
      return result.content.map(item => item.type === "text" ? item.text : "").join("\n");
    };
    expect(await read("ohmygame")).toContain("images.md");
    const project = await read("ohmygame", "project.md");
    expect(project).toContain("Static files preview serves index.html and its relative assets from the client/ folder");
    expect(project).not.toContain("gl.getParameter");
    expect(await read("ohmygame", "textures.md")).toContain("gl.getParameter");
    await expect(read("ohmygame", "../secret.md")).rejects.toThrow("Unknown");
    await expect(read("blender-assets")).rejects.toThrow("unavailable");
  });

  it("routes Blender tasks to the applicable stage references through the enabled workflow guide", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();
    const settings = new PluginSettingsStore(await temporaryTestDirectory("ohmygame-blender-guide-"));
    await settings.load();
    const tool = workflowGuideTools({ type: "web-game" }, store, settings)[0]!;
    const read = async (reference?: string) => {
      const result = await tool.execute("guide", { guide: "blender-assets", reference }, undefined, undefined, {} as never);
      return result.content.map(item => item.type === "text" ? item.text : "").join("\n");
    };
    const guide = await read();
    const introduction = guide.split(/^## /m)[0];
    expect(introduction).toMatch(/every Blender stage headlessly with `run_blender`[\s\S]*run report, saved model and rendered images/i);
    expect(introduction).toMatch(/without waiting for a Blender window/i);
    expect(introduction).toMatch(/open the saved `scene\.blend` manually/i);
    expect(introduction).toContain("review card");
    expect(introduction).toMatch(/wait for the user's approval/i);
    expect(introduction).toMatch(/wait for the user to accept/i);
    expect(introduction).toMatch(/main Agent reviews intermediate/i);
    const routes = guide.split("\n").filter(line => line.startsWith("|"));
    expect(routes).toEqual(expect.arrayContaining([
      expect.stringMatching(/concept art.*before generating the first view.*references\/turnaround\.md/i),
      expect.stringMatching(/existing model.*preserve.*original.*inspect.*references\/pipeline\.md/i),
      expect.stringMatching(/dimensioned prop.*measured parts.*export.*references\/pipeline\.md/i),
    ]));
    const dimensions = routes.find(line => /dimensioned prop/i.test(line))!;
    expect(dimensions).not.toMatch(/references\/(turnaround|rig-animation)\.md/);
    expect(guide).toMatch(/rig.*references\/rig-animation\.md/i);
    expect(guide).toMatch(/legless[^\n]*multi-legged[^\n]*`custom`/i);
    expect(guide).toMatch(/custom.*references\/custom-python\.md/i);
    expect(guide).toContain("references/optimization.md");
    expect(routes.find(line => /concept art/i.test(line))).toContain("references/design-proofs.md");
    const design = await read("design-proofs.md");
    expect(design).toMatch(/capability: "image"[\s\S]*custom-python.md[\s\S]*Open each run's relevant images[\s\S]*complete ordered set and original/);
    expect(design).not.toContain("## Clean a static copy");

    const [views, pipeline, rig, custom, optimization] = await Promise.all(
      ["turnaround.md", "pipeline.md", "rig-animation.md", "custom-python.md", "optimization.md"].map(read),
    );
    const optimizationTopics = optimization.split("\n").filter(line => line.startsWith("## ")).join("\n");
    for (const topic of [/geometry/i, /texture/i, /material/i, /bak(?:e|ing)/i, /animation/i])
      expect(optimizationTopics).toMatch(topic);
    expect(views).toMatch(/left shoulder[\s\S]*waist anchor[\s\S]*wrist and thumb[\s\S]*heel and toes/i);
    expect(views).toMatch(/inspect_3d_views[\s\S]*originalPath[\s\S]*per view in chat[\s\S]*turnaround review card[\s\S]*complete set for a new review/);
    expect(views).toMatch(/sourceAssetId[\s\S]*brief\.route: "tripo"/);
    expect(rig).toContain("contactPoint");
    expect(rig).toContain("contactFootBones");
    expect(custom).toContain("--input-dir");
    expect(custom).toContain("--output-dir");
    expect(custom).toContain("compress=False");
    expect(custom).toMatch(/background\s+mode[\s\S]*no window or active viewport/i);
    expect(pipeline).toMatch(/Canvas checkpoint presents the saved outputs of a completed background run/i);
    for (const mode of ["internal", "checkpoint", "final"]) {
      expect(pipeline).toContain(`reviewPresentation: "${mode}"`);
    }
    expect(pipeline).toMatch(/progress or evidence\s+for a choice only the user can make/);
    expect(pipeline).toMatch(/unapproved spending/);
    expect(pipeline).toContain("visualReview");
    expect(pipeline).toContain("final user acceptance on the exact candidate");
    expect(guide).toMatch(/wait for the user's decision/i);
    await expect(read("../scripts/pipeline.py")).rejects.toThrow();
    await settings.update(store.read("ohmygame:blender")!, { enabled: false, components: {} });
    await expect(read()).rejects.toThrow("unavailable");
    await expect(read("turnaround.md")).rejects.toThrow("unavailable");
  });

  it("loads beta plugins with their native skills and connections", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();
    expect(store.list().filter(plugin => plugin.beta).map(plugin => plugin.name)).toEqual([
      "aseprite", "blender", "cocos-creator", "douyin-minigame", "godot", "ink-studio",
      "taptap-maker", "tiled", "unity", "unreal-engine", "wechat-minigame",
    ]);
    for (const plugin of store.list().filter(plugin => plugin.beta)) {
      expect(plugin.icon?.type, plugin.name).toBe("asset");
      const image = await store.readIcon(plugin.id);
      expect(image, plugin.name).toBeDefined();
      expect(image!.bytes.length).toBeGreaterThan(0);
      expect(["image/png", "image/svg+xml"]).toContain(image!.mediaType);
    }
    expect(store.read("ohmygame:blender")).toMatchObject({
      enabled: true,
      skills: [{ id: "skills/blender-assets/SKILL.md", description: expect.stringContaining("final user review") }],
      mcpServers: [],
    });
    expect(store.read("ohmygame:ink-studio")).toMatchObject({
      enabled: false,
      projectTypes: ["web-game"],
      skills: [{ id: "skills/ink-studio/SKILL.md" }],
      mcpServers: [],
    });
    expect(store.read("ohmygame:godot")).toMatchObject({
      enabled: true,
      skills: [{ id: "skills/godot-game/SKILL.md" }],
      mcpServers: [{ id: "godot" }],
      configuration: { "godot-path": { default: "godot" } },
    });
    expect(store.read("ohmygame:taptap-maker")).toMatchObject({
      enabled: false,
      skills: [{ id: "skills/taptap-maker/SKILL.md" }],
      mcpServers: [{ id: "taptap-maker" }],
      projectTypes: ["general"],
    });
    for (const [name, skill] of [
      ["aseprite", "aseprite-assets"],
      ["cocos-creator", "cocos-creator"],
      ["douyin-minigame", "douyin-minigame"],
      ["tiled", "tiled-maps"],
      ["unity", "unity-game"],
      ["unreal-engine", "unreal-game"],
      ["wechat-minigame", "wechat-minigame"],
    ]) {
      const plugin = store.read(`ohmygame:${name}`)!;
      expect(plugin).toMatchObject({
        enabled: false,
        beta: true,
        skills: [{ id: `skills/${skill}/SKILL.md` }],
        projectTypes: name === "aseprite" || name === "tiled"
          ? ["general", "web-game", "godot-game", "asset-canvas"]
          : ["general"],
      });
      expect(plugin.mcpServers?.map(server => server.id)).toEqual(name === "unreal-engine" ? ["unreal"] : []);
    }
  });

  it("loads a standard skill-only OhMyGame plugin directory", async () => {
    const root = await temporaryTestDirectory("ohmygame-bundled-plugins-");
    const plugin = path.join(root, "reference-modeler");
    await mkdir(path.join(plugin, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(plugin, "skills", "reference-modeler"), { recursive: true });
    const icon = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    await writeFile(path.join(plugin, "icon.png"), icon);
    await writeFile(path.join(plugin, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "reference-modeler",
      version: "0.1.0",
      description: "Rebuild a reference as a model",
      skills: "./skills/",
      interface: { longDescription: "A detailed modeling workflow.", icon: { type: "asset", path: "./icon.png" } },
    }));
    await writeFile(path.join(plugin, "skills", "reference-modeler", "SKILL.md"), "---\nname: reference-modeler\ndescription: Model a reference\n---\n");
    const store = new BundledPluginStore(root);

    await store.load();

    expect(store.list()).toMatchObject([{
      id: "ohmygame:reference-modeler",
      source: { type: "builtIn" },
      longDescription: "A detailed modeling workflow.",
      skills: [{ id: "skills/reference-modeler/SKILL.md" }],
      connections: [],
    }]);
    expect(store.installedPath("ohmygame:reference-modeler")).toBe(plugin);
    expect((await store.readIcon("ohmygame:reference-modeler"))?.bytes).toEqual(icon);
    expect(await store.readIcon("ohmygame:missing")).toBeUndefined();
  });

  it("loads the built-in Web Game Studio skill suite", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));

    await store.load();

    expect(store.read("ohmygame:web-game-studio")).toMatchObject({
      displayName: "Web Game Studio",
      projectTypes: ["web-game"],
      skills: [
        { id: "skills/eight-direction-character/SKILL.md", name: "Eight Direction Character" },
        { name: "Game Playtest" },
        { name: "Game Ui Frontend" },
        { name: "Phaser 2d Game" },
        { name: "React Three Fiber Game" },
        { name: "Sprite Pipeline" },
        { name: "Three Webgl Game" },
        { name: "Web 3d Asset Pipeline" },
        { name: "Web Game Foundations" },
        { name: "Web Game Studio" },
      ],
    });
  });

  it("loads Game Studio independently of the Web Game Studio suite", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));
    await store.load();

    expect(store.read("ohmygame:game-studio")).toMatchObject({
      displayName: "Game Studio",
      enabled: true,
      projectTypes: ["general", "godot-game", "interactive-story"],
      skills: [
        { id: "skills/game-foundations/SKILL.md", name: "Game Foundations" },
        { id: "skills/game-qa/SKILL.md", name: "Game Qa" },
        { id: "skills/game-studio/SKILL.md", name: "Game Studio" },
      ],
      connections: [],
    });
  });

  it("loads the built-in Three.js World skill", async () => {
    const store = new BundledPluginStore(path.resolve("plugins"));

    await store.load();

    expect(store.read("ohmygame:threejs-world")).toMatchObject({
      displayName: "Three.js World",
      projectTypes: ["web-game"],
      skills: [{ id: "skills/threejs-world/SKILL.md", name: "Threejs World" }],
    });
  });
});
