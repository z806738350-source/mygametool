// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/composer.js";
import { composerDrafts } from "../src/renderer/composer-drafts.js";
import * as api from "../src/renderer/api.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  composerDrafts.deleteProject("publish-test");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composer text-only model", () => {
  const model = { provider: "kunpo", id: "gpt-6.1-sol" };

  it.each(["image/png", ""])("retains an image draft and refuses button and form submission (%s)", async (type) => {
    vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:mock"; } static revokeObjectURL() {} });
    const upload = vi.spyOn(api, "uploadProjectAttachment");
    const file = new File(["image"], "screenshot.png", { type });
    const session = composerDrafts.get({ projectId: "publish-test", conversationId: "chat" });
    session.update({ prompt: "Inspect this screenshot", attachments: [{ id: "shot", file, relativePath: file.name }] });
    const props = await render({ model });
    expect(container.querySelector<HTMLButtonElement>(".send-button")!.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cannot receive images");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(upload).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ prompt: "Inspect this screenshot", attachments: [{ id: "shot" }] });
  });

  it("keeps captured playable context until a vision model is selected", async () => {
    const props = await render({ model, initialDraft: { prompt: "Inspect this element", mentions: [] }, contexts: [{ key: "pick", kind: "playable-element", label: "Button" }] });
    expect(container.querySelector<HTMLButtonElement>(".send-button")!.disabled).toBe(true);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")!.value).toBe("Inspect this element");
    await render({ ...props, model: { provider: "kunpo", id: "gpt-5.6-sol" } });
    expect(container.querySelector<HTMLButtonElement>(".send-button")!.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("still sends text attachments and ordinary node context", async () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    const attachment = { id: "notes", batchId: "batch", name: file.name, relativePath: file.name, size: file.size, kind: "text" as const, mediaType: file.type };
    vi.spyOn(api, "uploadProjectAttachment").mockResolvedValue(attachment);
    composerDrafts.get({ projectId: "publish-test", conversationId: "chat" }).update({ prompt: "Read these notes", attachments: [{ id: "notes", file, relativePath: file.name }] });
    const props = await render({ model, contexts: [{ key: "node", kind: "playable-node", label: "Game" }] });
    expect(container.querySelector<HTMLButtonElement>(".send-button")!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".send-button")!.click());
    expect(props.onSubmit).toHaveBeenCalledWith("Read these notes", [], [], "normal", [attachment], [], []);
  });
});

async function render(
  overrides: Partial<ComponentProps<typeof Composer>> = {},
) {
  const props: ComponentProps<typeof Composer> = {
    projectId: "publish-test",
    conversationId: "chat",
    conversationReady: true,
    running: false,
    stopping: false,
    pendingPrompts: [],
    planMode: "normal",
    models: [],
    modelStatus: "ready",
    modelChanging: false,
    promptHistory: [],
    capabilities: { plugins: [], skills: [] },
    initialDraft: { prompt: "/publish", mentions: [] },
    onSubmit: vi.fn(async () => true),
    onCompact: vi.fn(async () => {}),
    onContextUsage: vi.fn(async () => undefined),
    onCancelPlan: vi.fn(async () => true),
    onModelChange: vi.fn(),
    onReasoningChange: vi.fn(),
    onStop: vi.fn(),
    onRemovePending: vi.fn(async () => true),
    onSteerPending: vi.fn(async () => true),
    onEditPending: vi.fn(async () => true),
    ...overrides,
  };
  await act(async () => root.render(<Composer {...props} />));
  return props;
}

describe("composer publish command", () => {
  it("keeps the retired publish command local without sending a paid chat turn", async () => {
    const props = await render({ initialDraft: { prompt: "/PUBLISH", mentions: [] } });
    expect(container.querySelector('[role="option"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cloud publishing");
    expect(container.querySelector<HTMLButtonElement>(".send-button")!.disabled).toBe(true);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("preserves ordinary messages that mention publishing", async () => {
    const props = await render({
      initialDraft: { prompt: "Explain /publish", mentions: [] },
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".send-button")!.click(),
    );
    expect(props.onSubmit).toHaveBeenCalledWith(
      "Explain /publish",
      [],
      [],
      "normal",
      [],
      [],
      [],
    );
  });
});
