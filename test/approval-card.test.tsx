// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApprovalCard,
  approvalOutcomeLabel,
} from "../src/renderer/approval-card.js";
import { projectTurnDisplay } from "../src/renderer/turn-display.js";
import * as api from "../src/renderer/api.js";
import i18next from "i18next";
import type { ThreadItem } from "../src/shared/contracts.js";
import type { ApprovalDecision } from "../src/shared/agent-runtimes.js";
import { validSourceConfirmation, type IsolatedSourceReview } from "../src/shared/execution-storage.js";
import { isVolumeMigrationReview, validVolumeMigrationConfirmation, validVolumeMigrationReview, type VolumeMigrationReview } from "../src/shared/volume-migration.js";
import { volumeMigrationReview, volumeMigrationConfirmation } from "./volume-migration-fixture.js";

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request: Extract<ThreadItem, { type: "approvalRequest" }> = {
  id: "turn-1:approval:call-1",
  turnId: "turn-1",
  type: "approvalRequest",
  requestId: "call-1",
  request: {
    kind: "command",
    tool: "Bash",
    command: "git push origin main",
    reason: "Publishes the branch",
    canAllowSession: true,
  },
  status: "inProgress",
};

function viewReview(reviewId: string): typeof request {
  const angles = ["front", "left", "back"] as const;
  return { ...request, request: { kind: "turnaroundReview", tool: "generate_3d_from_views", canAllowSession: false,
    turnaroundReview: { reviewId, views: angles.map(angle => ({ angle, path: angle + ".png", url: reviewId + "/" + angle })) } } };
}

it("displays each review image, enlarges it and only approves the loaded set once", async () => {
  const first = viewReview("first"), revised = viewReview("revised"), decide = vi.fn(async () => true);
  const fetch = vi.spyOn(api, "getConversationImage").mockResolvedValue(new Blob(["image"]));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:review-" + crypto.randomUUID());
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const render = (item: typeof request) => act(async () => root.render(<ApprovalCard request={item} onDecide={decide} waiting={0} />));
  const approve = () => [...container.querySelectorAll("button")].find(item => item.textContent === "Approve and generate")!;
  const images = () => [...container.querySelectorAll<HTMLImageElement>(".turnaround-review-grid img")];
  await render(first);
  expect(approve().disabled).toBe(true);
  expect(images().map(image => image.alt)).toEqual(["Front", "Left side", "Back"]);
  expect(fetch.mock.calls.map(call => call[0])).toEqual(["first/front", "first/left", "first/back"]);
  await act(async () => images().slice(0, 2).forEach(image => image.dispatchEvent(new Event("load"))));
  expect(approve().disabled).toBe(true);
  await act(async () => images()[2].dispatchEvent(new Event("load")));
  expect(approve().disabled).toBe(false);
  await act(async () => images()[1].closest("button")!.click());
  expect(container.querySelector("dialog img")?.getAttribute("src")).toBe(images()[1].src);
  await render(revised);
  expect(revoke).toHaveBeenCalledTimes(3);
  expect(container.querySelector("dialog")).toBeNull();
  expect(approve().disabled).toBe(true);
  await act(async () => images().forEach(image => image.dispatchEvent(new Event("load"))));
  await act(async () => { approve().click(); approve().click(); });
  expect(decide).toHaveBeenCalledExactlyOnceWith("allow");
});

