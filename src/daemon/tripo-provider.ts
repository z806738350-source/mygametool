import { providerControlUrl, providerCredentialValues, fetchProviderArtifact, providerRequest, providerArtifactUrl } from "./provider-network.js";
import { setTimeout as delay } from "node:timers/promises";
import type { CustomModel3DSettings, Model3DBalance, Model3DOptions } from "../shared/contracts.js";
import { model3DPreset } from "../shared/model3d-presets.js";
import { remeshPolycount, tripoActions } from "../shared/model3d-operations.js";
import { MAX_ANIMATION_ACTIONS } from "../shared/generation-config.js";
import type { ImageSource } from "./image-adapters.js";
import { Model3DGenerationError, readModel3DResult, type Generated3DModel, type Model3DGenerationInput, type Model3DAnimationInput, type Model3DExecution, type Model3DGenerator } from "./model3d.js";
import { isKunpoImageSourceUrl, kunpoReferenceImageUrls } from "./provider-image-source.js";
import { FBX_MEDIA_TYPE, isFbxArtifact } from "./fbx-preview.js";
import { inheritToolPreflightFailure, toolPreflightError } from "./agent-tool-errors.js";

const BASE_URL = "https://llm.ziy.cc/tripo/v3";
const VIEW_NAMES = ["front", "left", "back", "right"] as const;
const TEXTURE_MODELS = ["v3.5-20260815", "v3.0-20250812", "v2.5-20250123"];
const RIG_MODELS = ["v1.0-20240301", "v2.5-20260210", "v3.0-20260909"];
const RIG_TYPES = ["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others"];
const DEFAULT_RIG = "v3.0-20260909";

