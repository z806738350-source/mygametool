import { GPT_IMAGE_26_IDS } from "./gpt-image-26.js";
import type { CustomProviderDetails, CustomProviderModel, ModelRef } from "./contracts.js";

export const KUNPO_PROVIDER_ID = "kunpo";
export const KUNPO_BASE_URL = "https://llm.ziy.cc/v1";
export const KUNPO_MODEL_ROLES = ["agent", "image", "video", "sound-effect", "speech", "music", "3d-generation", "3d-remesh", "3d-rig", "3d-texture"] as const;
export type KunpoModelRole = typeof KUNPO_MODEL_ROLES[number];
export type KunpoModelSelections = Partial<Record<KunpoModelRole, ModelRef>>;
export interface KunpoModelOption extends ModelRef {
  role: KunpoModelRole;
  name: string;
  protocol: string;
  /** Unverified means the adapter is available, not that real model quality was tested. */
  status: "unverified" | "pending";
  description: string;
  docsUrl: string;
  /** Gateway/adapter verification is separate from the upstream model's capabilities. */
  imageInputStatus?: "unverified";
  capabilities: {
    images?: boolean; tools?: boolean; transparency?: boolean; mask?: boolean;
    maxReferences?: number; strictText?: boolean; loop?: boolean;
  };
}
const docs = "https://docs.ziy.cc/api-reference/";
function option(role: KunpoModelRole, provider: string, id: string, protocol: string, page: string,
  description: string, capabilities: KunpoModelOption["capabilities"] = {}, status: KunpoModelOption["status"] = "unverified"): KunpoModelOption {
  return { role, provider, id, name: id, protocol, status, description, docsUrl: `${docs}${page}/`, capabilities };
}

/** Reviewed routing IDs, not a claim about upstream weights or real-account availability. */
export const KUNPO_MODEL_OPTIONS: readonly KunpoModelOption[] = [
  option("agent", "kunpo", "gpt-5.6-sol", "openai-completions", "text-chat", "Images and tools are listed in the model square; reasoning controls and context limits are not independently documented.", { images: true, tools: true }),
  option("agent", "kunpo", "claude-opus-5-5", "anthropic-messages", "claude-opus-55", "Adaptive thinking is always enabled; tools use auto and preserve signed thinking history.", { images: true, tools: true }),
  { ...option("agent", "kunpo", "gpt-6.1-sol", "openai-responses", "gpt-6-1-sol", "OpenAI documents image input. This Kunpo Responses route's image/tool continuation is not verified.", { images: true, tools: true }), imageInputStatus: "unverified" },
  option("agent", "kunpo", "gemini-3.8-flash", "openai-completions", "text-chat", "Model-square metadata only; dedicated reasoning and multimodal tool contracts need verification.", { images: true, tools: true }, "pending"),
  option("agent", "kunpo", "claude-sonnet-5-5", "anthropic-messages", "claude-sonnet-55", "Candidate retained; its complete Agent request contract is not integrated yet.", { images: true }, "pending"),
  option("agent", "kunpo", "kimi-k3.1-pro", "openai-completions", "kimi-k3-1-pro", "Text chat is documented; screenshot plus tool continuation is not confirmed.", {}, "pending"),
  option("image", "openai", "gpt-image-2.5-sunburst", "openai-images", "image-generation/models/gpt-image-series", "Synchronous image generation and editing; PNG transparency and edit masks.", { images: true, transparency: true, mask: true, maxReferences: 16 }),
  option("image", "openai", "gpt-image-2.5-flare", "openai-images", "image-generation/models/gpt-image-series", "Synchronous image generation and editing; PNG transparency and edit masks.", { images: true, transparency: true, mask: true, maxReferences: 16 }),
  ...GPT_IMAGE_26_IDS.map(id => option("image", "openai", id, "openai-images", "image-generation/models/gpt-image-series", "Static images and edits, text-to-SVG and animated GIF.", { images: true, transparency: true, mask: true, maxReferences: 16 })),
  option("image", "openai", "Image-GI2.1", "openai-images", "image-generation/models/nano-banana-series", "Reference-image generation; no transparency or masks. Ratios are not exact output-pixel guarantees.", { images: true, transparency: false, mask: false, maxReferences: 14 }),
  option("video", "volcengine-ark", "doubao-seedance-2-5-260628", "seedance", "seedance-25", "Native task API; 4–30 seconds, up to 1080p. Poll the saved task instead of submitting it again."),
  option("video", "kunpo", "tencent-vod-vs-2.5", "kunpo-videos", "video-vs25", "Videos task API; 4–30 seconds, up to 4K. Its statuses differ from the native Seedance API."),
  option("video", "kunpo", "minimax-video-h3", "kunpo-videos", "minimax-h3", "Videos task API; 4–15 seconds, 768P or 2K."),
  option("sound-effect", "volcengine-seed-audio", "seed-audio-1.0", "kunpo-seed-audio-binary", "seed-audio", "Binary, non-streaming sound effects and ambient audio; at most 120 seconds.", { loop: false }),
  option("sound-effect", "volcengine-seed-audio", "seed-audio-1.0-multilingual", "kunpo-seed-audio-binary", "seed-audio", "Multilingual audio generation; quality is not presumed better than the base model.", { loop: false }),
  option("speech", "volcengine-tts", "seed-audio-1.0", "kunpo-seed-audio-binary", "seed-audio", "Reference-audio voice candidate (MP3/WAV, at most 30 seconds / 10 MB). Exact script reading and subtitle alignment are unverified.", { strictText: false }),
  option("speech", "volcengine-tts", "seed-audio-1.0-multilingual", "kunpo-seed-audio-binary", "seed-audio", "Multilingual reference-audio voice candidate (MP3/WAV, at most 30 seconds / 10 MB). Exact script reading and subtitle alignment are unverified.", { strictText: false }),
  option("music", "volcengine-seed-audio", "seed-audio-1.0", "kunpo-seed-audio-binary", "seed-audio", "Short ambient-music candidate only; full BGM, lyrics and seamless loops are not confirmed.", { loop: false }),
  option("3d-generation", "tripo", "v3.1-20260211", "tripo", "tripo-3d", "Geometry generation with optional texture and PBR; not a rig or remesh version.", { maxReferences: 4 }),
  option("3d-generation", "tripo", "P1-20260311", "tripo", "tripo-3d", "Low-poly triangular assets; no quad output.", { maxReferences: 4 }),
  option("3d-generation", "tripo", "P2-20260801", "tripo", "tripo-3d", "Preview low-poly generation with quad output; does not replace every H-series use.", { maxReferences: 4 }),
  option("3d-remesh", "tripo", "v3.0", "tripo", "tripo-3d", "Remesh with optional quad and smart_uv; parse the actual output format."),
  option("3d-rig", "tripo", "v3.0-20260909", "tripo", "tripo-3d", "Humanoid or others rigging. Internal retarget requires the tripo skeleton specification."),
  option("3d-rig", "tripo", "v2.5-20260210", "tripo", "tripo-3d", "Compatible non-humanoid rigging; use rig-check and compatible animation presets."),
  ...["v3.5-20260815", "v3.0-20250812", "v2.5-20250123"].map((id) => option("3d-texture", "tripo", id, "tripo", "tripo-3d", "Optional texture processing version; do not rerun when the generated texture already meets the task.")),
];