it("keeps a failed view review closed to generation and lets the user request changes", async () => {
  const pending = viewReview("failed"), decide = vi.fn(async () => true);
  vi.spyOn(api, "getConversationImage").mockRejectedValue(new Error("unavailable"));
  await act(async () => root.render(<ApprovalCard request={pending} waiting={0} onDecide={decide} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be displayed");
  expect([...container.querySelectorAll("button")].find(item => item.textContent === "Approve and generate")?.disabled).toBe(true);
  await act(async () => [...container.querySelectorAll("button")].find(item => item.textContent === "Request changes")!.click());
  expect(decide).toHaveBeenCalledExactlyOnceWith("deny");
  expect(approvalOutcomeLabel({ ...pending, status: "completed", decision: "deny" })).toBe("Changes requested to the reference views");
});

it("enables initial model approval after its pinned rotatable preview loads", async () => {
  if (!customElements.get("model-viewer")) customElements.define("model-viewer", class extends HTMLElement {});
  const decide = vi.fn(async (_decision: ApprovalDecision) => true);
  const fetchModel = vi.spyOn(api, "getLibraryAsset").mockResolvedValue(new Blob(["preview"]));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:tripo-model");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const model = { reviewId: "initial", assetId: "asset", name: "character.fbx", fbx: true, previewSha256: "a".repeat(64) };
  const pending = { ...request, request: { kind: "tripoModelReview" as const, tool: "review_tripo_model", canAllowSession: false, tripoModelReview: model } };
  const render = (item: typeof request) => act(async () => root.render(<ApprovalCard request={item} onDecide={decide} waiting={0} />));
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
  await render(pending);
  expect(fetchModel).toHaveBeenCalledWith(model.assetId, true, expect.any(AbortSignal), model.previewSha256);
  expect(button("Approve model").disabled).toBe(true);
  const viewer = container.querySelector("model-viewer")!;
  expect(viewer.hasAttribute("camera-controls")).toBe(true);
  await act(async () => viewer.dispatchEvent(new Event("load")));
  expect(button("Approve model").disabled).toBe(false);
  await act(async () => { button("Approve model").click(); button("Approve model").click(); });
  expect(decide).toHaveBeenCalledExactlyOnceWith("allow");

  const revised = { ...pending, requestId: "revised", request: { ...pending.request, tripoModelReview: { ...model, reviewId: "revised" } } };
  fetchModel.mockRejectedValueOnce(new Error("missing preview"));
  await render(revised);
  expect(revoke).toHaveBeenCalledWith("blob:tripo-model");
  expect(button("Approve model").disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be displayed");
  await act(async () => button("Request changes").click());
  expect(decide.mock.calls.map(call => call[0])).toEqual(["allow", "deny"]);
  expect(approvalOutcomeLabel({ ...revised, status: "completed", decision: "deny" })).toBe("Changes requested to the initial Tripo model");
});

it("compares a view with the source concept and waits for both to display", async () => {
  const pending = viewReview("compared");
  pending.request.turnaroundReview!.original = { path: "concept.png", url: "original" };
  vi.spyOn(api, "getConversationImage").mockResolvedValue(new Blob(["image"]));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:review-" + crypto.randomUUID());
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await act(async () => root.render(<ApprovalCard request={pending} waiting={0} onDecide={vi.fn()} />));
  const images = [...container.querySelectorAll<HTMLImageElement>(".turnaround-review-grid img")];
  const approve = [...container.querySelectorAll("button")].find(button => button.textContent === "Approve and generate")!;
  expect(images.map(image => image.alt)).toEqual(["Original concept", "Front", "Left side", "Back"]);
  expect(container.textContent).toContain("For visual comparison only.");
  await act(async () => images.slice(1).forEach(image => image.dispatchEvent(new Event("load"))));
  expect(approve.disabled).toBe(true);
  await act(async () => images[0].dispatchEvent(new Event("load")));
  expect(approve.disabled).toBe(false);
  await act(async () => images[2].closest("button")!.click());
  expect([...container.querySelectorAll<HTMLImageElement>("dialog img")].map(image => image.src))
    .toEqual([images[0].src, images[2].src]);
});

it.each([false, true])("volume migration requires exact one-time native confirmation; creates first volume=%s", async create => {
  const review = volumeMigrationReview("project-1", create), decide = vi.fn(async () => true);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review } }} waiting={0} onDecide={decide} />));
  expect(container.textContent).toContain(create ? "Create execution storage" : "Approve execution storage migration");
  expect(container.textContent).toContain("128 MiB cumulative media · 512 MiB volume · 1024 MiB recovery");
  expect(container.textContent).toContain("Retained history + new transaction / budget");
  expect(container.textContent).toContain(create ? "cannot resume or roll back an interrupted storage creation" : "Migration resume and rollback are not supported");
  expect(container.textContent).not.toContain("Allow for this conversation");
  if (create) { expect(container.textContent).toContain("No existing volume"); expect(container.textContent).not.toContain("old volume remains as the retained backup"); }
  else { expect(container.textContent).toContain(review.source.imageSha256); expect(container.textContent).toContain("not a third cloned volume"); }
  const allow = [...container.querySelectorAll("button")].find(button => button.textContent === (create ? "Approve creation" : "Approve migration"))!;
  const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); expect(checks).toHaveLength(2);
  expect(allow.disabled).toBe(true);
  await act(async () => checks[0].click()); expect(allow.disabled).toBe(true);
  await act(async () => checks[1].click()); expect(allow.disabled).toBe(false);
  await act(async () => { allow.click(); allow.click(); });
  expect(decide).toHaveBeenCalledExactlyOnceWith("allow", undefined, volumeMigrationConfirmation(review));
});

