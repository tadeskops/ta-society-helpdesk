"""Generate Hindi + Marathi language variants of the blue society stamp.

Outputs (mirroring the existing build-stamp.py naming convention):
  assets/images/TaStampBlue-hi.png          Hindi seal (100% opacity)
  assets/images/TaStampBlueOverlay-hi.png   Hindi seal at 65% opacity for receipts
  assets/images/TaStampBlue-mr.png          Marathi seal
  assets/images/TaStampBlueOverlay-mr.png   Marathi seal at 65% opacity
  docs/assets/images/*                       Same four files, copied for the site

Strategy: Devanagari needs proper text shaping (matra reordering, conjuncts).
PIL's FreeType text rendering does not run the OpenType shaping tables, so we
sidestep the problem by generating an SVG (browsers use HarfBuzz / DirectWrite
natively to shape Devanagari on <textPath>) and rasterising via Edge headless.

Prerequisites: Nirmala UI (bundled with Windows 8+), Microsoft Edge.
"""
from __future__ import annotations

import base64
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "images" / "TaLogo.png"
OUT_DIR = ROOT / "assets" / "images"
DOCS_DIR = ROOT / "docs" / "assets" / "images"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

SIZE = 800
INK = "#193E8A"
GOLD = "#C8A45E"
OVERLAY_ALPHA = 0.65

# ---- Translations -----------------------------------------------------------
# Both use the registered legal-style Devanagari phrasing.
# If the user wants a different wording (e.g. "आवास समिति" vs "गृह-निर्माण"), edit
# these two dicts and re-run the script.
TRANSLATIONS: dict[str, dict[str, str]] = {
    "hi": {
        "top": "\u0926 \u090f\u095c\u094d\u0930\u0947\u0938 \u0938\u0939\u0915\u093e\u0930\u0940 \u0917\u0943\u0939-\u0928\u093f\u0930\u094d\u092e\u093e\u0923 \u0938\u0902\u0938\u094d\u0925\u093e \u092e\u0930\u094d\u092f\u093e\u0926\u093f\u0924",  # द एड़्रेस सहकारी गृह-निर्माण संस्था मर्यादित
        "bottom": "\u092a\u0941\u0923\u0947-\u092c\u093e\u0923\u0947\u0930",  # पुणे-बाणेर
        "pin": "\u0921\u093e\u0915\u0918\u0930 411045",  # डाकघर 411045  (post office, common to Hindi + Marathi)
        "pin_size": 40,
    },
    "mr": {
        # Registered Maharashtra co-op housing society legal form
        "top": "\u0926 \u0972\u0921\u094d\u0930\u0947\u0938 \u0938\u0939\u0915\u093e\u0930\u0940 \u0917\u0943\u0939\u0930\u091a\u0928\u093e \u0938\u0902\u0938\u094d\u0925\u093e \u092e\u0930\u094d\u092f\u093e\u0926\u093f\u0924",  # द ॲड्रेस सहकारी गृहरचना संस्था मर्यादित
        "bottom": "\u092a\u0941\u0923\u0947-\u092c\u093e\u0923\u0947\u0930",  # पुणे-बाणेर
        "pin": "\u0921\u093e\u0915\u0918\u0930 411045",  # डाकघर 411045
        "pin_size": 40,
    },
}


def logo_data_url() -> str:
    """Base64-encoded original logo, ready to embed in the SVG."""
    b = LOGO.read_bytes()
    return "data:image/png;base64," + base64.b64encode(b).decode("ascii")


