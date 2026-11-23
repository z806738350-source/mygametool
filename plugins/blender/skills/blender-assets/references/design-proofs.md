# 2D design proofs

Use this stage for reference views, a separate weapon design, crops, paint corrections and comparison sheets. For generation, query `list_media_capabilities` with `capability: "image"`. Keep the selected original, the approved views and the high-resolution sources.

For a local diagnostic or revision, follow [custom Python](custom-python.md). Use a named workflow and a project-relative `scriptPath`, declare additional project files in `inputs`, and write outputs to the run's output directory. The runner accepts 64 MiB per file and 128 MiB each for total inputs and outputs. Use the paths in the completed result. If interrupted, recover that run by its original `runId`.

Open each run's relevant images. Compare original and candidate at matched framing, then inspect the changed areas at close range. Judge weapon silhouette, grip and details against the source. Use measurements and reports alongside the pictures. Revise the affected art and inspect the revised pixels.

For a changed turnaround, use [turnaround inspection](turnaround.md) on the complete ordered set and original. Present the checked design and weapon on the Canvas. Wait for the user's approval before the Tripo submission. Begin the first production modeling run with its source and brief as described in [pipeline](pipeline.md).
