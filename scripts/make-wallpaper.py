"""Make the soft wallpapers behind the glass chrome. Optional asset tool; needs Pillow.

python3 -B scripts/make-wallpaper.py
- src/assets/wallpaper.png: the coast banner as a blurred colour field (card style).
- src/assets/sky.png: a pale sky with drifting clouds (glass style), drawn procedurally.
Both are tiny and heavily blurred: browsers upscale them smoothly, so each costs a few KB.
"""
from pathlib import Path
import sys
import random
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

root = Path(__file__).resolve().parents[1]
out = root / 'src/assets/wallpaper.png'
photo = Image.open(root / 'src/assets/coast-header.png').convert('RGB')
# 16:10 crop centred on the horizon: sky above, sea below, the warm coast at the right.
w, h = photo.size
crop_h = h
crop_w = min(w, round(crop_h * 1.6))
left = w - crop_w
field = photo.crop((left, 0, left + crop_w, crop_h)).resize((64, 40), Image.LANCZOS)
field = ImageEnhance.Color(field).enhance(1.35)
field = field.filter(ImageFilter.GaussianBlur(3.2))
field.save(out, optimize=True)
print(out, field.size, out.stat().st_size, 'bytes')

# Sky: a vertical blue gradient, then soft white cloud banks; fixed seed keeps the asset stable.
W, H = 96, 60
sky = Image.new('RGB', (W, H))
top, bottom = (118, 168, 222), (214, 230, 245)
for y in range(H):
    t = y / (H - 1)
    sky.paste(tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)), (0, y, W, y + 1))
clouds = Image.new('L', (W, H), 0)
draw = ImageDraw.Draw(clouds)
rng = random.Random(7)
for _ in range(26):
    cx, cy = rng.uniform(-8, W + 8), rng.uniform(H * .25, H * 1.05)
    rx, ry = rng.uniform(8, 22), rng.uniform(3, 8)
    draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=rng.randint(120, 235))
clouds = clouds.filter(ImageFilter.GaussianBlur(4.5))
sky = Image.composite(Image.new('RGB', (W, H), (250, 252, 255)), sky, clouds).filter(ImageFilter.GaussianBlur(1.2))
sky_out = root / 'src/assets/sky.png'
sky.save(sky_out, optimize=True)
print(sky_out, sky.size, sky_out.stat().st_size, 'bytes')
