import {
  createToolSearchExtension,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";

// Ordinary file work, workflow discovery and the saved Canvas generation path keep their full guidance.
const specialistTools = new Set([
  "generate_image",
  "generate_reference_image",
  "generate_3d_asset",
  "generate_3d_from_views",
  "animate_3d_asset",
  "generate_video",
  "generate_speech",
  "generate_music",
  "generate_sound_effect",
  "run_blender",
  "recover_blender_run",
  "inspect_3d_views",
  "review_tripo_model",
  "game_use",
  "prepare_three_runtime",
  "ensure_ink_runtime",
  "prepare_character_views",
  "optimize_image_asset",
  "get_model_asset",
  "isolated_shell",
  "recover_isolated_changes",
  "build_game",
  "playable_add_node",
  "playable_check",
  "use_canvas_asset",
  "replace_canvas_media",
]);

export const projectToolSearchDescription =
  "Find available project tools by English keywords. Use an exact tool name to read its full usage and parameter descriptions.";

/** Request-only projection. Pi validates and executes the original registered definitions. */
export function compactProjectToolDeclaration(tool: Tool): Tool {
  if (tool.name === "tool_search") return { ...tool, description: projectToolSearchDescription };
  if (!specialistTools.has(tool.name)) return tool;
  const parameters = JSON.parse(JSON.stringify(tool.parameters, (key, value) => {
    // A property named "description" has an object schema and must survive.
    if (key === "description" && typeof value === "string") return undefined;
    const variants = value?.anyOf;
    if (Array.isArray(variants) && variants.length && variants.every(variant =>
      variant?.type === "string" && typeof variant.const === "string"
      && Object.keys(variant).every(field => ["type", "const", "description"].includes(field)))) {
      const { anyOf, ...rest } = value;
      return { ...rest, type: "string", enum: anyOf.map((variant: { const: string }) => variant.const) };
    }
    return value;
  }));
  return { ...tool, description: tool.description.split(/(?<=[.!?])\s|\n/, 1)[0]!, parameters };
}

export const projectToolSearch: ExtensionFactory = (pi) => {
  pi.on("context_with_system", ({ messages }) => ({
    messages: messages.map(message => message.role === "system" && message.toolsAdded
      ? { ...message, toolsAdded: message.toolsAdded.map(compactProjectToolDeclaration) }
      : message),
  }));
  const authorizedTools = () => {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools().filter(tool => active.has(tool.name));
  };
  return createToolSearchExtension()({
    ...pi,
    // Use Pi's metadata index and BM25 ranking without changing the session's active tools.
    getActiveTools: () => [],
    getAllTools: () => authorizedTools().filter(tool => tool.name !== "tool_search").map(tool => ({ ...tool, exposure: "deferred" })),
    setActiveTools: () => {},
    registerTool: definition => pi.registerTool({
      name: definition.name,
      label: definition.label,
      parameters: definition.parameters,
      exposure: definition.exposure,
      defaultActive: definition.defaultActive,
      reachesTools: definition.reachesTools,
      description: projectToolSearchDescription,
      promptSnippet: "Find project tools or inspect parameters",
      execute: async (id, args, signal, _onUpdate, ctx) => {
        const query = String(args.query).trim();
        const exact = pi.getAllTools().find(tool => tool.name === query);
        if (exact) {
          if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0))
            throw new Error("limit must be a positive integer");
          if (!pi.getActiveTools().includes(exact.name))
            return { content: [{ type: "text", text: "No matching tools found." }], details: { matches: [] } };
          const text = [exact.name, exact.description, ...(exact.promptGuidelines ?? []), JSON.stringify(exact.parameters)].join("\n");
          return { content: [{ type: "text", text }], details: { matches: [exact.name] } };
        }
        const result = await definition.execute(id, args, signal, undefined, ctx);
        const matches = (result.details as { loaded: string[] }).loaded;
        const text = matches.length
          ? `Matching tools: ${matches.join(", ")}. Search an exact name for detailed parameters.`
          : "No matching tools found.";
        return { content: [{ type: "text", text }], details: { matches } };
      },
    }),
  });
};
