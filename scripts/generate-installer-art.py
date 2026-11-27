#!/usr/bin/env python3
"""Export small installer illustrations from authored SVG; needs librsvg/pycairo/Pillow."""
from pathlib import Path
from io import BytesIO
import cairo
import gi
from PIL import Image

gi.require_version("Rsvg", "2.0")
from gi.repository import Rsvg

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "src-tauri/installer"

def export(name, width, height, content, bitmap=False):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">{content}</svg>'
    (DIRECTORY / f"{name}.svg").write_text(svg + "\n")
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, width, height)
    viewport = Rsvg.Rectangle()
    viewport.x = viewport.y = 0
    viewport.width, viewport.height = width, height
    Rsvg.Handle.new_from_data(svg.encode()).render_document(cairo.Context(surface), viewport)
    data = BytesIO()
    surface.write_to_png(data)
    image = Image.open(BytesIO(data.getvalue())).convert("RGB")
    image.save(DIRECTORY / f"{name}.{'bmp' if bitmap else 'png'}")

DIRECTORY.mkdir(parents=True, exist_ok=True)
export("macos-background", 660, 400, '''
<rect width="660" height="400" fill="#f2f1e9"/>
<text x="330" y="52" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#183c31">knightlight</text>
<text x="330" y="80" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="13" fill="#54655b">Your personal chess training room</text>
<path d="M292 170h74m-15-15 15 15-15 15" stroke="#557d66" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<text x="330" y="292" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#183c31">Drag Knightlight into Applications</text>
<text x="330" y="322" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="12" fill="#54655b">Then open it from Applications and eject this disk.</text>
''')
# The original app mark is embedded as vector artwork in the Windows sidebar.
mark = (ROOT / "static/icons/knightlight.svg").read_text()
import re
mark = re.sub(r'<svg[^>]*>', '<svg x="42" y="58" width="80" height="80" viewBox="0 0 512 512">', mark[mark.index('<svg'):], count=1)
export("windows-sidebar", 164, 314, f'''
<rect width="164" height="314" fill="#101c17"/>{mark}
<text x="82" y="177" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#edf0df">knightlight</text>
<g text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="11" fill="#b3c0af">
<text x="82" y="210">Your games.</text><text x="82" y="230">Your next move.</text>
<text x="82" y="284" font-size="9">PLAY · LEARN · IMPROVE</text></g>
''', bitmap=True)
print("Exported macOS drag-to-Applications background and Windows installer sidebar")
