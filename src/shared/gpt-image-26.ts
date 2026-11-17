export const GPT_IMAGE_26_IDS = ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"] as const;
export const GPT_IMAGE_FORMATS = ["png", "jpeg", "webp", "svg", "gif"] as const;
export const GPT_IMAGE_COMPLEXITIES = ["low", "medium", "high"] as const;
export const GPT_IMAGE_SVG_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export const GPT_IMAGE_SVG_MODELS = ["gpt-6-sol", "gpt-6.1-sol"] as const;
export const GPT_IMAGE_26_DEFAULTS = {
  complexity: "high",
  svgModel: "gpt-6-sol",
  svgReasoningEffort: "low",
  frameCount: 9,
  frameDurationMs: 200,
} as const;

export interface GptImage26Options {
  complexity?: typeof GPT_IMAGE_COMPLEXITIES[number];
  pixelSize?: string;
  svgModel?: string;
  svgReasoningEffort?: typeof GPT_IMAGE_SVG_EFFORTS[number];
  frameCount?: number;
  frameDurationMs?: number;
}

export function isGptImage26(id?: string): boolean {
  return GPT_IMAGE_26_IDS.some(model => model === id);
}

export const GPT_IMAGE_26_SCHEMA = {
  complexity: { enum: GPT_IMAGE_COMPLEXITIES },
  pixelSize: { type: "string", pattern: "^[1-9][0-9]*x[1-9][0-9]*$", maxLength: 32 },
  svgModel: { enum: GPT_IMAGE_SVG_MODELS },
  svgReasoningEffort: { enum: GPT_IMAGE_SVG_EFFORTS },
  frameCount: { type: "integer", minimum: 2, maximum: 16 },
  frameDurationMs: { type: "integer", minimum: 20, maximum: 2000 },
} as const;

export function gptImage26Options(settings: GptImage26Options): GptImage26Options {
  const { complexity, pixelSize, svgModel, svgReasoningEffort, frameCount, frameDurationMs } = settings;
  return Object.fromEntries(Object.entries({ complexity, pixelSize, svgModel, svgReasoningEffort, frameCount, frameDurationMs }).filter(([, value]) => value !== undefined));
}

export function gptImage26FrameSize(aspectRatio = "1:1"): string {
  const [width, height] = aspectRatio.split(":").map(Number);
  const ratio = width! / height!;
  if (!(ratio >= 1 / 3 && ratio <= 3)) return "512x512";
  if (ratio === 16 / 9) return "768x432";
  if (ratio === 9 / 16) return "432x768";
  const align = (n: number) => 16 * Math.round(n / 16);
  const w = align(512 * Math.sqrt(ratio)), h = align(512 / Math.sqrt(ratio));
  return `${Math.min(w, h * 3)}x${Math.min(h, w * 3)}`;
}

interface Settings extends GptImage26Options {
  quality?: string;
  outputFormat?: string;
  background?: string;
  outputCompression?: number;
  mask?: unknown;
  markup?: unknown;
}

export const GPT_IMAGE_26_PROBLEMS = {
  requires26: "These image options require GPT Image 2.6 Sunburst or Flare.",
  format: "Unsupported GPT Image 2.6 output format.",
  complexity: "Choose low, medium or high image complexity.",
  pixelSize: "Pixel size requires positive multiples of 16 and an aspect ratio between 1:3 and 3:1.",
  transparency: "Transparent output requires PNG, WebP or SVG.",
  compression: "Compression requires JPEG or WebP and an integer from 0 to 100.",
  svgInput: "SVG requires one text-only output with no references, mask or markup.",
  svgAuthor: "Choose a supported SVG author.",
  svgEffort: "The selected SVG author does not support this reasoning effort.",
  svgOnly: "SVG author options require SVG output.",
  gifInput: "GIF editing supports static references only; remove the mask or markup.",
  gifFrameCount: "GIF frame count must be from 2 to 16.",
  gifDuration: "GIF frame duration must be from 20 to 2000 ms.",
  gifBudget: "Flare rejected nine 1024x1024 GIF frames at max quality. Choose a smaller frame or change the settings.",
  gifOnly: "Animation frame settings require GIF output.",
  editLayers: "Choose either a mask or a markup layer.",
  referenceRequired: "A mask or markup layer needs a reference image.",
} as const;
export type GptImage26Problem = keyof typeof GPT_IMAGE_26_PROBLEMS;

/** Validate the combined node/request before creating a paid generation. */
export function validateGptImage26Settings(modelId: string | undefined, settings: Settings, referenceCount: number, outputs = 1, translate: (problem: GptImage26Problem) => string = key => GPT_IMAGE_26_PROBLEMS[key]): string | undefined {
  const { complexity, pixelSize, svgModel, svgReasoningEffort, frameCount, frameDurationMs, outputCompression, markup, mask } = settings;
  const format = settings.outputFormat ?? "png";
  if (!isGptImage26(modelId)) {
    if (markup || Object.keys(gptImage26Options(settings)).length || ["webp", "svg", "gif"].includes(format))
      return translate("requires26");
    return;
  }
  if (!GPT_IMAGE_FORMATS.some(option => option === format)) return translate("format");
  if (complexity !== undefined && !GPT_IMAGE_COMPLEXITIES.includes(complexity)) return translate("complexity");
  if (pixelSize !== undefined) {
    if (typeof pixelSize !== "string") return translate("pixelSize");
    const [w, h] = pixelSize.split("x").map(Number);
    if (!/^[1-9][0-9]*x[1-9][0-9]*$/.test(pixelSize) || !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w! % 16 || h! % 16 || w! / h! > 3 || h! / w! > 3)
      return translate("pixelSize");
  }
  if (settings.background === "transparent" && !["png", "webp", "svg"].includes(format)) return translate("transparency");
  if (outputCompression !== undefined && (!["jpeg", "webp"].includes(format) || !Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100))
    return translate("compression");
  if (format === "svg") {
    if (referenceCount || mask || markup || outputs !== 1) return translate("svgInput");
    if (svgModel !== undefined && !GPT_IMAGE_SVG_MODELS.some(model => model === svgModel)) return translate("svgAuthor");
    if (svgReasoningEffort !== undefined && (!GPT_IMAGE_SVG_EFFORTS.includes(svgReasoningEffort) || (svgModel === "gpt-6.1-sol" && svgReasoningEffort === "none")))
      return translate("svgEffort");
  } else if (svgModel !== undefined || svgReasoningEffort !== undefined) return translate("svgOnly");
  if (format === "gif") {
    if (mask || markup) return translate("gifInput");
    if (frameCount !== undefined && (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16)) return translate("gifFrameCount");
    if (frameDurationMs !== undefined && (!Number.isInteger(frameDurationMs) || frameDurationMs < 20 || frameDurationMs > 2000)) return translate("gifDuration");
    if (modelId === GPT_IMAGE_26_IDS[1] && settings.quality === "max" && (frameCount ?? GPT_IMAGE_26_DEFAULTS.frameCount) === 9 && pixelSize === "1024x1024")
      return translate("gifBudget");
  } else if (frameCount !== undefined || frameDurationMs !== undefined) return translate("gifOnly");
  if (mask && markup) return translate("editLayers");
  if (!referenceCount && (mask || markup)) return translate("referenceRequired");
}