it("shows the distinct media64 profile and requires its exact one-time confirmation", async () => {
  const review = volumeMigrationReview();
  review.target = { ...review.target, profileId: "capacity-128-media64-v3", mediaFileBytes: 32 * 1024 ** 2, largeMediaFileBytes: 64 * 1024 ** 2, mediaWindowBytes: 64 * 1024 ** 2, largeMediaFilePolicy: "video-audio-glb-v1" };
  const previous = i18next.language, decide = vi.fn(async () => true);
  try {
    for (const [language, text] of [["en", "Raster images: 32 MiB per file. Video, audio and GLB: 64 MiB per file. Each transfer window: 64 MiB."], ["zh-CN", "栅格图每文件 32 MiB；视频、音频和 GLB 每文件 64 MiB；每次传输窗口 64 MiB。"]]) {
      await i18next.changeLanguage(language);
      await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review } }} waiting={0} onDecide={decide} />));
      expect(container.textContent).toContain(text);
      expect(container.textContent).toContain(language === "en" ? "128 MiB cumulative media" : "累计媒体 128 MiB");
      expect(container.querySelector("fieldset")?.disabled).toBe(false);
    }
    expect(validVolumeMigrationConfirmation(review, { ...volumeMigrationConfirmation(review), targetProfileId: "capacity-128-v2" })).toBe(false);
    for (const check of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => check.click());
    await act(async () => container.querySelector<HTMLButtonElement>("footer > button:last-child")!.click());
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow", undefined, volumeMigrationConfirmation(review));
    for (const bad of [0, 32 * 1024 ** 2]) expect(isVolumeMigrationReview({ ...review, target: { ...review.target, largeMediaFileBytes: bad } })).toBe(false);
    expect(isVolumeMigrationReview({ ...review, target: { ...review.target, largeMediaFilePolicy: "anything" } })).toBe(false);
    expect(validVolumeMigrationReview({ ...review, source: { ...review.source, profileId: "capacity-128-v2", volumeBytes: 512 * 1024 ** 2 } })).toBe(false);
  } finally { await i18next.changeLanguage(previous); }
});

it.each(["globalBeforeBytes", "globalDuringBytes", "guestRequiredBytes", "guestAvailableBytes", "hostRequiredBytes", "hostAvailableBytes", "requiredInodes", "availableInodes", "recoveryUsedBytes", "recoveryRequiredBytes"] as const)("volume migration blocks an unknown %s rather than assuming capacity", async field => {
  const review = volumeMigrationReview(); review.resources[field] = null;
  const decide = vi.fn(async () => true);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review } }} waiting={0} onDecide={decide} />));
  expect(container.textContent).toContain("Unknown"); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Approval blocked");
  const allow = [...container.querySelectorAll("button")].find(button => button.textContent === "Approve migration")!;
  expect(allow.disabled).toBe(true); expect(container.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () => allow.click()); expect(decide).not.toHaveBeenCalled();
});

