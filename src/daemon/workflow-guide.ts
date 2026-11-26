import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { readProjectWorkflow, type AgentPromptProject } from "./agent-prompts.js";
import type { BundledPluginStore } from "./bundled-plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { INK_STUDIO_PLUGIN_ID } from "../shared/plugins.js";

const studioWorkflows = new Set(["web-game-studio", "game-studio", "threejs-world", "blender", "ink-studio"]);

/** Packaged production notes, independently of executable plugins or ambient Pi skills. */
export function workflowGuideTools(project: AgentPromptProject, store: BundledPluginStore, settings: PluginSettingsStore, inkStudioEnabled: () => boolean = () => false) {
  const guides = new Map<string, { root: string; pluginId: string; skillId: string }>();
  for (const bundled of store.list()) {
    const plugin = settings.decorate(bundled);
    if (!studioWorkflows.has(plugin.name) || !plugin.enabled || !plugin.projectTypes?.includes(project.type)) continue;
    if (plugin.id === INK_STUDIO_PLUGIN_ID && !inkStudioEnabled()) continue;
    const root = store.installedPath(plugin.id);
    if (!root) continue;
    for (const skill of plugin.skills) {
      if (skill.enabled && /^skills\/[a-z0-9-]+\/SKILL\.md$/.test(skill.id)) {
        guides.set(path.posix.basename(path.posix.dirname(skill.id)), { root, pluginId: plugin.id, skillId: skill.id });
      }
    }
  }
  return [defineTool({
    name: "read_workflow_guide", label: "Read studio workflow",
    description: "Read an OhMyGame operating reference or an enabled studio guide. Call with only guide to read its main instructions and find available reference filenames. Returns text only.",
    parameters: Type.Object({
      guide: Type.Union(["ohmygame", ...guides.keys()].map(name => Type.Literal(name))),
      reference: Type.Optional(Type.String({ maxLength: 120, pattern: "^[a-zA-Z0-9_-]+\\.(md|txt)$", description: "For a guide's references/ link, the filename only." })),
    }, { additionalProperties: false }),
    execute: async (_id, { guide, reference }, signal) => {
      signal?.throwIfAborted();
      if (guide === "ohmygame")
        return { content: [{ type: "text", text: readProjectWorkflow(project, reference) }], details: { guide, source: reference ?? "index" } };
      const entry = guides.get(guide);
      const plugin = entry && store.read(entry.pluginId);
      const current = plugin && settings.decorate(plugin);
      if (!entry || !current?.enabled || !current.skills.some(skill => skill.id === entry.skillId && skill.enabled))
        throw new Error("This studio guide is unavailable for the project.");
      if (entry.pluginId === INK_STUDIO_PLUGIN_ID && !inkStudioEnabled()) throw new Error("This studio guide is unavailable for the project.");
      if (reference !== undefined && !/^[a-zA-Z0-9_-]+\.(md|txt)$/.test(reference))
        throw new Error("Choose a Markdown or text filename from the guide's references/ links.");
      const source = reference ? path.join(path.dirname(entry.skillId), "references", reference) : entry.skillId;
      const readGuide = (file: string) => readSafeProjectFile(entry.root, path.join(entry.root, file), 64 * 1024);
      try {
        const file = await readGuide(source);
        return { content: [{ type: "text", text: file.toString("utf8") }], details: { guide, source } };
      } catch (cause) {
        if (!reference || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        const main = await readGuide(entry.skillId);
        return { content: [{ type: "text", text: `The guide has no reference named ${reference}. Here is its main workflow.\n\n${main.toString("utf8")}` }],
          details: { guide, source: entry.skillId } };
      }
    },
  })];
}