export class TripoProvider implements Model3DGenerator {
  constructor(private readonly apiKey: () => string | undefined, private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = 2_000, private readonly isEnabled: () => boolean = () => true,
    private readonly connection?: ImageSource & { settings?: CustomModel3DSettings }) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal, settings?: CustomModel3DSettings): Promise<Generated3DModel> {
    const operation = input.operation ?? "image";
    const processingVersion = operation === "remesh" && input.model.id === "v3.0" || operation === "retexture" && TEXTURE_MODELS.includes(input.model.id);
    const model = settings ?? this.connection?.settings ?? model3DPreset(input.model.provider, input.model.id)?.settings
      ?? (input.model.provider === "tripo" && processingVersion ? model3DPreset("tripo", "v3.1-20260211")?.settings : undefined);
    if (!model || model.protocol !== "tripo") throw new Model3DGenerationError("The selected Tripo model is unavailable", 400);
    if (!["image", "text", "remesh", "retexture"].includes(operation)) throw new Model3DGenerationError("Unsupported Tripo operation", 400);
    const options = input.options;
    const allowed = operation === "remesh" ? ["quad", "smartUv"] : operation === "retexture" ? ["textureModel", "textureQuality"] : ["quad", "geometryQuality", "textureModel", "textureQuality"];
    if (options && Object.entries(options).some(([field, value]) => value !== undefined && !allowed.includes(field))) throw new Model3DGenerationError("These options are not supported by the selected Tripo operation", 400);
    const textureVersion = options?.textureModel ?? (operation === "retexture" && TEXTURE_MODELS.includes(input.model.id) ? input.model.id : "v3.5-20260815");
    if (!TEXTURE_MODELS.includes(textureVersion)) throw new Model3DGenerationError("Unsupported Tripo texture version", 400);
    if (options?.textureQuality !== undefined && !["fast", "standard", "detailed", "extreme"].includes(options.textureQuality)) throw new Model3DGenerationError("Unsupported Tripo texture quality", 400);
    if (options?.textureQuality === "fast" && textureVersion !== "v3.5-20260815") throw new Model3DGenerationError("Fast textures require Tripo v3.5", 400);
    if (options?.quad !== undefined && typeof options.quad !== "boolean" || options?.smartUv !== undefined && typeof options.smartUv !== "boolean") throw new Model3DGenerationError("Invalid Tripo mesh options", 400);
    if (options?.smartUv !== undefined && operation !== "remesh") throw new Model3DGenerationError("Smart UV is only available with Tripo v3.0 remeshing", 400);
    if (options?.geometryQuality !== undefined && !["standard", "detailed"].includes(options.geometryQuality)) throw new Model3DGenerationError("Unsupported Tripo geometry quality", 400);
    if (options?.geometryQuality !== undefined && !["v3.1-20260211", "v3.0-20250812"].includes(input.model.id)) throw new Model3DGenerationError("Geometry quality requires Tripo H v3", 400);
    if (operation !== "retexture" && input.model.id === "v2.5-20250123" && options?.textureQuality !== undefined) throw new Model3DGenerationError("Tripo H v2.5 does not support texture quality selection", 400);
    if (options?.quad && ["P1-20260311", "v2.5-20250123"].includes(input.model.id) && operation !== "remesh") throw new Model3DGenerationError("This Tripo geometry version does not support quad output", 400);
    if (operation === "image" && (!input.images.length || input.images.length > model.maxReferenceImages)) throw new Model3DGenerationError(`Provide 1 to ${model.maxReferenceImages} reference images`, 400);
    if (operation === "text" && (input.images.length || !input.prompt?.trim() || input.prompt.length > 1024)) throw new Model3DGenerationError("Tripo text generation needs a prompt up to 1024 characters", 400);
    if (operation === "retexture" && (input.images.length > 1 || input.images.length && input.prompt?.trim() || !input.images.length && !input.prompt?.trim())) throw new Model3DGenerationError("Choose one texture image or a prompt", 400);
    const polycount = operation === "remesh" ? remeshPolycount("tripo") : model.polycount;
    const maxFaces = options?.quad ? operation === "remesh" ? 10_000 : input.model.id === "P2-20260801" ? 25_000 : Math.min(polycount.max, 150_000)
      : options?.geometryQuality === "detailed" ? 2_000_000 : polycount.max;
    const faces = input.targetPolycount ?? polycount.default;
    if (operation !== "retexture" && (!Number.isInteger(faces) || faces < polycount.min || faces > maxFaces)) throw new Model3DGenerationError(`Tripo face count must be between ${polycount.min} and ${maxFaces}`, 400);
    const texture = input.texture ?? model.defaults?.texture ?? model.supportsTexture;
    const pbr = texture && (input.pbr ?? model.defaults?.pbr ?? false);
    if (texture && !model.supportsTexture || pbr && !model.supportsPbr) throw new Model3DGenerationError("The selected 3D model does not support these texture options", 400);
    if ((operation === "image" || operation === "text") && !texture && (options?.textureModel !== undefined || options?.textureQuality !== undefined)) throw new Model3DGenerationError("Enable textures before choosing a Tripo texture version or quality", 400);
    return this.session(signal, async (key, requestSignal) => {
      let endpoint: string, body: Record<string, unknown>;
      if (operation === "retexture" || operation === "remesh") {
        if (!input.source?.length) throw new Model3DGenerationError("Choose a source GLB", 400);
        assertGlb(input.source, "Source model must be GLB", 400);
        const source = await this.upload(input.source, "model/gltf-binary", "model.glb", key, requestSignal, input.execution, "source-upload");
        if (operation === "remesh") {
          endpoint = "mesh/decimate"; body = { input: source, model: "v3.0", face_limit: faces, quad: options?.quad ?? false, smart_uv: options?.smartUv ?? false, bake: true };
        } else {
          const version = textureVersion;
          const image = input.images[0];
          const token = image ? await this.imageUpload(image, key, requestSignal, input.execution, "texture-upload") : undefined;
          endpoint = "models/texture"; body = { input: source, model: version, pbr: input.pbr ?? false,
            texture_prompt: token ? { image: token } : { text: input.prompt }, texture_quality: input.options?.textureQuality ?? "standard" };
        }
      } else {
        const tokens: string[] = [];
        for (const [index, image] of input.images.entries()) tokens.push(await this.imageUpload(image, key, requestSignal, input.execution, `image-upload-${index}`));
        endpoint = `generation/${operation === "text" ? "text-to-model" : tokens.length === 1 ? "image-to-model" : "multiview-to-model"}`;
        body = { model: input.model.id, face_limit: faces, texture, pbr,
          ...(options?.quad !== undefined && !["P1-20260311", "v2.5-20250123"].includes(input.model.id) ? { quad: options.quad } : {}),
          ...(options?.geometryQuality !== undefined ? { geometry_quality: options.geometryQuality } : {}),
          ...(texture && (options?.textureModel || options?.textureQuality === "fast") ? { texture_version: textureVersion } : {}),
          ...(texture && options?.textureQuality ? { texture_quality: options.textureQuality } : {}),
          ...(operation === "text" ? { prompt: input.prompt } : tokens.length === 1 ? { input: tokens[0] } : { inputs: tokens.map((token, index) => ({ [VIEW_NAMES[index]!]: token })) }) };
      }
      const { taskId, task, cached } = await this.task(endpoint, body, key, requestSignal, input.execution, "generate");
      const actualModel = operation === "remesh" ? "v3.0" : operation === "retexture" ? textureVersion : input.model.id;
      const bytes = cached ?? (input.execution?.result ? await input.execution.result("generate", taskId, () => this.download(taskId, task, key, requestSignal)) : await this.download(taskId, task, key, requestSignal));
      const fbx = options?.quad === true && isFbxArtifact(bytes!);
      if (options?.quad && !fbx) throw new Model3DGenerationError("The quad task returned no FBX original. Its task and downloaded result are retained for recovery.");
      if (!fbx) assertGlb(bytes!, "Tripo returned a non-GLB artifact outside quad output. The original task is retained for recovery.");
      return { bytes: bytes!, mediaType: fbx ? FBX_MEDIA_TYPE : "model/gltf-binary", requestId: taskId,
        metadata: { ...(operation === "image" || operation === "text" ? { forwardAxis: "+X" as const } : {}),
          generation: { model: actualModel, protocol: "tripo-v3", parameters: publicParameters(body), taskId, taskIds: [taskId] } } };
    }, !input.execution?.recoveryOnly);
  }

  async animations(_signal?: AbortSignal, model?: unknown, options?: Model3DOptions) {
    const rigModel = selectedRig(model, options), rigType = options?.rigType ?? "biped";
    if (!RIG_MODELS.includes(rigModel) || !RIG_TYPES.includes(rigType)
      || rigModel === "v1.0-20240301" && rigType !== "biped"
      || rigModel === "v3.0-20260909" && !["biped", "others"].includes(rigType)) {
      const message = "Unsupported Tripo rig version or type; use v2.5 for non-human rigs. Check list_animation_actions and correct the inputs with a new call ID. No animation workflow was submitted.";
      throw inheritToolPreflightFailure(new Model3DGenerationError(message, 400, true), toolPreflightError(message, "invalid_animation_action"));
    }
    return tripoActions(rigModel, rigType);
  }

  async animate(input: Model3DAnimationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    const rigModel = selectedRig(input.providerModel, input.options), rigType = input.options?.rigType ?? "biped";
    const available = new Set((await this.animations(undefined, input.providerModel, input.options)).map((action) => action.id));
    if (!Array.isArray(input.actionIds) || !input.actionIds.length || input.actionIds.length > Math.min(5, MAX_ANIMATION_ACTIONS)
      || new Set(input.actionIds).size !== input.actionIds.length || input.actionIds.some((action) => typeof action !== "string" || !available.has(action))) throw new Model3DGenerationError("Choose 1 to 5 different actions from the selected Tripo rig's presets", 400);
    assertGlb(input.model, "Source model must be GLB", 400);
    return this.session(signal, async (key, requestSignal) => {
      const source = await this.upload(input.model, "model/gltf-binary", "model.glb", key, requestSignal, input.execution, "source-upload");
      const check = await this.task("animations/rig-check", { input: source, model: rigModel }, key, requestSignal, input.execution, "rig-check");
      const output = record(check.task.output);
      if (output.riggable === false) throw new Model3DGenerationError("Tripo rig-check reports that the source model is not riggable. Its existing check task is retained; rigging and animation were not submitted. Review the original source and task before authorizing a replacement workflow.", 400);
      if (output.riggable !== true) throw new Model3DGenerationError("Tripo rig-check did not return a confirmed riggable result. Its existing check task is retained; rigging and animation were not submitted. Review that task instead of changing rig types or submitting another workflow.", 502);
      if (output.rig_type !== rigType) {
        const reported = typeof output.rig_type === "string" && RIG_TYPES.includes(output.rig_type) ? output.rig_type : "unconfirmed";
        throw new Model3DGenerationError(`Tripo rig-check reported rig type ${reported}; the request selected ${rigType}. Its existing check task is retained; rigging and animation were not submitted. Review the source and task before authorizing a workflow with different settings.`, 400);
      }
      const rig = await this.task("animations/rig", { input: source, model: rigModel, rig_type: rigType, spec: "tripo", out_format: "glb" }, key, requestSignal, input.execution, "rig");
      const result = await this.task("animations/retarget", { input: rig.taskId, model: rigModel, animations: input.actionIds, out_format: "glb", export_with_geometry: true,
        animate_in_place: input.options?.animateInPlace ?? false }, key, requestSignal, input.execution, "animation");
      const bytes = await this.download(result.taskId, result.task, key, requestSignal);
      assertGlb(bytes, "Tripo returned a non-GLB animation artifact; the task is retained for recovery.");
      return { bytes, mediaType: "model/gltf-binary", requestId: result.taskId,
        metadata: { generation: { model: rigModel, protocol: "tripo-v3", parameters: { rig_type: rigType, spec: "tripo", out_format: "glb", animations: JSON.stringify(input.actionIds), animate_in_place: input.options?.animateInPlace ?? false },
          taskId: result.taskId, taskIds: [check.taskId, rig.taskId, result.taskId] } } };
    });
  }

  async accountBalance(signal?: AbortSignal): Promise<Model3DBalance> {
    if (this.kunpoConnection()) throw new Model3DGenerationError("Kunpo does not expose the upstream Tripo account balance API", 400);
    return this.session(signal, async (key, requestSignal) => {
      const value = await this.json("account/balance", { signal: requestSignal }, key);
      if (typeof value.balance !== "number") throw new Model3DGenerationError("Tripo returned an invalid balance");
      return { balance: value.balance, ...(typeof value.frozen === "number" ? { frozen: value.frozen } : {}) };
    });
  }

  private async session<T>(signal: AbortSignal | undefined, run: (key: string | undefined, signal: AbortSignal) => Promise<T>, preflight = true): Promise<T> {
    const control = providerControlUrl(this.connection?.baseUrl ?? BASE_URL, true);
    if (!this.isEnabled()) throw new Model3DGenerationError("Tripo provider is disabled", 409);
    const key = this.apiKey();
    if (!key && this.connection?.authentication !== "none") throw new Model3DGenerationError("Tripo API key is not configured", 503);
    const timeout = AbortSignal.timeout(60 * 60_000), combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      if (preflight && control.hostname === "llm.ziy.cc") {
        try { await providerArtifactUrl(`${control.origin}/`, control.href, undefined, combined); }
        catch { throw new Model3DGenerationError("3D download address could not be verified safely. No model request was submitted; check llm.ziy.cc artifact DNS before generating.", 503); }
      }
      return await run(key, combined);
    }
    catch (cause) { if (timeout.aborted && !signal?.aborted) throw new Model3DGenerationError("Tripo operation timed out; retry to resume the submitted task", 504); throw cause; }
  }
  private scope(key?: string) { return JSON.stringify([this.connection?.baseUrl ?? BASE_URL, key, this.connection?.headers, this.connection?.authentication]); }
  private async imageUpload(image: Model3DGenerationInput["images"][number], key: string | undefined, signal: AbortSignal, execution: Model3DExecution | undefined, stage: string) {
    const bytes = Buffer.from(image.data, "base64");
    if (!["image/png", "image/jpeg"].includes(image.mediaType) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw new Model3DGenerationError("Tripo references must be PNG or JPEG images up to 20 MB", 400);
    return this.upload(bytes, image.mediaType, image.mediaType === "image/png" ? "reference.png" : "reference.jpg", key, signal, execution, stage, image);
  }
  private async upload(bytes: Buffer, mediaType: string, name: string, key: string | undefined, signal: AbortSignal, execution: Model3DExecution | undefined, stage: string, image?: Model3DGenerationInput["images"][number]) {
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Model3DGenerationError("Tripo file uploads must be between 1 byte and 64 MiB", 413);
    const submit = async () => {
      if (image) {
        let url: string | undefined;
        try { [url] = await kunpoReferenceImageUrls([image], this.connection?.baseUrl ?? BASE_URL, providerCredentialValues(key, this.connection?.headers), signal); }
        catch { throw new Model3DGenerationError("3D reference preparation cancelled before upload or task submission", 499, true); }
        // Keep the existing private journal stage/fingerprint. Recovery reuses its original URL or upload token.
        if (url && url.length <= 4096) return { token: url };
      }
      const form = new FormData(); form.set("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
      const uploaded = await this.json("files", { method: "POST", body: form, signal }, key);
      if (typeof uploaded.file_token !== "string" || !uploaded.file_token) throw new Model3DGenerationError("Tripo returned no upload token");
      return { token: uploaded.file_token };
    };
    const result = execution ? await execution.submitted(stage, this.scope(key), { bytes: bytes.toString("base64"), mediaType }, submit) : await submit();
    if (typeof result.token !== "string" || result.token.includes("://") && !isKunpoImageSourceUrl(result.token, this.connection?.baseUrl ?? BASE_URL, providerCredentialValues(key, this.connection?.headers))) throw new Model3DGenerationError("The saved image reference could not be verified safely; no new task was submitted", 409);
    return result.token;
  }
  private async task(endpoint: string, body: Record<string, unknown>, key: string | undefined, signal: AbortSignal, execution?: Model3DExecution, stage = endpoint) {
    const submit = async () => {
      const value = await this.json(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }, key);
      if (typeof value.task_id !== "string" || !value.task_id) throw new Model3DGenerationError("Tripo returned no task ID");
      return { taskId: value.task_id };
    };
    const { taskId } = execution ? await execution.submitted(stage, this.scope(key), { endpoint, body }, submit) : await submit();
    const cached = stage === "generate" ? await execution?.result?.(stage, taskId) : undefined;
    if (cached) return { taskId, task: {} as Record<string, unknown>, cached };
    let failures = 0;
    while (true) {
      signal.throwIfAborted();
      let task: Record<string, unknown>;
      try { task = await this.json(`tasks/${encodeURIComponent(taskId)}`, { signal }, key); failures = 0; }
      catch (cause) { if (!(cause instanceof Model3DGenerationError) || ![429, 502, 504].includes(cause.statusCode) || ++failures >= 3) throw cause; await delay(this.pollIntervalMs, undefined, { signal }); continue; }
      if (task.status === "success") return { taskId, task };
      if (["failed", "cancelled", "canceled"].includes(String(task.status))) throw new Model3DGenerationError("Tripo task failed", 400);
      // The contract treats unlisted states as non-terminal; the session timeout
      // and cancellation still bound waiting without replaying a paid POST.
      await delay(this.pollIntervalMs, undefined, { signal });
    }
  }
  private kunpoConnection() {
    const base = new URL(this.connection?.baseUrl ?? BASE_URL);
    return base.hostname === "llm.ziy.cc" || base.pathname.replace(/\/+$/, "") === "/tripo/v3";
  }
  private async download(taskId: string, task: Record<string, unknown>, key: string | undefined, signal: AbortSignal) {
    let url = record(task.output).model_url;
    if (this.kunpoConnection()) {
      const target = new URL(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, this.connection?.baseUrl ?? BASE_URL);
      const response = await providerRequest(this.request, target, { signal, headers: { ...(this.connection?.authentication === "none" ? {} : { authorization: `Bearer ${key}` }) } });
      if (!response.ok) throw new Model3DGenerationError(`Tripo artifact query failed (${response.status}); resume the existing task`);
      const body = record(await response.json().catch(() => undefined));
      const artifact = Array.isArray(body.artifacts) ? body.artifacts.map(record).find((item) => item.key === "model") : undefined;
      url = artifact?.content_url;
    }
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Model3DGenerationError("Tripo completed without a GLB artifact");
    const response = await fetchProviderArtifact(this.request, url, this.connection?.baseUrl ?? BASE_URL, { signal,
      ...(this.connection?.authentication === "none" ? {} : { apiKey: key }), protectedSecrets: providerCredentialValues(key, this.connection?.headers) });
    if (!response.ok) throw new Model3DGenerationError(`Tripo GLB download failed (${response.status})`);
    const bytes = await readModel3DResult(response, signal);
    return bytes;
  }
  private async json(endpoint: string, init: RequestInit, key?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await providerRequest(this.request, `${(this.connection?.baseUrl ?? BASE_URL).replace(/\/+$/, "")}/${endpoint}`, { ...init,
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]),
      headers: { ...this.connection?.headers, ...(this.connection?.authentication === "none" ? {} : { authorization: `Bearer ${key}` }), ...init.headers } }); }
    catch (cause) { if (init.signal?.aborted) throw init.signal.reason ?? cause; throw new TripoNetworkError("Could not reach Tripo"); }
    const body = record(await response.json().catch(() => undefined));
    if (response.ok && body.code === 0 && body.data && typeof body.data === "object") return record(body.data);
    if (response.status === 401 || body.code === 1000 || body.code === 1001) throw new Model3DGenerationError("Tripo API key was rejected", 503);
    if (response.status === 429 || body.code === 2000) throw new Model3DGenerationError("Tripo is temporarily rate limited", 429);
    throw new Model3DGenerationError("Tripo request failed", response.status >= 500 || response.ok ? 502 : 400);
  }
}
class TripoNetworkError extends Model3DGenerationError { constructor(message: string) { super(message, 502); } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function assertGlb(bytes: Buffer, message: string, statusCode = 502) {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Model3DGenerationError(message, statusCode);
}
function publicParameters(body: Record<string, unknown>): Record<string, string | number | boolean> {
  const fields = ["face_limit", "quad", "smart_uv", "bake", "texture", "pbr", "texture_version", "texture_quality", "geometry_quality"];
  return Object.fromEntries(fields.filter((field) => ["string", "number", "boolean"].includes(typeof body[field])).map((field) => [field, body[field] as string | number | boolean]));
}
function selectedRig(model: unknown, options?: Model3DOptions) {
  const id = record(model).id;
  return options?.rigModel ?? (typeof id === "string" && RIG_MODELS.includes(id) ? id : DEFAULT_RIG);
}