it.each(["host", "guest", "recovery", "global"])("volume migration shows an exact one-byte %s shortfall in both languages despite rounded capacities", async kind => {
  const previous = i18next.language, review = volumeMigrationReview(), decide = vi.fn(async () => true);
  let required: number, available: number;
  if (kind === "host" || kind === "guest") {
    required = 1026 * 1024 ** 2; available = required - 1;
    review.resources[kind === "host" ? "hostRequiredBytes" : "guestRequiredBytes"] = required;
    review.resources[kind === "host" ? "hostAvailableBytes" : "guestAvailableBytes"] = available;
  } else if (kind === "recovery") {
    available = review.target.recoveryBytes; required = available + 1;
    review.resources.recoveryUsedBytes = required - review.resources.recoveryRequiredBytes!;
  } else { available = 4 * 1024 ** 3; required = available + 1; review.resources.globalDuringBytes = required; }
  review.status = "blocked"; review.blockers = ["Synthetic capacity shortage"];
  try {
    for (const language of ["en", "zh-CN"]) {
      await i18next.changeLanguage(language);
      await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review } }} waiting={0} onDecide={decide} />));
      if (kind === "host" || kind === "guest") expect(container.textContent).toContain("1026.0 MB / 1026.0 MB");
      expect(container.textContent).toContain(language === "en" ? `Short by 1 B (${required} B required / ${available} B available)` : `还差 1 B（所需 ${required} B / 可用 ${available} B）`);
      expect(container.querySelector("fieldset")?.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>("footer > button:last-child")?.disabled).toBe(true);
    }
    expect(decide).not.toHaveBeenCalled();
  } finally { await i18next.changeLanguage(previous); }
});

it("volume migration resets consent when the exact source or plan changes and leaves failed answers retryable", async () => {
  const initial = volumeMigrationReview(), decide = vi.fn().mockRejectedValueOnce(new Error("fixture offline")).mockResolvedValue(true);
  const render = (review: VolumeMigrationReview) => act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review } }} waiting={0} onDecide={decide} />));
  await render(initial);
  for (const check of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => check.click());
  const allow = [...container.querySelectorAll("button")].find(button => button.textContent === "Approve migration")!;
  await act(async () => allow.click()); expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved"); expect(allow.disabled).toBe(false);
  const changed = { ...initial, planId: "22222222-2222-4222-8222-222222222222", source: { ...initial.source, imageSha256: "b".repeat(64) } };
  await render(changed); expect(allow.disabled).toBe(true);
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(check => !check.checked)).toBe(true);
});

it("volume migration displays localized unknown and retention details in both languages", async () => {
  const previous = i18next.language, review = volumeMigrationReview(); review.resources.availableInodes = null;
  try {
    for (const [language, title, unknown, warning] of [["en", "Approve execution storage migration", "Unknown", "not a third cloned volume"], ["zh-CN", "批准执行存储迁移", "未知", "并非另外克隆第三份卷"]]) {
      await i18next.changeLanguage(language);
      await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "volumeMigration", tool: "execution_storage", canAllowSession: false, volumeMigration: review } }} waiting={0} onDecide={async () => true} />));
      expect(container.textContent).toContain(title); expect(container.textContent).toContain(unknown); expect(container.textContent).toContain(warning);
    }
  } finally { await i18next.changeLanguage(previous); }
});

it.each(["plan", "generation", "sha", "target", "unconfirmed", "session"])("volume migration confirmation cannot be substituted: %s", fault => {
  const review = volumeMigrationReview(), confirmation = volumeMigrationConfirmation(review);
  if (fault === "plan") confirmation.planId = "22222222-2222-4222-8222-222222222222";
  if (fault === "generation") confirmation.generation++;
  if (fault === "sha") confirmation.sourceImageSha256 = "b".repeat(64);
  if (fault === "target") (confirmation as { targetProfileId: string }).targetProfileId = "capacity-128-v1";
  if (fault === "unconfirmed") confirmation.capacityReviewed = false;
  if (fault === "session") Object.assign(confirmation, { allowSession: true });
  expect(validVolumeMigrationConfirmation(review, confirmation)).toBe(false);
});

