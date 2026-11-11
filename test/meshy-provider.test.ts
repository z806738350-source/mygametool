import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import type {
  Model3DAnimationInput,
  Model3DExecution,
  Model3DGenerationInput,
} from "../src/daemon/model3d.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const model = { provider: "meshy", id: "meshy-t2" };
const image = { mediaType: "image/png" as const, data: "c3ludGhldGlj" };
const source = Buffer.from("synthetic old source bytes");
const refusal = {
  statusCode: 403,
  notSubmitted: true,
  message:
    "Meshy is disabled in this edition. Select Kunpo Tripo for supported 3D models and animation. Existing local assets and task records are retained; Meshy requests and remote recovery are unavailable.",
};

type Call = (
  provider: MeshyProvider,
  execution?: Model3DExecution,
  signal?: AbortSignal,
) => Promise<unknown>;
const calls: Array<[string, Call]> = [
  [
    "image generation",
    (provider, execution, signal) =>
      provider.generate({ model, images: [image], execution }, signal),
  ],
  [
    "multi-view generation",
    (provider, execution, signal) =>
      provider.generate(
        {
          model: { ...model, id: "meshy-7.1" },
          images: [image, image],
          execution,
        },
        signal,
      ),
  ],
  [
    "text generation",
    (provider, execution, signal) =>
      provider.generate(
        {
          model,
          operation: "text",
          prompt: "Synthetic tower",
          images: [],
          execution,
        },
        signal,
      ),
  ],
  [
    "retexture",
    (provider, execution, signal) =>
      provider.generate(
        { model, operation: "retexture", source, images: [image], execution },
        signal,
      ),
  ],
  [
    "remesh",
    (provider, execution, signal) =>
      provider.generate(
        {
          model,
          operation: "remesh",
          source,
          targetPolycount: 8000,
          images: [],
          execution,
        },
        signal,
      ),
  ],
  [
    "rigging and animation",
    (provider, execution, signal) =>
      provider.animate({ model: source, actionIds: [0], execution }, signal),
  ],
  [
    "multi-batch animation",
    (provider, execution, signal) =>
      provider.animate(
        {
          model: source,
          actionIds: Array.from({ length: 30 }, (_, index) => index),
          execution,
        },
        signal,
      ),
  ],
  [
    "animation library",
    (provider, _execution, signal) => provider.animations(signal, model),
  ],
  [
    "balance",
    (provider, _execution, signal) => provider.balance(model, signal),
  ],
  [
    "account balance",
    (provider, _execution, signal) => provider.accountBalance(signal),
  ],
];

function fixture() {
  const apiKey = vi.fn(() => {
    throw new Error("Credential callback must not run");
  });
  const request = vi.fn<typeof fetch>(async () => {
    throw new Error("No request is allowed");
  });
  const enabled = vi.fn(() => true),
    configRead = vi.fn(() => {
      throw new Error("Disabled provider must not read a connection");
    });
  const connection = new Proxy(
    {
      baseUrl: "invalid-even-before-validation",
      authentication: "none" as const,
    },
    { get: configRead },
  );
  const provider = new MeshyProvider(apiKey, request, 0, enabled, connection);
  const submitted = vi.fn(async () => {
    throw new Error("Old task receipts must not be touched");
  });
  const result = vi.fn(async () => {
    throw new Error("Old result caches must not be read or rewritten");
  });
  const execution: Model3DExecution = { recoveryOnly: true, submitted, result };
  const untouched = () => {
    expect(apiKey).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(configRead).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  };
  return { provider, execution, untouched };
}

describe("Meshy is permanently disabled", () => {
  it.each(calls)(
    "rejects %s before credentials, connection validation, network or retained-task callbacks",
    async (_name, call) => {
      const f = fixture();
      await expect(call(f.provider, f.execution)).rejects.toMatchObject(
        refusal,
      );
      f.untouched();
    },
  );

  it.each(calls)(
    "does not let an aborted signal bypass the disabled contract for %s",
    async (_name, call) => {
      const f = fixture(),
        controller = new AbortController();
      controller.abort();
      await expect(
        call(f.provider, f.execution, controller.signal),
      ).rejects.toMatchObject(refusal);
      f.untouched();
    },
  );

  it("rejects malformed and accessor-backed inputs before validating or inspecting them", async () => {
    const f = fixture(),
      read = vi.fn(() => {
        throw new Error("Input must remain unread");
      });
    const input = new Proxy({}, { get: read });
    for (const value of [undefined, null, input]) {
      await expect(
        f.provider.generate(value as Model3DGenerationInput),
      ).rejects.toMatchObject(refusal);
      await expect(
        f.provider.animate(value as Model3DAnimationInput),
      ).rejects.toMatchObject(refusal);
    }
    expect(read).not.toHaveBeenCalled();
    f.untouched();
  });

  it("cannot be enabled through old constructor options, stored relay settings or environment flags", async () => {
    vi.stubEnv("MESHY_API_KEY", "synthetic-env-value");
    vi.stubEnv("OHMYGAME_ENABLE_MESHY", "1");
    const apiKey = vi.fn(() => "synthetic-unused-key"),
      request = vi.fn<typeof fetch>(),
      enabled = vi.fn(() => true);
    const settings = {
        baseUrl: "http://127.0.0.1:43199/openapi/v1",
        authentication: "none" as const,
        headers: { "x-fixture": "retained" },
      },
      before = JSON.stringify(settings);
    const provider = new MeshyProvider(apiKey, request, 0, enabled, settings);
    for (const [, call] of calls)
      await expect(call(provider)).rejects.toMatchObject(refusal);
    expect(apiKey).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(JSON.stringify(settings)).toBe(before);
  });

  it("leaves existing synthetic assets, raw results and journal files untouched", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-disabled-meshy-"),
    );
    directories.push(directory);
    const originals = {
      "existing.glb": source,
      "old-job.json": Buffer.from('{"rig":{"taskId":"synthetic-existing"}}'),
      "old-job.json.animation-result-a.result": Buffer.from(
        "saved original result",
      ),
    };
    for (const [name, bytes] of Object.entries(originals))
      await writeFile(path.join(directory, name), bytes, { mode: 0o600 });
    const f = fixture();
    for (const [, call] of calls)
      await expect(call(f.provider, f.execution)).rejects.toMatchObject(
        refusal,
      );
    expect((await readdir(directory)).sort()).toEqual(
      Object.keys(originals).sort(),
    );
    for (const [name, bytes] of Object.entries(originals))
      expect(await readFile(path.join(directory, name))).toEqual(bytes);
    f.untouched();
  });
});
