import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, localDebug, useAuth } from "../src/renderer/auth.js";

describe("local renderer access", () => {
  it("renders local projects without creating a signed-in identity", () => {
    expect(renderToStaticMarkup(createElement(AuthProvider, { children: "Local project" }))).toBe("Local project");
    expect(useAuth().state).toEqual({ status: "signed-out" });
    expect(localDebug).toBe(false);
  });

  it("never returns a cloud token or sends an authentication request", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    try {
      const auth = useAuth();
      auth.openSignIn();
      await expect(auth.requestAccessToken()).resolves.toBeUndefined();
      await auth.signOut();
      expect(auth.state).toEqual({ status: "signed-out" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
