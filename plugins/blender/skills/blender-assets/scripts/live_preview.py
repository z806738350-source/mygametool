"""Compatibility for project scripts written for the former live Blender window."""


def checkpoint(label, force=False):
    """Headless workers do not publish live scene copies."""
    return False
