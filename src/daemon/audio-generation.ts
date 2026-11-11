import type {
  AudioGenerationRequest,
  AudioGenerationInput,
  AudioModel,
  AudioModelCatalog,
  GeneratedAudio,
} from "../shared/audio.js";
import type { AudioRequestDiagnostic, ModelRef } from "../shared/contracts.js";
import { inheritToolPreflightFailure, toolPreflightError } from "./agent-tool-errors.js";

export class AudioGenerationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly submissionOutcome?: "unknown" | "not-submitted",
    readonly diagnostic?: AudioRequestDiagnostic,
  ) {
    super(message);
  }
}

/** Only pure, local argument validation may mint a correctable rejection. */
export function audioInputError(message: string): AudioGenerationError {
  const text = `${message}. Check list_media_capabilities and correct the arguments using a new call ID; no audio request was submitted.`;
  return inheritToolPreflightFailure(new AudioGenerationError(text, 400, "not-submitted"), toolPreflightError(text, "audio_input_invalid"));
}

export interface AudioProviderAdapter {
  readonly id: string;
  readonly name: string;
  configured(): boolean;
  enabled(): boolean;
  models(): AudioModel[];
  validate?(input: AudioGenerationRequest): void;
  generate(
    input: AudioGenerationInput,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
}

export interface AudioGenerator {
  catalog(): Promise<AudioModelCatalog> | AudioModelCatalog;
  validate?(input: AudioGenerationRequest): void;
  generate(
    input: AudioGenerationInput,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
}

export class ProviderAudio implements AudioGenerator {
  constructor(private readonly adapters: readonly AudioProviderAdapter[]) {}

  catalog(): AudioModelCatalog {
    const providers = this.adapters.map((adapter) => {
      const configured = adapter.configured();
      const enabled = adapter.enabled();
      return {
        provider: adapter.id,
        name: adapter.name,
        configured,
        state: !enabled
          ? ("disabled" as const)
          : configured
            ? ("ready" as const)
            : ("not_configured" as const),
        ...(!configured
          ? { message: `Connect ${adapter.name} before generating audio.` }
          : {}),
      };
    });
    return {
      models: this.adapters
        .filter((adapter) => adapter.configured() && adapter.enabled())
        .flatMap((adapter) => adapter.models()),
      providers,
    };
  }

  resolveModel(
    operation: AudioGenerationRequest["operation"],
    requested?: ModelRef,
  ): AudioModel | undefined {
    // There is no confirmed full-BGM default. Ambient music candidates require an explicit choice.
    if (operation === "music" && !requested) return undefined;
    const catalog = this.catalog().models.filter((model) =>
      model.capabilities.operations.includes(operation),
    );
    return requested
      ? catalog.find((model) => sameModel(model, requested))
      : catalog[0];
  }

  async generate(
    input: AudioGenerationInput,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    const model = this.resolveModel(input.operation, input.model);
    if (!model) throw this.selectionError(input.operation, input.model);
    if (input.operation === "speech" && input.voiceDesign && !model.capabilities.supportsVoiceDesign) throw new AudioGenerationError("The selected model does not support voice design", 400, "not-submitted");
    const adapter = this.adapters.find(
      (candidate) => candidate.id === model.provider,
    );
    if (!adapter)
      throw new AudioGenerationError(
        "The selected audio provider is unavailable",
        503,
      );
    return adapter.generate(
      { ...input, model: { provider: model.provider, id: model.id } },
      signal,
    );
  }

  validate(input: AudioGenerationRequest): void {
    const model = this.resolveModel(input.operation, input.model);
    // Project selections may still be resolved by ToolRunner.prepare().
    if (!model && !input.model) return;
    if (!model) throw this.selectionError(input.operation, input.model);
    if (input.operation === "speech" && input.voiceDesign && !model.capabilities.supportsVoiceDesign)
      throw audioInputError("The selected model does not support voice design");
    this.adapters.find(adapter => adapter.id === model.provider)?.validate?.({ ...input, model });
  }

  selectionError(operation: AudioGenerationRequest["operation"], requested?: ModelRef): AudioGenerationError {
    const name = operationName(operation);
    const candidates = this.catalog().models.filter((model) => model.capabilities.operations.includes(operation));
    if (!candidates.length) return new AudioGenerationError(`No ${name} model is available. No enabled, configured audio model supports this operation. Check list_media_capabilities or Project settings.`, 503, "not-submitted");
    const message = requested
      ? `The selected audio model is unavailable or does not support this operation. Check list_media_capabilities and choose an exact provider and id listed for ${name}.`
      : `Choose an explicit ${name} model from list_media_capabilities; this operation has no automatic model selection.`;
    // A disabled or disconnected selected provider is not an argument correction.
    const blocked = requested && this.adapters.some(adapter => adapter.id === requested.provider && (!adapter.enabled() || !adapter.configured()));
    return blocked ? new AudioGenerationError(message, 400, "not-submitted") : audioInputError(message);
  }
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function operationName(operation: AudioGenerationRequest["operation"]): string {
  if (operation === "sound-effect") return "sound effect";
  return operation;
}
