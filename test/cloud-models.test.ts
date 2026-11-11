import { describe, expect, it, vi } from "vitest";
import { CloudModelsClient, LOCAL_CLOUD_UNAVAILABLE } from "../src/daemon/cloud-models.js";
import type { Model3DGenerationInput } from "../src/daemon/model3d.js";

// Former private-account success contracts are retired. These checks guard the local edition's fail-closed boundary.
describe("local edition cloud boundary", () => {
  it("ignores legacy URLs, environment and transports without retaining a session", async () => {
    const request = vi.fn();
    const cloud = new CloudModelsClient("https://author.invalid", request);
    await cloud.refresh(true);
    await cloud.setSession(null);
    expect(cloud.catalogSnapshot()).toEqual({ providers: [], models: [] });
    expect(await cloud.catalog()).toEqual({ providers: [], models: [] });
    expect(cloud.providersSnapshot(() => true)).toEqual([]);
    expect(cloud.hasProvider("cloud-hyper3d")).toBe(false);
    expect(cloud.connection("cloud-hyper3d").availability).toBe("unavailable");
    await expect(cloud.setSession({ accessToken: "CANARY_CLOUD_KEY", userId: "local" })).rejects.toMatchObject({ statusCode: 410, message: LOCAL_CLOUD_UNAVAILABLE });
    for (const operation of [() => cloud.quotas(), () => cloud.jobs(), () => cloud.result("private"), () => cloud.generate({} as Model3DGenerationInput)]) {
      await expect(operation()).rejects.toMatchObject({ statusCode: 410 });
    }
    expect(request).not.toHaveBeenCalled();
  });
});
