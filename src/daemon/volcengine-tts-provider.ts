import { DOUBAO_SPEECH_PROVIDER_NAME, type AudioGenerationInput, type AudioGenerationRequest, type AudioModel, type GeneratedAudio } from "../shared/audio.js";
import { AudioGenerationError, type AudioProviderAdapter } from "./audio-generation.js";
import { generateKunpoAudio, KUNPO_AUDIO_ENDPOINT, kunpoAudioModels, validateKunpoAudioInput } from "./kunpo-audio.js";

const PROVIDER_ID = "volcengine-tts";
export const VOLCENGINE_TTS_MODELS: readonly AudioModel[] = kunpoAudioModels(PROVIDER_ID, DOUBAO_SPEECH_PROVIDER_NAME, true);

/** Seed Audio speech is a candidate route; exact reading and timing remain unverified. */
export class VolcengineTtsProvider implements AudioProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly name = DOUBAO_SPEECH_PROVIDER_NAME;

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly baseUrl = KUNPO_AUDIO_ENDPOINT,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  configured(): boolean { return Boolean(this.apiKey()); }
  enabled(): boolean { return this.isEnabled(); }
  models(): AudioModel[] { return VOLCENGINE_TTS_MODELS.map((entry) => structuredClone(entry)); }
  validate(input: AudioGenerationRequest): void { validateKunpoAudioInput(input, this.id); }

  async generate(input: AudioGenerationInput, signal?: AbortSignal): Promise<GeneratedAudio> {
    if (!this.enabled()) throw new AudioGenerationError("Kunpo speech provider is disabled", 409);
    if (input.operation !== "speech") throw new AudioGenerationError("This Kunpo audio provider supports speech generation only", 400);
    const key = this.apiKey();
    if (!key) throw new AudioGenerationError("Connect Kunpo before generating speech", 503);
    return generateKunpoAudio({ input, provider: this.id, key, request: this.request, endpoint: this.baseUrl, signal });
  }
}
