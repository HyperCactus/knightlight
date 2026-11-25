"""One compact frozen runtime, launched as independent voice/opponent processes."""
import multiprocessing
import runpy
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()
    # Frozen interpreters ignore PYTHON* environment settings. The Rust JSON
    # protocol is UTF-8 on every OS, including Windows with a legacy code page.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in ("speech", "opponent"):
        raise SystemExit("Expected speech or opponent worker mode")
    runpy.run_module("speech" if mode == "speech" else "desktop_opponent", run_name="__main__")
