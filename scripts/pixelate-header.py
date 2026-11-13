"""Derive the pixel-art header from the coastal photograph. Optional asset tool; needs Pillow.

python3 -B scripts/pixelate-header.py [width] [colors] [output]
The build itself stays standard-library only and just embeds the committed PNG.
"""
from pathlib import Path
import sys
from PIL import Image, ImageEnhance

root = Path(__file__).resolve().parents[1]
width = int(sys.argv[1]) if len(sys.argv) > 1 else 420
colors = int(sys.argv[2]) if len(sys.argv) > 2 else 32
out = Path(sys.argv[3]) if len(sys.argv) > 3 else root / 'src/assets/coast-header-pixel.png'
# 4x4 Bayer matrix, centred on zero: ordered dither gives the regular halftone grain.
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

photo = Image.open(root / 'src/assets/coast-header.png').convert('RGB')
small = photo.resize((width, round(photo.height * width / photo.width)), Image.LANCZOS)
# Slightly richer colour so the small palette keeps warm stone and sky blue apart.
small = ImageEnhance.Contrast(ImageEnhance.Color(small).enhance(1.25)).enhance(1.06)
spread = 28
px = small.load()
for y in range(small.height):
    for x in range(small.width):
        bias = (BAYER[y % 4][x % 4] / 16 - .5) * spread
        r, g, b = px[x, y]
        px[x, y] = tuple(max(0, min(255, round(c + bias))) for c in (r, g, b))
art = small.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
art.save(out, optimize=True)
print(out, art.size, out.stat().st_size, 'bytes')
