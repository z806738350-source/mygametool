import type {
  Generated3DModel,
  Model3DAnimationAction,
  Model3DAnimationInput,
  Model3DGenerationInput,
  Model3DGenerator,
} from "./model3d.js";
import { Model3DGenerationError } from "./model3d.js";
import { MESHY_DISABLED_MESSAGE } from "../shared/disabled-media-providers.js";
import type {
  CustomModel3DSettings,
  Model3DBalance,
  Model3DModelRef,
  Model3DOptions,
} from "../shared/contracts.js";

function disabled(): never {
  throw new Model3DGenerationError(MESHY_DISABLED_MESSAGE, 403, true);
}

/** Retain old constructor/config compatibility without a network or credential path. */
export class MeshyProvider implements Model3DGenerator {
  constructor(
    _apiKey: () => string | undefined,
    _request?: typeof fetch,
    _pollIntervalMs = 2_000,
    _isEnabled: () => boolean = () => true,
    _connection?: {
      baseUrl: string;
      headers?: Record<string, string>;
      authentication?: "api_key" | "none";
      settings?: CustomModel3DSettings;
    },
  ) {}

  async generate(
    _input: Model3DGenerationInput,
    _signal?: AbortSignal,
    _settings?: CustomModel3DSettings,
  ): Promise<Generated3DModel> {
    return disabled();
  }

  async animate(
    _input: Model3DAnimationInput,
    _signal?: AbortSignal,
  ): Promise<Generated3DModel> {
    return disabled();
  }

  async animations(
    _signal?: AbortSignal,
    _model?: Model3DModelRef,
    _options?: Model3DOptions,
  ): Promise<Model3DAnimationAction[]> {
    return disabled();
  }

  async balance(
    _model: Model3DModelRef,
    _signal?: AbortSignal,
  ): Promise<Model3DBalance> {
    return disabled();
  }

  async accountBalance(_signal?: AbortSignal): Promise<Model3DBalance> {
    return disabled();
  }
}
