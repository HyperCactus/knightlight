#!/usr/bin/env python3
"""Export the authored vector mark. Uses system librsvg/pycairo and Pillow."""
from pathlib import Path
from io import BytesIO
import gi
import cairo
from PIL import Image

gi.require_version("Rsvg", "2.0")
from gi.repository import Rsvg

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "static/icons"
source = (ICONS / "knightlight.svg").read_text()

def render(size, maskable=False):
    svg = source
    if maskable:
        svg = svg.replace('rx="112"', 'rx="0"')
        # A full-bleed background, with all identifying artwork inside the safe
        # central circle. Platform launchers supply their own outer mask.
        svg = svg.replace('stroke="#304236"', 'stroke="none"')
    handle = Rsvg.Handle.new_from_data(svg.encode())
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    context = cairo.Context(surface)
    viewport = Rsvg.Rectangle()
    viewport.x = viewport.y = 0
    viewport.width = viewport.height = size
    handle.render_document(context, viewport)
    output = BytesIO()
    surface.write_to_png(output)
    return Image.open(BytesIO(output.getvalue())).convert("RGBA")

for size in [32, 48, 192, 512]:
    render(size).save(ICONS / f"icon-{size}.png", optimize=True)
render(512, True).save(ICONS / "icon-maskable-512.png", optimize=True)
render(180, True).save(ROOT / "static/apple-touch-icon.png", optimize=True)
render(256).save(ROOT / "static/favicon.ico", sizes=[(s,s) for s in [16,24,32,48,64,128,256]])
(ROOT / "static/favicon.svg").write_text(source)
print("Exported favicon, Apple touch icon, and regular/maskable app icons.")
