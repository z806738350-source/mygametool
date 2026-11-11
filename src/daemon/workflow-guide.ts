import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import type { ProjectType } from "../shared/contracts.js";
import type { BundledPluginStore } from "./bundled-plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";
import { readSafeProjectFile } from "./safe-project-file.js";

const studioWorkflows = new Set(["web-game-studio", "game-studio", "threejs-world", "blender"]);

/** Packaged production notes, independently of executable plugins or ambient Pi skills. */
export function workflowGuideTools(type: ProjectType, store: BundledPluginStore, settings: PluginSettingsStore) {
  const guides = new Map<string, { root: string; pluginId: string; skillId: string }>();
  for (const bundled of store.list()) {
    const plugin = settings.decorate(bundled);
    if (!studioWorkflows.has(plugin.name) || !plugin.enabled || !plugin.projectTypes?.includes(type)) continue;
    const root = store.installedPath(plugin.id);
    if (!root) continue;
    for (const skill of plugin.skills) {
      if (skill.enabled && /^skills\/[a-z0-9-]+\/SKILL\.md$/.test(skill.id)) {
        guides.set(path.posix.basename(path.posix.dirname(skill.id)), { root, pluginId: plugin.id, skillId: skill.id });
      }
    }
  }
  if (!guides.size) return [];
  return [defineTool({
    name: "read_workflow_guide", label: "Read studio workflow",
    description: "Read an enabled bundled studio guide or a text reference named by that guide. This only returns writing. It cannot start Blender, plugin programs, or MCP servers.",
    parameters: Type.Object({
      guide: Type.Union([...guides.keys()].map(name => Type.Literal(name))),
      reference: Type.Optional(Type.String({ maxLength: 120, pattern: "^[a-zA-Z0-9_-]+\\.(md|txt)$", description: "For a guide's references/ link, the filename only." })),
    }, { additionalProperties: false }),
    execute: async (_id, { guide, reference }, signal) => {
      signal?.throwIfAborted();
      const entry = guides.get(guide);
      const plugin = entry && store.read(entry.pluginId);
      const current = plugin && settings.decorate(plugin);
      if (!entry || !current?.enabled || !current.skills.some(skill => skill.id === entry.skillId && skill.enabled))
        throw new Error("This studio guide is unavailable for the project.");
      if (reference !== undefined && !/^[a-zA-Z0-9_-]+\.(md|txt)$/.test(reference))
        throw new Error("Choose a Markdown or text filename from the guide's references/ links.");
      const source = reference ? path.join(path.dirname(entry.skillId), "references", reference) : entry.skillId;
      const file = await readSafeProjectFile(entry.root, path.join(entry.root, source), 64 * 1024);
      const content = file.toString("utf8");
      return { content: [{ type: "text", text: content }], details: { guide, source } };
    },
  })];
}
