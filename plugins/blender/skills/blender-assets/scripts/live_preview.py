"""Publish live copies for the host-owned Blender observer, never the source file."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from time import monotonic

import bpy


_sequence = 0
_last_saved = float("-inf")
_last_status = {}
_disabled = False


def checkpoint(label, force=False):
    """Save the actual current scene at most once a second; preview failures do not stop production."""
    global _sequence, _last_saved, _last_status, _disabled
    directory = os.environ.get("OHMYGAME_BLENDER_LIVE_DIR")
    if not directory or _disabled or not force and monotonic() - _last_saved < 1:
        return False
    root = Path(directory)
    pending = root / "scene.pending.blend"
    status_pending = root / "status.json.tmp"
    ready = False
    try:
        if not root.is_absolute():
            raise ValueError("The live preview directory must be absolute")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("Live preview checkpoints need an operation label")
        root.mkdir(parents=True, exist_ok=True)
        ready = True
        bpy.context.view_layer.update()
        bpy.ops.file.pack_all()
        save_version = bpy.context.preferences.filepaths.save_version
        try:
            bpy.context.preferences.filepaths.save_version = 0
            bpy.ops.wm.save_as_mainfile(filepath=str(pending), copy=True, compress=False, relative_remap=False, check_existing=False)
        finally:
            bpy.context.preferences.filepaths.save_version = save_version
        os.replace(pending, root / "scene.blend")
        status = {"sequence": _sequence + 1, "label": label[:160], "updatedAt": datetime.now(timezone.utc).isoformat()}
        status_pending.write_text(json.dumps(status, ensure_ascii=False) + "\n")
        os.replace(status_pending, root / "status.json")
        _sequence += 1
        _last_status = status
        _last_saved = monotonic()
        return True
    except Exception as error:
        _disabled = True
        message = f"LIVE_PREVIEW_ERROR: {type(error).__name__}: {error}"
        print(message, file=sys.stderr, flush=True)
        try:
            if ready:
                status_pending.write_text(json.dumps({**_last_status, "error": message}, ensure_ascii=False) + "\n")
                os.replace(status_pending, root / "status.json")
        except Exception:
            pass
        return False
    finally:
        for temporary in (pending, status_pending) if ready else ():
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
