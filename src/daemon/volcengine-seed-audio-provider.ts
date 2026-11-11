import { DOUBAO_SEED_AUDIO_PROVIDER_NAME, type AudioGenerationRequest, type AudioModel, type GeneratedAudio } from "../shared/audio.js";
import { AudioGenerationError, type AudioProviderAdapter } from "./audio-generation.js";
import { generateKunpoAudio, KUNPO_AUDIO_ENDPOINT, kunpoAudioModels, validateKunpoAudioInput } from "./kunpo-audio.js";

const PROVIDER_ID = "volcengine-seed-audio";
export const VOLCENGINE_SEED_AUDIO_MODELS: readonly AudioModel[] = kunpoAudioModels(PROVIDER_ID, DOUBAO_SEED_AUDIO_PROVIDER_NAME);

/** The stable local provider ID is retained; requests use only the injected Kunpo credential. */
export class VolcengineSeedAudioProvider implements AudioProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly name = DOUBAO_SEED_AUDIO_PROVIDER_NAME;

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly baseUrl = KUNPO_AUDIO_ENDPOINT,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  configured(): boolean { return Boolean(this.apiKey()); }
  enabled(): boolean { return this.isEnabled(); }
  models(): AudioModel[] { return VOLCENGINE_SEED_AUDIO_MODELS.map((model) => structuredClone(model)); }
  validate(input: AudioGenerationRequest): void { validateKunpoAudioInput(input, this.id); }

  async generate(input: AudioGenerationRequest, signal?: AbortSignal): Promise<GeneratedAudio> {
    if (!this.enabled()) throw new AudioGenerationError("Kunpo audio provider is disabled", 409);
    if (input.operation !== "sound-effect" && input.operation !== "music") throw new AudioGenerationError("This Kunpo audio provider supports sound effects and experimental ambient music only", 400);
    const key = this.apiKey();
    if (!key) throw new AudioGenerationError("Connect Kunpo before generating audio", 503);
    return generateKunpoAudio({ input, provider: this.id, key, request: this.request, endpoint: this.baseUrl, signal });
  }
}
