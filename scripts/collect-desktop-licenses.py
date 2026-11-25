"""Retain runtime distribution metadata and license texts alongside the frozen worker."""
import importlib.metadata
from pathlib import Path
import re
import shutil
import sys
import sysconfig

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
for distribution in importlib.metadata.distributions():
    name = re.sub(r"[^a-zA-Z0-9_.-]", "_", distribution.metadata["Name"])
    folder = destination / name
    folder.mkdir(exist_ok=True)
    (folder / "METADATA.txt").write_text(distribution.read_text("METADATA") or str(distribution.metadata), encoding="utf-8")
    for file in distribution.files or []:
        if any(word in file.name.upper() for word in ("LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE")):
            original = distribution.locate_file(file)
            if original.is_file():
                # Avoid path traversal from RECORD entries; preserve unique names.
                target = folder / re.sub(r"[^a-zA-Z0-9_.-]", "_", str(file))
                shutil.copy2(original, target)
for candidate in [Path(sys.base_prefix) / "LICENSE.txt", Path(sysconfig.get_path("stdlib")) / "LICENSE.txt"]:
    if candidate.is_file():
        shutil.copy2(candidate, destination / "PYTHON-LICENSE.txt")
        break
else:
    raise SystemExit("Python license not found; include its license before redistributing this runtime")
