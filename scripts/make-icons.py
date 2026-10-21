#!/usr/bin/env python3
"""Draws the app's icons from one shape: a single breath, rising and falling.

Writes build/icon.png (installer and app icon), src/main/assets/ (window and tray icons),
src/renderer/mark.svg and docs/assets/ (the landing page). Needs Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
GREEN = (44, 110, 90, 255)
WHITE = (255, 255, 255, 255)
BLACK = (0, 0, 0, 255)

# The breath in a 128-unit square: flat, up, down, flat.
SEGMENTS = [
    ((22, 64), (34, 64), (38, 42), (50, 42)),
    ((50, 42), (62, 42), (66, 86), (78, 86)),
    ((78, 86), (90, 86), (94, 64), (106, 64)),
]
PATH_D = "M22 64C34 64 38 42 50 42S66 86 78 86S94 64 106 64"


def bezier(p0, p1, p2, p3, steps=80):
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def draw_wave(draw, scale, offset, width, colour):
    points = [(offset[0] + x * scale, offset[1] + y * scale) for seg in SEGMENTS for x, y in bezier(*seg)]
    r = width / 2
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        draw.line([(x0, y0), (x1, y1)], fill=colour, width=int(width))
    for x, y in (points[0], points[-1], *points[::6]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=colour)


def app_icon(size, margin_ratio=100 / 1024, radius_ratio=185 / 824):
    ss = 4
    big = size * ss
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    margin = big * margin_ratio
    box = big - 2 * margin
    draw.rounded_rectangle([margin, margin, big - margin, big - margin], radius=box * radius_ratio, fill=GREEN)
    scale = box / 128
    draw_wave(draw, scale, (margin, margin), 11 * scale, WHITE)
    return image.resize((size, size), Image.LANCZOS)


def tray_template(size):
    ss = 8
    big = size * ss
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # The wave alone, filling the width, for the macOS menu bar (drawn as a template image).
    scale = big / 100
    draw_wave(draw, scale, (-14 * scale, big / 2 - 64 * scale), 12 * scale, BLACK)
    return image.resize((size, size), Image.LANCZOS)


def main():
    (ROOT / "build").mkdir(exist_ok=True)
    assets = ROOT / "src/main/assets"
    assets.mkdir(parents=True, exist_ok=True)
    docs = ROOT / "docs/assets"
    docs.mkdir(parents=True, exist_ok=True)

    app_icon(1024).save(ROOT / "build/icon.png")
    app_icon(512).save(assets / "icon.png")
    # Windows tray and taskbar: the full icon, edge to edge.
    app_icon(32, margin_ratio=0, radius_ratio=0.22).save(assets / "tray.png")
    app_icon(64, margin_ratio=0, radius_ratio=0.22).save(assets / "tray@2x.png")
    tray_template(22).save(assets / "trayTemplate.png")
    tray_template(44).save(assets / "trayTemplate@2x.png")
    app_icon(256).save(docs / "icon.png")
    app_icon(180, margin_ratio=0, radius_ratio=0.22).save(docs / "apple-touch-icon.png")

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        '<rect width="128" height="128" rx="29" fill="#2c6e5a"/>'
        f'<path d="{PATH_D}" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>'
        "</svg>\n"
    )
    (ROOT / "src/renderer/mark.svg").write_text(svg)
    (docs / "mark.svg").write_text(svg)
    print("Icons written.")


if __name__ == "__main__":
    main()