it.each(["expired", "global", "guest", "host", "inodes", "history", "underestimated", "simulation", "create-mixed"])("volume migration refuses an invalid or insufficient plan: %s", fault => {
  const review = volumeMigrationReview();
  if (fault === "expired") review.expiresAt = "2000-01-01T00:00:00Z";
  if (fault === "global") review.resources.globalDuringBytes = 5 * 1024 ** 3;
  if (fault === "guest") review.resources.guestAvailableBytes = 0;
  if (fault === "host") review.resources.hostAvailableBytes = 0;
  if (fault === "inodes") review.resources.availableInodes = 0;
  if (fault === "history") review.resources.recoveryUsedBytes = 512 * 1024 ** 2;
  if (fault === "underestimated") review.resources.recoveryRequiredBytes = 1;
  if (fault === "simulation") (review.target as { profileId: string }).profileId = "capacity-128-v1";
  if (fault === "create-mixed") { review.source.profileId = "unallocated"; review.generation = 0; }
  expect(validVolumeMigrationReview(review)).toBe(false);
});

it("volume migration permits null identities only for the exact unallocated creation branch", () => {
  const create = volumeMigrationReview("project-1", true); expect(isVolumeMigrationReview(create)).toBe(true);
  expect(validVolumeMigrationConfirmation(create, volumeMigrationConfirmation(create))).toBe(true);
  for (const source of [{ ...create.source, imageId: "unexpected-image" }, { ...create.source, imageSha256: "a".repeat(64) }, { ...create.source, volumeBytes: 256 * 1024 ** 2 }, { ...create.source, profileId: "current-64" }])
    expect(isVolumeMigrationReview({ ...create, source })).toBe(false);
  const existing = volumeMigrationReview();
  expect(isVolumeMigrationReview({ ...existing, source: { ...existing.source, imageSha256: null } })).toBe(false);
  expect(isVolumeMigrationReview({ ...existing, source: { ...existing.source, imageId: "/tmp/private-volume" } })).toBe(false);
  expect(isVolumeMigrationReview({ ...existing, generation: 0 })).toBe(false);
});

it("requires the exact file and code confirmations, renders retained code as text, and never grants a session", async () => {
  const review: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "22", snapshotId: "b".repeat(64), blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z",
    files: [{ path: "public/forest.png", change: "modified", kind: "image", bytes: 474752, beforeBytes: 3307598, beforeSha256: "c".repeat(64), afterSha256: "d".repeat(64) },
      { path: "tools/artprep.py", change: "added", kind: "code", bytes: 40, afterSha256: "e".repeat(64), preview: "<img src=x onerror=alert('untrusted')>" }] };
  const decide = vi.fn(async () => true);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: true, isolatedSourceReview: review } }} waiting={0} onDecide={decide} />));
  const buttons = [...container.querySelectorAll("button")];
  const allow = buttons.find(b => b.textContent === "Allow")!;
  expect(container.textContent).toContain("tools/artprep.py");
  expect(container.textContent).toContain("3307598 → 474752");
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toContain("Retained files");
  expect(container.querySelectorAll("summary")).toHaveLength(2);
  expect(container.textContent).toContain("464 KB");
  expect(container.textContent).toContain("Existing project version SHA-256");
  expect(container.textContent).not.toContain("Allow for this conversation");
  expect(allow.disabled).toBe(true);
  const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...checks].every(check => !check.checked)).toBe(true);
  await act(async () => checks[0].click());
  expect(allow.disabled).toBe(true);
  await act(async () => checks[1].click());
  expect(allow.disabled).toBe(false);
  await act(async () => allow.click());
  expect(decide).toHaveBeenCalledExactlyOnceWith("allow", { reviewId: review.reviewId, filesReviewed: true, codeReviewed: true });
});

