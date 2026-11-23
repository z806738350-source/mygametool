// Offline counterfactual for a 2D reference/design phase. Keep unrecognized sections and every other guide intact.
export function diagnosticGuideResult(message, args) {
  if (message?.role !== "toolResult" || message.toolName !== "read_workflow_guide" || message.isError ||
      args?.guide !== "blender-assets" || args.reference !== "pipeline.md" ||
      message.content.length !== 1 || message.content[0].type !== "text") return message;
  const [block] = message.content;
  if (block.textSignature || !block.text.startsWith("# Blender stages and delivery\n")) return message;
  const sections = block.text.split(/(?=^## )/m);
  const keep = [];
  const deferred = [];
  for (const section of sections) {
    const heading = section.split("\n", 1)[0];
    if (!["## Inspect the original", "## Parts: dimensions before geometry", "## Clean a static copy",
      "## Export and actual game delivery"].includes(heading)) {
      keep.push(section);
      continue;
    }
    if (heading === "## Clean a static copy") {
      const visual = section.split(/\n\s*\n/).find(paragraph => paragraph.startsWith("Compare the original and candidate with matched framing"));
      if (!visual) return message;
      keep.push(visual.trimEnd() + "\n\n");
    }
    deferred.push(heading.slice(3));
  }
  if (deferred.length !== 4) return message;
  keep.push("\nFull pipeline.md also covers: " + deferred.join(", ") + ". Read the full reference when working on a 3D model.\n");
  return { ...message, content: [{ ...block, text: keep.join("") }] };
}

// Model a request for the image catalog alone, retaining shared or unfamiliar metadata.
export function imageStageCapabilities(message, args) {
  if (args?.capability !== "image" || message?.role !== "toolResult" ||
      message.toolName !== "list_media_capabilities" || message.isError ||
      message.content.length !== 1) return message;
  const [block] = message.content;
  if (block.type !== "text" || block.textSignature) return message;
  let catalog;
  try { catalog = JSON.parse(block.text); } catch { return message; }
  if (!catalog?.image || !Array.isArray(catalog.image.candidates) ||
      JSON.stringify(catalog) !== block.text) return message;
  const selected = { ...catalog };
  for (const key of ["video", "3d-generation", "3d-processing", "speech", "sound-effect", "music"])
    delete selected[key];
  const text = JSON.stringify(selected);
  if (text === block.text) return message;
  return { ...message, content: [{ ...block, text }],
    details: { ...message.details, mediaCapabilities: selected } };
}
