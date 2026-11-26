import { createHash } from "node:crypto";
import {
  assertCharacterViewScale,
  CHARACTER_VIEW_DIRECTIONS,
  type CharacterViewCanvas,
  type CharacterViewPoint,
  type CharacterViewScaleInput,
  type CharacterViewSource,
} from "../shared/character-views.js";
import { MAX_AGENT_ATTACHMENT_BYTES, parseAgentAttachmentReference, resolveAgentAttachment, type AuthorizeAgentAttachment } from "./agent-attachments.js";
import { localAgentPath } from "./agent-local-files.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import { readCanvasAssets } from "./canvas-assets.js";
import { prepareCharacterRaster } from "./character-view-raster.js";
import type { CharacterViewPublicationOperation } from "./character-view-publication.js";
import { sniffImageType } from "./image-format.js";
import { readSafeProjectFile, SafeProjectFileError } from "./safe-project-file.js";

const MAX_SOURCE_IMAGE_BYTES = 32 * 1024 * 1024;

/** Resolve the original bytes in the current project or authorized conversation only. */
export async function readCharacterViewSource(
  workspace: string,
  source: CharacterViewSource,
  authorizeAttachment?: AuthorizeAgentAttachment,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let bytes: Buffer;
  if (source.kind === "attachment") {
    const receipt = parseAgentAttachmentReference(source.reference);
    if (!receipt) throw toolPreflightError("Use the full image attachment receipt.", "invalid_character_view_input");
    if (!authorizeAttachment || !await authorizeAttachment(receipt, signal)) {
      throw toolPreflightError("Use an exact image attachment receipt from this conversation branch.", "authorization_denied");
    }
    const attachment = await resolveAgentAttachment(workspace, receipt);
    bytes = await readSafeProjectFile(workspace, attachment.absolutePath, MAX_AGENT_ATTACHMENT_BYTES);
  } else {
    const relative = source.kind === "canvas" ? (await readCanvasAssets(workspace)).assets[source.reference]?.path : source.reference;
    if (!relative) throw toolPreflightError("Choose a Canvas image registered to this project.", "invalid_character_view_input");
    try {
      bytes = await readSafeProjectFile(workspace, await localAgentPath(workspace, relative), MAX_SOURCE_IMAGE_BYTES);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT")
        throw toolPreflightError("The character source is missing. Review the current image path.", "invalid_character_view_input");
      if (cause instanceof SafeProjectFileError && [409, 413].includes(cause.statusCode))
        throw toolPreflightError(cause.message, "invalid_character_view_input");
      throw cause;
    }
  }
  signal?.throwIfAborted();
  const mediaType = sniffImageType(bytes);
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") {
    throw toolPreflightError("Character sources must be PNG, JPEG or WebP images.", "invalid_character_view_input");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (source.expectedSha256 !== undefined && source.expectedSha256 !== sha256) {
    throw toolPreflightError("The referenced character pixels changed. Read and review the current source before continuing.", "invalid_character_view_input");
  }
  return { bytes, mediaType, sha256 };
}

export interface CharacterViewPublicationCandidate extends CharacterViewScaleInput {
  viewRevision: string;
  sourceSha256: string;
  sampling: "nearest" | "lanczos3";
}

export interface CharacterViewPublicationGeometry {
  canvas: CharacterViewCanvas;
  pivot: CharacterViewPoint;
  headToGround: number;
  displayHeadToGround: number;
}

/** Run before a publication intent or staged payload. The landmarks come from visual review. */
export function checkCharacterViewPublication(
  candidates: readonly CharacterViewPublicationCandidate[],
  geometry: CharacterViewPublicationGeometry,
) {
  if (candidates.length === 0 || candidates.length > CHARACTER_VIEW_DIRECTIONS.length ||
      new Set(candidates.map(candidate => candidate.direction)).size !== candidates.length ||
      candidates.some(candidate => !CHARACTER_VIEW_DIRECTIONS.includes(candidate.direction))) {
    throw new Error("Choose one to eight distinct character directions.");
  }
  const { canvas, pivot, headToGround } = geometry;
  if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height) || canvas.width <= 0 || canvas.height <= 0 ||
      ![pivot.x, pivot.y].every(Number.isFinite) || pivot.x < 0 || pivot.x > canvas.width || pivot.y > canvas.height ||
      !Number.isFinite(headToGround) || headToGround <= 0 || pivot.y < headToGround) {
    throw new Error("Choose a common canvas and ground anchor with room for the measured head height.");
  }
  for (const candidate of candidates) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(candidate.viewRevision) || !/^[a-f0-9]{64}$/.test(candidate.sourceSha256) ||
        !["nearest", "lanczos3"].includes(candidate.sampling)) {
      throw new Error(`${candidate.direction}: invalid version, source digest, or raster sampling rule.`);
    }
  }
  return candidates.map(candidate => assertCharacterViewScale(candidate, geometry));
}

/** The caller supplies project-authorized candidates and a durable operation with its space reserved. */
export async function stageCharacterViewPngs(
  candidates: readonly CharacterViewPublicationCandidate[],
  geometry: CharacterViewPublicationGeometry,
  readCandidate: (candidate: CharacterViewPublicationCandidate) => Promise<Buffer>,
  operation: Pick<CharacterViewPublicationOperation, "stagePng">,
  signal?: AbortSignal,
) {
  const checks = checkCharacterViewPublication(candidates, geometry);
  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    signal?.throwIfAborted();
    const source = await readCandidate(candidate);
    if (createHash("sha256").update(source).digest("hex") !== candidate.sourceSha256) {
      throw new Error(`${candidate.direction}: the approved source pixels changed. Choose and review the candidate again.`);
    }
    const { png, ...raster } = await prepareCharacterRaster(source, {
      canvas: geometry.canvas,
      pivot: geometry.pivot,
      sourceGroundPoint: candidate.sourceGroundPoint,
      scale: candidate.scale,
      sampling: candidate.sampling,
    });
    if (candidate.sourceHeadY >= raster.source.height) {
      throw new Error(`${candidate.direction}: the verified head landmark is outside the source image.`);
    }
    signal?.throwIfAborted();
    const staged = await operation.stagePng(candidate.direction, png);
    results.push({ direction: candidate.direction, viewRevision: candidate.viewRevision, sourceSha256: candidate.sourceSha256,
      scaleCheck: checks[index]!, ...raster, ...staged });
  }
  return results;
}