it("shows the retained original, explicit working dimensions and alpha evidence for a prepared image", async () => {
  const review: IsolatedSourceReview = { reviewVersion: 2, reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), rawSnapshotId: "b".repeat(64), preparedSnapshotId: "c".repeat(64), blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z",
    files: [{ path: "public/boss.png", change: "added", kind: "image", bytes: 24000, afterSha256: "d".repeat(64), imageCost: { encodedBytes: 24000, pixelCount: 262144, decodedRgbaBytes: 1048576, estimatedTextureBytes: 1048576, estimatedMipmapBytes: 1398100, decodeLimitPixels: 16777216, performanceStatus: "estimate-only" }, optimization: { originalSha256: "e".repeat(64), originalBytes: 728791, originalWidth: 1024, originalHeight: 1024, width: 512, height: 512, maxEdge: 512, hasAlpha: true, originalRetained: true } }] };
  const decide = vi.fn(async () => true);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review } }} waiting={0} onDecide={decide} />));
  expect(container.textContent).toContain("728791 B · 1024 × 1024 · Retained");
  expect(container.textContent).toContain("512 × 512");
  expect(container.textContent).toContain("Explicit maximum edge: 512 px");
  expect(container.textContent).toContain("Preserved and checked");
  expect(container.textContent).toContain("e".repeat(64));
  expect(container.textContent).toContain("24000 B · 24 KB");
  expect(container.textContent).toContain("262144");
  expect(container.textContent).toContain("RGBA8 decode estimate1.0 MB");
  expect(container.textContent).toContain("RGBA8 texture estimate (base)1.0 MB");
  expect(container.textContent).toContain("RGBA8 texture estimate (full mip chain)1.3 MB");
  expect(container.textContent).toContain("16777216 pixels · not a device budget");
  expect(container.textContent).toContain("Actual GPU memory use, target-device compatibility and FPS have not been measured");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Allow")!.disabled).toBe(false);
});

it("shows missing image estimates without claiming runtime validation in either language", async () => {
  const review: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z", files: [{ path: "public/candidate.png", change: "added", kind: "image", bytes: 24000, afterSha256: "d".repeat(64) }] };
  const render = () => act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review } }} waiting={0} onDecide={vi.fn()} />));
  await render(); expect(container.textContent).toContain("Resource estimate unavailable"); expect(container.textContent).toContain("FPS have not been measured");
  try {
    await i18next.changeLanguage("zh-CN"); await render();
    expect(container.textContent).toContain("暂无资源成本估算"); expect(container.textContent).toContain("实际显存占用、目标设备兼容性和 FPS 均未实测"); expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  } finally { await i18next.changeLanguage("en"); }
});

it.each(["raw-mismatch", "missing-prepared", "missing-original"])("cannot approve an incomplete v2 image batch: %s", async variant => {
  const review: IsolatedSourceReview = { reviewVersion: 2, reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), rawSnapshotId: variant === "raw-mismatch" ? "f".repeat(64) : "b".repeat(64), preparedSnapshotId: variant === "missing-prepared" ? undefined : "c".repeat(64), blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z",
    files: [{ path: "public/boss.png", change: "added", kind: "image", bytes: 24000, afterSha256: "d".repeat(64), optimization: { originalSha256: "e".repeat(64), originalBytes: 728791, originalRetained: variant !== "missing-original", hasAlpha: true, needsMaxEdge: true } }] };
  expect(validSourceConfirmation(review, { reviewId: review.reviewId, filesReviewed: true })).toBe(false);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review } }} waiting={0} onDecide={vi.fn()} />));
  expect(container.textContent).not.toContain("Preserved and checked");
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Allow")!.disabled).toBe(true);
});

it.each(["missing-dimensions", "missing-alpha"])("keeps the original image gates with complete advisory cost estimates: %s", async variant => {
  const review: IsolatedSourceReview = { reviewVersion: 2, reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), rawSnapshotId: "b".repeat(64), preparedSnapshotId: "c".repeat(64), blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z",
    files: [{ path: "public/boss.png", change: "added", kind: "image", bytes: 24000, afterSha256: "d".repeat(64), imageCost: { encodedBytes: 24000, pixelCount: 262144, decodedRgbaBytes: 1048576, estimatedTextureBytes: 1048576, estimatedMipmapBytes: 1398100, decodeLimitPixels: 16777216, performanceStatus: "estimate-only" }, optimization: { originalSha256: "e".repeat(64), originalBytes: 728791, originalWidth: 1024, originalHeight: 1024, ...(variant === "missing-dimensions" ? { hasAlpha: true } : { width: 512, height: 512 }), originalRetained: true } }] };
  expect(validSourceConfirmation(review, { reviewId: review.reviewId, filesReviewed: true })).toBe(false);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review } }} waiting={0} onDecide={vi.fn()} />));
  expect(container.textContent).toContain(variant === "missing-dimensions" ? "Not prepared" : "Not yet checked");
  expect(container.textContent).not.toContain("Preserved and checked");
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "Allow")!.disabled).toBe(true);
});

