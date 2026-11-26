import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalDecision, TripoModelReview } from "../shared/agent-runtimes.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";

export type TripoModelReviewStatus = "approved" | "changes-requested" | "preview-unavailable";

export class TripoModelReviews {
  constructor(private readonly privateRoot: string, private readonly projects: ProjectManager, private readonly library: AssetLibrary) {}

  #receipt(projectId: string, assetId: string) {
    return path.join(this.privateRoot, projectId, "tripo-reviews", `${assetId}.sha256`);
  }

  async #approved(projectId: string, assetId: string, sha256: string) {
    try {
      return await readFile(this.#receipt(projectId, assetId), "utf8") === sha256;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
  }

  async requireApproval(projectId: string, assetId: string, sha256: string) {
    if (!await this.#approved(projectId, assetId, sha256))
      throw toolPreflightError(`Blender did not start. Use review_tripo_model with sourceAssetId "${assetId}" and wait for the user to accept that exact model. Retain the original; a review does not require new generation.`, "model_review_required");
  }

  async checkDeclaredPaths(projectId: string, paths: readonly string[], signal?: AbortSignal) {
    for (const assetId of await this.projects.boundTripoModelIds(projectId, paths)) {
      const source = await this.projects.blenderModelSource(projectId, assetId, signal);
      await this.requireApproval(projectId, source.assetId, source.sha256);
    }
  }

  async review(projectId: string, assetId: string, ask: (review: TripoModelReview) => Promise<ApprovalDecision>, signal?: AbortSignal): Promise<TripoModelReviewStatus | undefined> {
    signal?.throwIfAborted();
    const asset = this.library.get(assetId);
    if (asset?.origin !== "generated" || asset.generation?.protocol !== "tripo-v3") return;
    const source = await this.projects.blenderModelSource(projectId, assetId, signal);
    if (await this.#approved(projectId, source.assetId, source.sha256)) return "approved";
    const fbx = source.extension === "fbx";
    const previewSha256 = fbx ? asset.model3d?.preview?.sha256 : source.sha256;
    if (!previewSha256 || (fbx && asset.model3d?.preview?.status !== "ready")) return "preview-unavailable";
    const review = { reviewId: randomUUID(), assetId: source.assetId, name: asset.name, fbx, previewSha256 };
    if (await ask(review) !== "allow") return "changes-requested";

    const destination = this.#receipt(projectId, source.assetId);
    const temporary = `${destination}.${review.reviewId}.tmp`;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, source.sha256, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return "approved";
  }
}
