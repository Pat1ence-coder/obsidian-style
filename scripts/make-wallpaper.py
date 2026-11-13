"""Derive the soft window wallpaper behind the glass chrome. Optional asset tool; needs Pillow.

python3 -B scripts/make-wallpaper.py [output]
A tiny, heavily blurred colour field: browsers upscale it smoothly, so it costs a few KB.
"""
from pathlib import Path
import sys
from PIL import Image, ImageEnhance, ImageFilter

root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'src/assets/wallpaper.png'
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