it("describes a verified unchanged target without claiming a file replacement and still requires code confirmation", async () => {
  const review: IsolatedSourceReview = { reviewVersion: 2, publicationUnchanged: true, reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), rawSnapshotId: "b".repeat(64), preparedSnapshotId: "c".repeat(64), blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z",
    files: [{ path: "tools/ready.mjs", kind: "code", change: "modified", bytes: 25, beforeBytes: 25, beforeSha256: "d".repeat(64), afterSha256: "d".repeat(64), preview: "export const ready = true;" }] };
  const decide = vi.fn(async () => true);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review } }} waiting={0} onDecide={decide} />));
  expect(container.textContent).toContain("Files do not need rewriting");
  expect(container.textContent).toContain("Target already matches");
  expect(container.textContent).not.toContain("Replace with original retained");
  expect(container.textContent).not.toContain("approve this exact batch being written");
  const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const allow = [...container.querySelectorAll("button")].find(button => button.textContent === "Allow")!;
  await act(async () => checks[0].click()); expect(allow.disabled).toBe(true);
  await act(async () => checks[1].click()); expect(allow.disabled).toBe(false);
});

it("keeps every file and blocker inspectable and never allows a blocked batch", async () => {
  const files = Array.from({ length: 9 }, (_, index) => ({ path: `public/media/${"long-directory/".repeat(8)}asset-${index}.png`, change: "added" as const, kind: "image" as const, bytes: 40, afterSha256: "d".repeat(64) }));
  const review: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "22", snapshotId: "b".repeat(64), files, blockers: [{ path: "unsafe.json", reason: "Incomplete source preview" }], approved: false, expiresAt: "2099-01-01T00:00:00Z" };
  const decide = vi.fn(async () => true);
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: review } }} waiting={0} onDecide={decide} />));
  expect(container.querySelectorAll("summary")).toHaveLength(9);
  for (const file of files) expect(container.textContent).toContain(file.path);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("unsafe.json: Incomplete source preview");
  const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(checks).toHaveLength(1);
  await act(async () => checks[0].click());
  const allow = [...container.querySelectorAll("button")].find(button => button.textContent === "Allow")!;
  expect(allow.disabled).toBe(true);
  await act(async () => allow.click());
  expect(decide).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Deny")!.click());
  expect(decide).toHaveBeenCalledExactlyOnceWith("deny");
});

it("keeps failed decisions retryable, locks pending decisions, and resets consent for a different review", async () => {
  const review: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "22", snapshotId: "b".repeat(64), files: [{ path: "notes.txt", change: "added", kind: "text", bytes: 40, afterSha256: "d".repeat(64), preview: "retained text" }], blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z" };
  let finish!: (answered: boolean) => void;
  const decide = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const render = (source: IsolatedSourceReview) => act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "recover_isolated_changes", canAllowSession: false, isolatedSourceReview: source } }} waiting={0} onDecide={decide} />));
  await render(review);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const allow = [...container.querySelectorAll("button")].find(button => button.textContent === "Allow")!;
  await act(async () => allow.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  expect(allow.disabled).toBe(false);
  await act(async () => { allow.click(); allow.click(); });
  expect(decide).toHaveBeenCalledTimes(2);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Saving your decision…");
  expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish(false));
  await render({ ...review, reviewId: "f".repeat(64) });
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(allow.disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("shows what the agent wants to run and sends one answer", async () => {
  const decide = vi.fn(async () => true);
  await act(async () =>
    root.render(
      <ApprovalCard
        request={request}
        agentName="Claude Code"
        waiting={1}
        onDecide={decide}
      />,
    ),
  );
  expect(container.textContent).toContain("Claude Code wants to run a command");
  expect(container.textContent).toContain("git push origin main");
  expect(container.textContent).toContain("Publishes the branch");
  expect(container.textContent).toContain("1 more waiting");
  const allow = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Allow for this conversation",
  )!;
  await act(async () => {
    allow.click();
    allow.click();
  });
  expect(decide).toHaveBeenCalledOnce();
  expect(decide).toHaveBeenCalledWith("allow-session");
});

