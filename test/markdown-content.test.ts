import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isLocalImageSource } from "../src/renderer/local-resources.js";
import { MarkdownContent, workspaceFileIconKind, workspaceLinkPath } from "../src/renderer/markdown-content.js";

describe("workspaceLinkPath", () => {
  it("resolves relative project links and removes line fragments", () => {
    expect(workspaceLinkPath("src/app.ts#L10", "/tmp/game")).toBe("src/app.ts");
    expect(workspaceLinkPath("./README.md?plain=1", "/tmp/game")).toBe("README.md");
  });

  it("resolves absolute paths only when they belong to the project", () => {
    expect(workspaceLinkPath("/tmp/game/src/app.ts:12", "/tmp/game")).toBe("src/app.ts");
    expect(workspaceLinkPath("file:///tmp/game/src/app.ts", "/tmp/game")).toBe("src/app.ts");
    expect(workspaceLinkPath("/tmp/other/secret.txt", "/tmp/game")).toBeUndefined();
  });

  it("leaves web URLs and traversal attempts outside workspace navigation", () => {
    expect(workspaceLinkPath("https://example.com/src/app.ts", "/tmp/game")).toBeUndefined();
    expect(workspaceLinkPath("../secret.txt", "/tmp/game")).toBeUndefined();
    expect(workspaceLinkPath("docs", "/tmp/game")).toBeUndefined();
    expect(workspaceLinkPath("example.com", "/tmp/game")).toBeUndefined();
  });

  it("resolves links relative to the Markdown file's folder without leaving the project", () => {
    expect(workspaceLinkPath("api.md", "/tmp/game", "docs")).toBe("docs/api.md");
    expect(workspaceLinkPath("../README.md", "/tmp/game", "docs/guide")).toBe("docs/README.md");
    expect(workspaceLinkPath("../../src/app.ts", "/tmp/game", "docs/guide")).toBe("src/app.ts");
    expect(workspaceLinkPath("../../secret.txt", "/tmp/game", "docs")).toBeUndefined();
    expect(workspaceLinkPath("/tmp/game/src/app.ts", "/tmp/game", "docs")).toBe("src/app.ts");
    expect(workspaceLinkPath("logo.png", undefined, "docs/img")).toBe("docs/img/logo.png");
    expect(workspaceLinkPath("docs/../README.md", undefined, "")).toBe("README.md");
    expect(workspaceLinkPath("../secret.txt", undefined, "")).toBeUndefined();
    expect(workspaceLinkPath("%2e%2e/%2e%2e/secret.txt", undefined, "docs")).toBeUndefined();
  });
});

describe("workspace file link icons", () => {
  it("classifies common project files by extension", () => {
    expect(workspaceFileIconKind("src/game.tsx")).toBe("code");
    expect(workspaceFileIconKind("README.md")).toBe("text");
    expect(workspaceFileIconKind("assets/cover.PNG")).toBe("image");
    expect(workspaceFileIconKind("assets/intro.mp4")).toBe("video");
    expect(workspaceFileIconKind("assets/theme.ogg")).toBe("audio");
    expect(workspaceFileIconKind("assets/ship.glb")).toBe("model");
    expect(workspaceFileIconKind("game.data")).toBe("file");
  });

  it("adds an icon only to links routed to Code", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      text: "[Game](src/game.ts) [Site](https://example.com)",
      workspacePath: "/tmp/game",
      onOpenWorkspaceFile: () => undefined,
    }));

    expect(html).toContain('class="workspace-file-link"');
    expect(html).toContain('data-file-kind="code"');
    expect(html.match(/workspace-file-link/g)).toHaveLength(1);
  });
});

describe("local Markdown images", () => {
  it("blocks tracking images while retaining local image paths", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      text: "![private project](https://tracker.example/pixel?prompt=secret) ![local](assets/cover.png)",
    }));
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("prompt=secret");
    expect(html).toContain('src="assets/cover.png"');
  });

  it("rejects remote and ambiguous sources before a custom image renderer runs", () => {
    for (const src of ["https://tracker.example/a.png", "//tracker.example/a.png", " http://127.0.0.1:9999/private ", "\\\\tracker.example\\image.png", "javascript:alert(1)", " "]) expect(isLocalImageSource(src)).toBe(false);
    for (const src of ["assets/cover.png", "/assets/cover.png", "blob:local-image", "data:image/png;base64,AAAA"]) expect(isLocalImageSource(src)).toBe(true);
    let rendered = false;
    renderToStaticMarkup(createElement(MarkdownContent, {
      text: "![remote](https://tracker.example/a.png)",
      renderImage: () => { rendered = true; return null; },
    }));
    expect(rendered).toBe(false);
  });
});
