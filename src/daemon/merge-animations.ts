import { Model3DGenerationError } from "./model3d.js";
import { inspectModel3D, mergeModel3DBatches } from "./model3d-inspect.js";

/** Merge pairs serially. Provider orchestration retains each original batch before advancing. */
export async function mergeAnimationClips(
  files: Buffer[],
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!files.length)
    throw new Model3DGenerationError("No animated models to merge");
  let merged = files[0]!;
  if (files.length === 1) {
    await inspectModel3D(merged, signal);
    return merged;
  }
  for (let index = 1; index < files.length; index++) {
    signal?.throwIfAborted();
    merged = (await mergeModel3DBatches(merged, files[index]!, signal)).bytes;
  }
  return merged;
}
