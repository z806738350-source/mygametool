import type { ModelRef } from "./contracts.js";

export const AUDIO_OPERATIONS = [
  "speech",
  "dialogue",
  "sound-effect",
  "music",
] as const;
export type AudioOperation = (typeof AUDIO_OPERATIONS)[number];

export const AUDIO_OUTPUT_FORMATS = ["mp3", "wav"] as const;
export type AudioOutputFormat = (typeof AUDIO_OUTPUT_FORMATS)[number];

// Legacy board/settings validation only; the local speech UI and API use referenceAssetId.
export const AUDIO_VOICE_ID_MAX_LENGTH = 256;
export const AUDIO_VOICE_ID_PATTERN = "^[A-Za-z0-9_-]+$";
export const DOUBAO_SPEECH_PROVIDER_NAME = "Kunpo Seed Audio Speech";
export const DOUBAO_SEED_AUDIO_PROVIDER_NAME = "Kunpo Seed Audio";

export const AUDIO_SAMPLE_RATES = [
  8_000, 16_000, 24_000, 32_000, 44_100, 48_000,
] as const;
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATES)[number];

export interface AudioOutputSettings {
  format?: AudioOutputFormat;
  sampleRate?: AudioSampleRate;
  channels?: 1 | 2;
}

export interface SpeechAudioRequest {
  operation: "speech";
  text: string;
  model?: ModelRef;
  /** Legacy project/history field only. Speaker IDs are no longer submitted. */
  voiceId?: string;
  referenceAssetId?: string;
  /** Pins a selected reference's actual bytes, including editable project copies. */
  referenceSha256?: string;
  /** A local voice-design intent; the upstream still uses /audio/speech. */
  voiceDesign?: boolean;
  voiceDescription?: string;
  language?: string;
  style?: string;
  speed?: number;
  output?: AudioOutputSettings;
}

export interface DialogueAudioRequest {
  operation: "dialogue";
  model?: ModelRef;
  turns: Array<{
    speaker: string;
    voiceId: string;
    text: string;
    style?: string;
  }>;
  output?: AudioOutputSettings;
}

export interface SoundEffectAudioRequest {
  operation: "sound-effect";
  model?: ModelRef;
  prompt: string;
  durationSeconds?: number;
  loop?: boolean;
  negativePrompt?: string;
  output?: AudioOutputSettings;
}

export interface MusicAudioRequest {
  operation: "music";
  model?: ModelRef;
  prompt: string;
  instrumental: boolean;
  lyrics?: string;
  durationSeconds?: number;
  loop?: boolean;
  referenceAssetId?: string;
  output?: AudioOutputSettings;
}

export type AudioGenerationRequest =
  | SpeechAudioRequest
  | DialogueAudioRequest
  | SoundEffectAudioRequest
  | MusicAudioRequest;

/** Resolved only by the daemon; public tool requests accept an asset ID, never bytes or paths. */
export type AudioGenerationInput = AudioGenerationRequest & {
  referenceAudio?: { bytes: Uint8Array; mediaType: "audio/mpeg" | "audio/wav" };
};

export interface AudioModelCapabilities {
  operations: AudioOperation[];
  /** Documents a route, not a guarantee of generated quality or text fidelity. */
  operationStatus?: Partial<Record<AudioOperation, "documented" | "unverified" | "unavailable">>;
  capabilityNotes?: string[];
  executionModes: Array<"synchronous" | "streaming" | "async-task">;
  languages?: string[];
  formats: AudioOutputFormat[];
  sampleRates?: AudioSampleRate[];
  maxTextCharacters?: number;
  maxDurationSeconds?: number;
  maxSpeakers?: number;
  supportsSSML?: boolean;
  supportsVoiceClone?: boolean;
  supportsVoiceDesign?: boolean;
  supportsAlignment?: boolean;
  supportsLoop?: boolean;
  supportsLyrics?: boolean;
  supportsInstrumental?: boolean;
  supportsReferenceAudio?: boolean;
  supportsNegativePrompt?: boolean;
  strictTextVerified?: boolean;
}

export interface AudioModel extends ModelRef {
  name: string;
  providerName: string;
  protocol: string;
  capabilities: AudioModelCapabilities;
}

export function availableAudioOperations(models: readonly AudioModel[]): Set<AudioOperation> {
  return new Set(models.flatMap((model) => model.capabilities.operations));
}

export interface AudioProviderCatalogStatus {
  provider: string;
  name: string;
  configured: boolean;
  state: "ready" | "not_configured" | "disabled" | "error";
  message?: string;
}

export interface AudioModelCatalog {
  models: AudioModel[];
  providers: AudioProviderCatalogStatus[];
}

export interface AudioMetadata {
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  providerRequestId?: string;
  usageCharacters?: number;
  protocol?: string;
  operation?: AudioOperation;
  /** The submitted, non-secret parameters; synchronous audio has no resumable task ID. */
  parameters?: Record<string, string | number | boolean>;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  mediaType: "audio/mpeg" | "audio/wav";
  model: ModelRef;
  metadata?: AudioMetadata;
}

export interface RunSpeechToolRequest extends Omit<
  SpeechAudioRequest,
  "operation"
> {}
export interface RunSoundEffectToolRequest extends Omit<
  SoundEffectAudioRequest,
  "operation"
> {}
export interface RunMusicToolRequest extends Omit<
  MusicAudioRequest,
  "operation"
> {}