it("shows every read/write root and network scope before a permission grant", async () => {
  await act(async () =>
    root.render(
      <ApprovalCard
        request={{
          ...request,
          request: {
            kind: "other",
            tool: "permissions",
            paths: [
              { path: "/reference", access: "read" },
              { path: "/export", access: "write" },
            ],
            network: true,
            canAllowSession: false,
          },
        }}
        waiting={0}
        onDecide={async () => true}
      />,
    ),
  );
  expect(container.textContent).toContain("/reference");
  expect(container.textContent).toContain("/export");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.textContent).toContain("Allow network access for this turn");
  expect(container.textContent).not.toContain("Allow for this conversation");
});

it("offers only a single answer when the agent cannot remember one", async () => {
  await act(async () =>
    root.render(
      <ApprovalCard
        request={{
          ...request,
          request: {
            kind: "file",
            tool: "Write",
            path: "/etc/hosts",
            canAllowSession: false,
          },
        }}
        waiting={0}
        onDecide={async () => true}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "The agent wants to access files outside the project",
  );
  expect(
    [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Deny", "Allow"]);
});

it("keeps waiting requests out of the timeline and shows answered ones as work", () => {
  expect(
    approvalOutcomeLabel({ ...request, status: "completed", decision: "deny" }),
  ).toBe("Denied: git push origin main");
  const user: ThreadItem = {
    id: "u",
    turnId: "turn-1",
    type: "userMessage",
    text: "push",
  };
  const waiting = projectTurnDisplay({
    id: "turn-1",
    conversationId: "c",
    status: "inProgress",
    items: [user, request],
  });
  expect(JSON.stringify(waiting)).not.toContain("approvalRequest");
  const answered = projectTurnDisplay({
    id: "turn-1",
    conversationId: "c",
    status: "completed",
    items: [user, { ...request, status: "completed", decision: "allow" }],
  });
  expect(JSON.stringify(answered)).toContain("approvalRequest");
});

it("keeps a failed approval request answerable and identifies granted paths in history", async () => {
  const decide = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(true);
  await act(async () =>
    root.render(
      <ApprovalCard request={request} waiting={0} onDecide={decide} />,
    ),
  );
  const allow = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Allow",
  )!;
  await act(async () => allow.click());
  expect(allow.disabled).toBe(false);
  await act(async () => allow.click());
  expect(decide).toHaveBeenCalledTimes(2);
  expect(
    approvalOutcomeLabel({
      ...request,
      request: {
        kind: "other",
        tool: "permissions",
        paths: [{ path: "/reference", access: "read" }],
        canAllowSession: false,
      },
      status: "completed",
      decision: "allow",
    }),
  ).toContain("/reference");
});

it("names what allowing for the conversation covers", async () => {
  const render = (
    sessionScope: NonNullable<(typeof request)["request"]["sessionScope"]>,
  ) =>
    act(async () =>
      root.render(
        <ApprovalCard
          request={{
            ...request,
            request: { ...request.request, sessionScope },
          }}
          waiting={0}
          onDecide={vi.fn(async () => true)}
        />,
      ),
    );
  const labels = () =>
    [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
  await render({ commands: ["git push"] });
  expect(labels()).toContain("Allow git push for this conversation");
  await render({ readFolders: ["/Users/me/notes"] });
  expect(labels()).toContain("Allow reading notes/ for this conversation");
});
