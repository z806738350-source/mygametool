import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initials, UserAvatar } from "../src/renderer/user-avatar.js";

describe("UserAvatar", () => {
  it("keeps a remote authenticated avatar from automatically contacting its host", () => {
    const html = renderToStaticMarkup(<UserAvatar className="avatar" name="Di Huang" avatarUrl="https://example.com/avatar.png" />);

    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com");
    expect(html).toContain(">DH</span>");
  });

  it("retains local avatar images without sending a referrer", () => {
    const html = renderToStaticMarkup(<UserAvatar className="avatar" name="Di Huang" avatarUrl="blob:local-avatar" />);
    expect(html).toContain('src="blob:local-avatar"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("falls back to name initials", () => {
    expect(initials("Di Huang")).toBe("DH");
    expect(initials(" ")).toBe("OG");
    expect(renderToStaticMarkup(<UserAvatar className="avatar" name="Di Huang" />)).toContain(">DH</span>");
  });
});
