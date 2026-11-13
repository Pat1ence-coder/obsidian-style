"""Preflight local file operations without resolving away symbolic links."""
from pathlib import Path
import os
import stat


def checked_path(path, boundary=None):
    path = Path(os.path.abspath(path))
    if boundary is not None:
        boundary = Path(os.path.abspath(boundary))
        try:
            path.relative_to(boundary)
        except ValueError:
            raise ValueError('Path outside allowed root: ' + str(path)) from None
    # Inspect ancestors as well as the final component; exists() misses dangling links.
    for part in (*reversed(path.parents), path):
        try:
            mode = part.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise ValueError('Symbolic links are not allowed: ' + str(part))
        if part != path and not stat.S_ISDIR(mode):
            raise ValueError('Expected directory: ' + str(part))
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('Expected regular file or directory: ' + str(part))
    return path


def checked_tree(path, boundary):
    path = checked_path(path, boundary)
    yield path
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from checked_tree(child, boundary)
