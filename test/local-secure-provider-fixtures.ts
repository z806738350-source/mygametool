import { OpenAIImageGenerator as OpenAI } from "../src/daemon/openai-image.js";
import { SeedreamProvider as Seedream } from "../src/daemon/seedream-provider.js";
import { SeedanceProvider as Seedance } from "../src/daemon/seedance-provider.js";
import { MinimaxProvider as Minimax } from "../src/daemon/minimax-provider.js";
import { MeshyProvider as Meshy } from "../src/daemon/meshy-provider.js";
import { TripoProvider as Tripo } from "../src/daemon/tripo-provider.js";
import { Hyper3DProvider as Hyper3D } from "../src/daemon/hyper3d-provider.js";
import { VolcengineTtsProvider as Tts } from "../src/daemon/volcengine-tts-provider.js";
import { VolcengineSeedAudioProvider as Audio } from "../src/daemon/volcengine-seed-audio-provider.js";
export { ImageGenerationError } from "../src/daemon/openai-image.js";
const fixtureTransport: typeof fetch = async () => { throw new Error("Protocol fixture requires an injected fake transport"); };

function localArtifacts(request: typeof fetch, baseUrl: string): typeof fetch {
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { return request; }
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string" && /^(?:https:\/\/8\.8\.8\.8|http:\/\/127\.0\.0\.1:43199)\//.test(value)) {
      const target = new URL(value); return `${origin}${target.pathname}${target.search}`;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  return async (input, init) => {
    const response = await request(input, init);
    const value: unknown = await response.clone().json().catch(() => undefined);
    return value === undefined ? response : Response.json(rewrite(value), { status: response.status, headers: response.headers });
  };
}

// Protocol fixtures explicitly select a local transport; original vendor defaults stay denied.
export class OpenAIImageGenerator extends OpenAI {
  constructor(...args: ConstructorParameters<typeof OpenAI>) { args[1] ??= "http://127.0.0.1:43199/v1"; args[2] = localArtifacts(args[2] ?? fixtureTransport, args[1]); super(...args); }
}
export class SeedreamProvider extends Seedream {
  constructor(...args: ConstructorParameters<typeof Seedream>) { args[2] ??= "http://127.0.0.1:43199/api/v3"; args[1] = localArtifacts(args[1] ?? fixtureTransport, args[2]); super(...args); }
}
export class SeedanceProvider extends Seedance {
  constructor(...args: ConstructorParameters<typeof Seedance>) {
    args[5] ??= { name: args[0] === "volcengine-ark" ? "Volcengine Ark" : "BytePlus ModelArk", baseUrl: `http://127.0.0.1:${args[0] === "volcengine-ark" ? 43199 : 43200}/api/v3` };
    args[2] = localArtifacts(args[2] ?? fixtureTransport, args[5].baseUrl);
    super(...args);
  }
}
export class MinimaxProvider extends Minimax {
  constructor(...args: ConstructorParameters<typeof Minimax>) {
    args[5] ??= { name: args[0] === "minimax-video-cn" ? "MiniMax China" : "MiniMax Global", baseUrl: `http://127.0.0.1:${args[0] === "minimax-video-cn" ? 43199 : 43200}` };
    args[2] = localArtifacts(args[2] ?? fixtureTransport, args[5].baseUrl);
    super(...args);
  }
}
export class MeshyProvider extends Meshy {
  constructor(...args: ConstructorParameters<typeof Meshy>) { args[4] ??= { baseUrl: "http://127.0.0.1:43199/openapi/v1" }; args[1] = localArtifacts(args[1] ?? fixtureTransport, args[4].baseUrl); super(...args); }
}
export class TripoProvider extends Tripo {
  constructor(...args: ConstructorParameters<typeof Tripo>) { args[4] ??= { baseUrl: "http://127.0.0.1:43199/v3", apiKey: "fixture-key" }; args[1] = localArtifacts(args[1] ?? fixtureTransport, args[4].baseUrl); super(...args); }
}
export class Hyper3DProvider extends Hyper3D {
  constructor(...args: ConstructorParameters<typeof Hyper3D>) { args[4] ??= { baseUrl: "http://127.0.0.1:43199/api/v2", apiKey: "fixture-key" }; args[1] = localArtifacts(args[1] ?? fixtureTransport, args[4].baseUrl); super(...args); }
}
export class VolcengineTtsProvider extends Tts {
  constructor(...args: ConstructorParameters<typeof Tts>) { args[2] ??= "http://127.0.0.1:43199/api/v3/tts/unidirectional"; args[1] = localArtifacts(args[1] ?? fixtureTransport, args[2]); super(...args); }
}
export class VolcengineSeedAudioProvider extends Audio {
  constructor(...args: ConstructorParameters<typeof Audio>) { args[2] ??= "http://127.0.0.1:43199/api/v3/tts/create"; args[1] = localArtifacts(args[1] ?? fixtureTransport, args[2]); super(...args); }
}
