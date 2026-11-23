# Custom Blender Python

Read this when writing a `custom` stage. The runner starts Blender in background
mode. Use data and scene operations that work with no window or active viewport.
Pass one self-contained project script in `scriptPath`. Include project-specific
helper functions in that script. Use `inputs` for extra model, texture or data
files such as a GLB, PNG or JSON. The process runs in a private task directory
without network or access to undeclared host files. Use Blender's bundled Python and helpers independently
of installed packages and user preferences.

When the stage arguments are ready, include `save.content` for a new script or
`save.edits` for exact replacements in the `run_blender` call with its
`scriptPath`. The same call saves the file and runs one Blender stage on that
revision. Omit `save` to run an existing unchanged file. For a bundled stage
the same fields save its `configPath`. Wait for the stage result before
requesting another Blender run. Open its actual output images before deciding
on revisions. If the file was saved but Blender could not start, keep the
saved recipe and address the reported reason before running it again.

## Load the source and save the result

The shipped baseline has been exercised with Blender 5.3. Its ordinary Python
uses Blender's `bpy`, `bmesh` and `mathutils`, with no external Python packages.
Preview rendering uses CPU Cycles. Custom scripts must follow the tool's same
input/output boundary, disable automatic blend-file execution, pack textures,
and explicitly save their `.blend` with `bpy.ops.wm.save_as_mainfile(filepath=..., compress=False)`
(the publisher validates an ordinary `BLENDER` file header, not a compressed wrapper).
Custom scripts can `import pipeline` and `import export_glb` to reuse these helpers;
the host preserves the exact executed sources in `recipe/` alongside each result.
Use this argument setup in custom scripts. Blender's `--` separator is present in
`sys.argv`; passing the whole argument list to `argparse` hides the options.
Inputs keep their project-relative subdirectories, so use the supplied `--input`
instead of searching only the root input directory:

```python
import argparse
import sys
from pathlib import Path
import bpy
import pipeline

parser = argparse.ArgumentParser()
parser.add_argument("--input-dir", required=True)
parser.add_argument("--output-dir", required=True)
parser.add_argument("--input")
parser.add_argument("--config")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
inputs = Path(args.input_dir)
output = Path(args.output_dir)
if args.input:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    pipeline.load_source(inputs / args.input, inputs)
# Read only declared inputs. Write results only below output.
```

Name datablocks explicitly and select shader nodes by type. Bake materials
glTF cannot represent. A modeling script saves its editable `scene.blend`
inside the output directory and may export an intermediate `review.glb`.
A diagnostic script can return its measurements alone. Use the bundled `export`
stage on the selected scene for the final candidate.

## Keep comparison jobs small

Reuse the export's retained reports and rendered frames for the checks they
already cover. When a repair needs a new before-and-after comparison, separate
numerical checks from rendering. Compare GLB channel data without loading
textures into Blender. Render each textured variant in its own job with the
same camera, light and sample frames, then assemble the saved panels in a
small image-only job. If the Blender runner reports a memory limit, split the
diagnostic before retrying and reuse the retained models.

Convert NumPy scalars and arrays to ordinary Python values before writing
JSON. For a candidate near an explicit triangle maximum, calculate the net
increase of proposed edits before applying them. If a trial exceeds the
budget, return the measured count and affected regions so the next revision
can redistribute the geometry.

## Recover a run

A confirmed script failure returns its retained run ID, failure status and log;
it does not approve or publish partial files. Fix the script/configuration and
make a new call. Repeating the original call returns its original outcome.
For an unknown or interrupted delivery, inspect/recover that exact retained run
before starting new work. Never recreate a Tripo initial model to fix a local error.
The runner is responsible for process and
file isolation; Python argument validation is not a sandbox.