/** Snapshot these only when creating a new project. Existing selections never migrate. */
export const KUNPO_DEFAULT_MODEL_REFS: Readonly<KunpoModelSelections> = {
  agent: { provider: KUNPO_PROVIDER_ID, id: "gpt-5.6-sol" },
  image: { provider: "openai", id: "gpt-image-2.5-sunburst" },
  video: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" },
  "sound-effect": { provider: "volcengine-seed-audio", id: "seed-audio-1.0" },
  speech: { provider: "volcengine-tts", id: "seed-audio-1.0" },
  "3d-generation": { provider: "tripo", id: "v3.1-20260211" },
  "3d-remesh": { provider: "tripo", id: "v3.0" },
  "3d-rig": { provider: "tripo", id: "v3.0-20260909" },
  "3d-texture": { provider: "tripo", id: "v3.5-20260815" },
};
export function kunpoModelOption(role: KunpoModelRole, reference?: ModelRef): KunpoModelOption | undefined {
  return reference && KUNPO_MODEL_OPTIONS.find((entry) => entry.role === role && entry.provider === reference.provider && entry.id === reference.id);
}
export function validateKunpoSelection(role: KunpoModelRole, reference: ModelRef, options: { forExecution?: boolean } = {}): KunpoModelOption {
  const selected = kunpoModelOption(role, reference);
  if (!selected) throw new Error("The model is not a reviewed option for this operation");
  if (options.forExecution && selected.status === "pending") throw new Error("The selected model is retained as a candidate but is not integrated yet");
  return selected;
}

const budget = { contextWindow: 128_000, maxTokens: 16_384 };
export function kunpoProviderDetails(): CustomProviderDetails {
  const language: CustomProviderModel[] = [
    // Conservative client budgets, not a claim about GPT-5.6's undocumented server limits.
    { id: "gpt-5.6-sol", name: "gpt-5.6-sol", api: "openai-completions", ...budget, reasoning: false, supportsImages: true, usages: { language: true } },
    { id: "claude-opus-5-5", name: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "https://llm.ziy.cc", contextWindow: 1_000_000, maxTokens: 128_000,
      reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }, supportsImages: true, usages: { language: true } },
    { id: "gpt-6.1-sol", name: "gpt-6.1-sol", api: "openai-responses", contextWindow: 1_050_000, maxTokens: 128_000,
      // Effective adapter setting, not an upstream model limitation. Keep closed until the gateway contract is confirmed.
      reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, supportsImages: false, usages: { language: true } },
  ];
  const video: CustomProviderModel[] = ["tencent-vod-vs-2.5", "minimax-video-h3"].map((id) => ({
    id, name: id, api: "openai-completions", ...budget, reasoning: false, supportsImages: false,
    usages: { video: { protocol: "kunpo-videos", baseUrl: KUNPO_BASE_URL,
      resolutions: id === "minimax-video-h3" ? ["768p", "2K"] : ["480p", "720p", "1080p", "2K", "4K"],
      aspectRatios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
      durations: Array.from({ length: id === "minimax-video-h3" ? 12 : 27 }, (_, index) => index + 4), maxReferenceImages: 2, referenceModes: ["frame", "reference"] } },
  }));
  return { id: KUNPO_PROVIDER_ID, name: "KunpoAPI", baseUrl: KUNPO_BASE_URL, api: "openai-completions", authentication: "api_key", preset: "gateway", modelConfigurationVersion: 2, models: [...language, ...video], hiddenModelIds: [] };
}
