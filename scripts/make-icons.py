"""Écho's launcher icons and splash screens: sodium rings on indigo night.
Run: python3 scripts/make-icons.py  (needs Pillow)"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
NIGHT = (26, 24, 56, 255)      # #1a1838
SODIUM = (242, 193, 78)         # #f2c14e

def rings(size, scale=1.0):
    """The echo: a dot, then rings fading out. Drawn at 4x and reduced."""
    S = size * 4
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    unit = S * scale / 2
    for r, w, a in [(0.92, 0.075, 90), (0.68, 0.085, 160), (0.44, 0.095, 235)]:
        R = unit * r
        d.ellipse((c - R, c - R, c + R, c + R), outline=SODIUM + (a,), width=max(1, int(unit * w)))
    R = unit * 0.2
    d.ellipse((c - R, c - R, c + R, c + R), fill=SODIUM + (255,))
    return img.resize((size, size), Image.LANCZOS)

def icon(size, round_=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    m = Image.new('L', (size * 4, size * 4), 0)
    md = ImageDraw.Draw(m)
    if round_: md.ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    else: md.rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=size * 4 * 0.22, fill=255)
    bg = Image.new('RGBA', (size, size), NIGHT)
    img.paste(bg, (0, 0), m.resize((size, size), Image.LANCZOS))
    r = rings(size, 0.74)
    img.alpha_composite(r)
    return img

densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in densities.items():
    d = os.path.join(RES, f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    icon(int(48 * k)).save(os.path.join(d, 'ic_launcher.png'))
    icon(int(48 * k), True).save(os.path.join(d, 'ic_launcher_round.png'))
    fg = int(108 * k)  # adaptive: 108dp canvas, art inside the 66dp safe zone
    rings(fg, 0.6).save(os.path.join(d, 'ic_launcher_foreground.png'))

os.makedirs(os.path.join(RES, 'mipmap-anydpi-v26'), exist_ok=True)
for n in ('ic_launcher', 'ic_launcher_round'):
    with open(os.path.join(RES, 'mipmap-anydpi-v26', n + '.xml'), 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n')
with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1A1838</color>\n</resources>\n')

# Splash (before Android 12): the rings centred on the night background.
for folder, (w, h) in {'drawable': (480, 320), 'drawable-port-mdpi': (320, 480), 'drawable-port-hdpi': (480, 800), 'drawable-port-xhdpi': (720, 1280), 'drawable-port-xxhdpi': (960, 1600), 'drawable-port-xxxhdpi': (1280, 1920), 'drawable-land-mdpi': (480, 320), 'drawable-land-hdpi': (800, 480), 'drawable-land-xhdpi': (1280, 720), 'drawable-land-xxhdpi': (1600, 960), 'drawable-land-xxxhdpi': (1920, 1280)}.items():
    os.makedirs(os.path.join(RES, folder), exist_ok=True)
    splash = Image.new('RGBA', (w, h), NIGHT)
    r = rings(int(min(w, h) * 0.3))
    splash.alpha_composite(r, ((w - r.width) // 2, (h - r.height) // 2))
    splash.convert('RGB').save(os.path.join(RES, folder, 'splash.png'))

# The app's own icon, for the README.
icon(512).save(os.path.join(ROOT, 'app', 'public', 'icon.png')) if os.path.isdir(os.path.join(ROOT, 'app', 'public')) else None
print('icons written')
