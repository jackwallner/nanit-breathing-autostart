#!/usr/bin/env python3
"""Turns the e2e test's window captures (BA_SHOTS) into the landing page's screenshots: adds
the macOS window buttons the capture can't see and rounds the corners.

    BA_SHOTS=/tmp/shots npm run test:app && python3 scripts/frame-shots.py /tmp/shots
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "docs/assets"
NAMES = {"1-sign-in": "screenshot-sign-in", "3-ready": "screenshot-ready", "4-monitoring": "screenshot-monitoring", "5-settings": "screenshot-settings"}
BUTTONS = [(20, (255, 95, 87)), (40, (254, 188, 46)), (60, (40, 200, 64))]


def frame(src: Path, dest: Path) -> None:
    image = Image.open(src).convert("RGBA")
    s = image.width / 420
    draw = ImageDraw.Draw(image)
    for x, colour in BUTTONS:
        r = 6 * s
        cx, cy = x * s, 24 * s
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colour + (255,))
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, image.width - 1, image.height - 1], radius=int(12 * s), fill=255)
    image.putalpha(mask)
    image.save(dest, optimize=True)


def main() -> int:
    shots = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    for name, out in NAMES.items():
        frame(shots / f"{name}.png", OUT / f"{out}.png")
        print(f"{out}.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