def build_svg(lang: str) -> str:
    """Return a full 800x800 SVG string for the requested language variant."""
    t = TRANSLATIONS[lang]
    logo_url = logo_data_url()

    # Font stack: Nirmala UI ships on Windows, Mangal/Aparajita are fallbacks.
    # `Noto Sans Devanagari` is the safest cross-platform fallback if the file
    # is ever re-rendered on Linux/macOS.
    dev_font = "'Nirmala UI','Noto Sans Devanagari','Mangal','Aparajita',sans-serif"
    lat_font = "'Arial Black','Arial',sans-serif"

    # Curved-text paths.
    # Top-text ascenders + Devanagari matras extend OUTWARD toward the outer
    # ring, so its baseline sits closer to the inner ring. Bottom-text matras
    # extend INWARD toward the inner ring, so its baseline sits closer to the
    # outer ring. Different radii per arc keep a comfortable gap on both sides.
    r_out = 385
    r_in = 300
    r_top_text = 322   # top-text baseline (matras reach outward ~40-46 px)
    r_bot_text = 366   # bottom-text baseline (matras reach inward ~48-56 px)

    p_top_start = (SIZE / 2 - r_top_text, SIZE / 2)
    p_top_end = (SIZE / 2 + r_top_text, SIZE / 2)
    top_arc = (
        f"M {p_top_start[0]},{p_top_start[1]} "
        f"A {r_top_text},{r_top_text} 0 0 1 {p_top_end[0]},{p_top_end[1]}"
    )
    p_bot_start = (SIZE / 2 - r_bot_text, SIZE / 2)
    p_bot_end = (SIZE / 2 + r_bot_text, SIZE / 2)
    bot_arc = (
        f"M {p_bot_start[0]},{p_bot_start[1]} "
        f"A {r_bot_text},{r_bot_text} 0 0 0 {p_bot_end[0]},{p_bot_end[1]}"
    )

    # Central logo box (roughly matches build-stamp.py LOGO_MAX=380 shifted up 30px).
    logo_size = 380
    logo_x = (SIZE - logo_size) / 2
    logo_y = (SIZE - logo_size) / 2 - 30

    # Stars at 9 o'clock and 3 o'clock, sitting exactly on the top-text arc
    # (horizontal centre-line, radius = r_top_text). They fill the small gap
    # between the ends of the top text and the ends of the bottom text.
    star_left = (SIZE / 2 - r_top_text, SIZE / 2)
    star_right = (SIZE / 2 + r_top_text, SIZE / 2)
    star_path = star_polygon_points(0, 0, r_out=18, r_in=8)

    # PIN caption sits just below the mandala logo, in gold.
    pin_y = logo_y + logo_size + 34

    top_size = 32 if lang in ("hi", "mr") else 40
    bot_size = 44 if lang in ("hi", "mr") else 48
    pin_size = int(t.get("pin_size", 34))

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}"
     viewBox="0 0 {SIZE} {SIZE}" font-family="{lat_font}">
  <defs>
    <path id="topArc" d="{top_arc}" fill="none"/>
    <path id="botArc" d="{bot_arc}" fill="none"/>
    <!-- Recolour the embedded logo into stamp indigo, using its luminance as
         the new alpha so the dark background drops out (bright gold pattern
         becomes opaque indigo, dark surround becomes transparent). Mirrors
         the tinting logic in scripts/build-stamp.py. -->
    <filter id="tintBlue" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="
        0 0 0 0 0.098
        0 0 0 0 0.243
        0 0 0 0 0.541
        0.299 0.587 0.114 0 0"/>
    </filter>
  </defs>

  <!-- Outer + inner rings -->
  <circle cx="{SIZE/2}" cy="{SIZE/2}" r="{r_out}" fill="none" stroke="{INK}" stroke-width="14"/>
  <circle cx="{SIZE/2}" cy="{SIZE/2}" r="{r_in}" fill="none" stroke="{INK}" stroke-width="6"/>

  <!-- Central blue-tinted mandala logo -->
  <image href="{logo_url}" x="{logo_x}" y="{logo_y}"
         width="{logo_size}" height="{logo_size}"
         preserveAspectRatio="xMidYMid meet"
         filter="url(#tintBlue)"/>

  <!-- Gold PIN caption under the mandala -->
  <text x="{SIZE/2}" y="{pin_y}" font-size="{pin_size}" font-weight="bold" fill="{GOLD}"
        text-anchor="middle" font-family="{dev_font}">{t['pin']}</text>

  <!-- Curved TOP text (Devanagari) -->
  <text font-size="{top_size}" font-weight="bold" fill="{INK}"
        font-family="{dev_font}" letter-spacing="1">
    <textPath href="#topArc" startOffset="50%" text-anchor="middle">{t['top']}</textPath>
  </text>

  <!-- Curved BOTTOM text (Devanagari) -->
  <text font-size="{bot_size}" font-weight="bold" fill="{INK}"
        font-family="{dev_font}" letter-spacing="4">
    <textPath href="#botArc" startOffset="50%" text-anchor="middle">{t['bottom']}</textPath>
  </text>

  <!-- Side stars at 9 and 3 o'clock -->
  <g fill="{INK}">
    <polygon points="{star_path}" transform="translate({star_left[0]},{star_left[1]})"/>
    <polygon points="{star_path}" transform="translate({star_right[0]},{star_right[1]})"/>
  </g>
