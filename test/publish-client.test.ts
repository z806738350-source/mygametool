import { describe, expect, it, vi } from "vitest";
import { RemotePublisher, LOCAL_PUBLISH_UNAVAILABLE } from "../src/daemon/publish/client.js";
import type { ProjectState } from "../src/shared/contracts.js";

// Product account publication/visitor success behavior is intentionally retired, not silently simulated.
describe("local edition publication boundary", () => {
  it("cannot use injected transports, old account tokens or visitor paths", async () => {
    const request = vi.fn();
    const publisher = new RemotePublisher({ apiUrl: "https://author.invalid", fetch: request, visitorTokenFile: "/must-not-read" });
    const key = "CANARY_PUBLISH_KEY";
    const operations = [
      () => publisher.community(), () => publisher.communityGame("game"), () => publisher.communityGameCover("game", "deployment"),
      () => publisher.profile("author"), () => publisher.myGames(key), () => publisher.setLike("game", key, true),
      () => publisher.publish({} as ProjectState, Buffer.from(key), key, { title: key }),
      () => publisher.updateCommunityGame("game", key, { title: key }), () => publisher.unpublish("game", key),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ statusCode: 410, message: LOCAL_PUBLISH_UNAVAILABLE });
    }
    expect(request).not.toHaveBeenCalled();
  });
});
