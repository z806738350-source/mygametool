import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";
import type { ProjectState, PromptImage } from "../src/shared/contracts.js";
import { readWebpModelReference } from "../src/daemon/image-working-assets.js";
import { createTurnaroundInspection, hasTurnaroundAssessment } from "../src/daemon/turnaround-inspection.js";
import { AgentAttachmentStore } from "../src/daemon/agent-attachments.js";
import { randomUUID } from "node:crypto";

it("supplies labeled actual pixels, compares an authorized original, and binds the normalized ordered views across Canvas copies", async () => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omg-turnaround-")));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const project = { workspacePath: workspace } as ProjectState;
  const paths = ["front.png", "left.webp", "back.jpg"];
  const make = (color: string) => sharp({ create: { width: 32, height: 32, channels: 3, background: color } });
  const buffers = [await make("red").png().toBuffer(), await make("blue").webp().toBuffer(), await make("green").jpeg().toBuffer()];
  await Promise.all(buffers.map((bytes, i) => writeFile(path.join(workspace, paths[i]!), bytes)));
  const original = await new AgentAttachmentStore().store(project, { batchId: randomUUID(), name: "concept.jpg", contents: buffers[2]! });
  const receipt = `attachment:${original.batchId}/${original.id}`;
  const views = createTurnaroundInspection(project, ref => ref.id === original.id && ref.batchId === original.batchId);
  const context = { model: { input: ["text", "image"] } } as never;
  const left = path.join(workspace, paths[1]!);
  const images: PromptImage[] = [
    { mediaType: "image/png", data: buffers[0]!.toString("base64") },
    await readWebpModelReference(workspace, { absolutePath: left, size: (await stat(left)).size }),
    { mediaType: "image/jpeg", data: buffers[2]!.toString("base64") },
  ];
  expect(views.match(paths, images)).toBeUndefined();
  const args = { originalPath: receipt, imagePaths: paths };
  await expect(views.tool.execute("text-only", args, undefined, undefined, { model: { input: ["text"] } } as never)).rejects.toThrow("image-enabled");
  const output = await views.tool.execute("inspected", args, undefined, undefined, context);
  expect(output.content.filter(part => part.type === "image").map(part => part.data))
    .toEqual([images[2]!.data, ...images.map(image => image.data)]);
  expect(output.content.filter(part => part.type === "text").map(part => part.text)).toEqual([
    expect.stringMatching(/Original/), expect.stringMatching(/Front/), expect.stringMatching(/left profile/), expect.stringMatching(/Back/),
  ]);
  expect(views.match(["copy-a.png", "copy-b.png", "copy-c.jpg"], images)).toMatchObject({ inspectionCallId: "inspected", original: images[2], originalPath: receipt });
  expect(views.match(paths, [images[0]!, images[2]!, images[1]!])).toBeUndefined();
  expect(views.match(paths, [images[2]!, ...images.slice(1)])).toBeUndefined();
  await symlink(left, path.join(workspace, "linked.webp"));
  await expect(views.tool.execute("link", { imagePaths: [paths[0], "linked.webp", paths[2]] }, undefined, undefined, context)).rejects.toThrow("links");
  await expect(createTurnaroundInspection(project).tool.execute("private", args, undefined, undefined, context)).rejects.toThrow("current conversation branch");
  expect(createTurnaroundInspection(project).match(paths, images)).toBeUndefined();
});

it("only accepts visible findings after a successful inspection on the current branch and before the submission", () => {
  const user = { role: "user", content: "Prepare 3D views" };
  const call = { type: "toolCall", id: "submit", name: "generate_3d_from_views" };
  const finding = { type: "text", text: "The far waist anchor is hidden in the left profile." };
  const evidence = { role: "toolResult", toolCallId: "inspect", toolName: "inspect_3d_views", isError: false, content: [{ type: "image", data: "abc" }] };
  const assistant = (...content: unknown[]) => ({ role: "assistant", content });
  const checked = (...messages: unknown[]) => hasTurnaroundAssessment(messages.map(message => ({ type: "message", message })) as SessionEntry[], "inspect", "submit");
  expect(checked(user, evidence, assistant(finding, call))).toBe(true);
  expect(checked(user, evidence, assistant(finding), assistant(call))).toBe(true);
  expect(checked(user, assistant(finding, call), evidence)).toBe(false);
  expect(checked(user, evidence, assistant(call, finding))).toBe(false);
  expect(checked(user, evidence, assistant({ type: "thinking", thinking: "looks good" }, call))).toBe(false);
  expect(checked(user, { ...evidence, isError: true }, assistant(finding, call))).toBe(false);
  expect(checked(user, { ...evidence, content: [finding] }, assistant(finding, call))).toBe(false);
  expect(checked(user, evidence, assistant(finding), user, assistant(call))).toBe(false);
  expect(checked(user, evidence, assistant(finding))).toBe(false);
});