</svg>
"""


def star_polygon_points(cx: float, cy: float, r_out: float, r_in: float) -> str:
    """Return a 10-point star-polygon string for SVG <polygon points="...">."""
    import math

    pts = []
    for i in range(10):
        r = r_out if i % 2 == 0 else r_in
        theta = math.radians(-90 + i * 36)
        pts.append(f"{cx + r*math.cos(theta):.1f},{cy + r*math.sin(theta):.1f}")
    return " ".join(pts)


def render_svg_to_png(svg_path: Path, png_path: Path) -> None:
    """Rasterise ``svg_path`` to ``png_path`` at ``SIZE`` x ``SIZE`` via Edge headless."""
    if not EDGE.exists():
        raise RuntimeError(f"Microsoft Edge not found at {EDGE}")
    args = [
        str(EDGE),
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--default-background-color=00000000",  # transparent
        f"--screenshot={png_path}",
        f"--window-size={SIZE},{SIZE}",
        "--force-device-scale-factor=1",
        svg_path.resolve().as_uri(),
    ]
    subprocess.run(args, check=True, timeout=90)


def make_overlay(src: Path, dst: Path, alpha: float = OVERLAY_ALPHA) -> None:
    """Copy ``src`` to ``dst`` at ``alpha`` (0..1) opacity."""
    im = Image.open(src).convert("RGBA")
    r, g, b, a = im.split()
    a = a.point(lambda v: int(v * alpha))
    Image.merge("RGBA", (r, g, b, a)).save(dst, format="PNG", optimize=True)


def main() -> int:
    if not LOGO.exists():
        print(f"ERROR: {LOGO} not found", file=sys.stderr)
        return 1
    if not EDGE.exists():
        print(f"ERROR: Edge not found at {EDGE}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    tmp = OUT_DIR / "_tmp_stamp"
    tmp.mkdir(exist_ok=True)

    try:
        for lang in ("hi", "mr"):
            svg_path = tmp / f"TaStampBlue-{lang}.svg"
            png_path = OUT_DIR / f"TaStampBlue-{lang}.png"
            overlay_path = OUT_DIR / f"TaStampBlueOverlay-{lang}.png"

            svg_path.write_text(build_svg(lang), encoding="utf-8")
            print(f"Wrote SVG {svg_path.relative_to(ROOT)}")

            render_svg_to_png(svg_path, png_path)
            print(f"Wrote PNG {png_path.relative_to(ROOT)} ({png_path.stat().st_size:,} bytes)")

            make_overlay(png_path, overlay_path)
            print(f"Wrote PNG {overlay_path.relative_to(ROOT)} ({overlay_path.stat().st_size:,} bytes, {int(OVERLAY_ALPHA*100)}% opacity)")

            # Mirror both variants into docs/ so the site can serve them.
            for src in (png_path, overlay_path):
                dst = DOCS_DIR / src.name
                shutil.copyfile(src, dst)
                print(f"Copied  -> {dst.relative_to(ROOT)}")
    finally:
        # Keep the SVGs around for inspection; they are tiny and useful.
        pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
