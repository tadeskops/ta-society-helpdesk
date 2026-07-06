"""Generate the blue official stamp image used on confirmed reservation receipts.

Output: assets/images/TaStampBlue.png (800x800, transparent background).

Composition, from outermost inward:
  1. Blue outer ring (2 concentric strokes).
  2. Curved top text  : "THE ADDRESS CO-OPERATIVE HOUSING SOCIETY LTD."
  3. Curved bottom text: "OFFICIAL SEAL"
  4. Star glyph markers at the 9 and 3 o'clock positions.
  5. Central logo    : assets/images/TaLogo.png recoloured to the same blue.

Run:
  python .\scripts\build-stamp.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "images" / "TaLogo.png"
OUT  = ROOT / "assets" / "images" / "TaStampBlue.png"

SIZE = 800                              # square canvas
CX = CY = SIZE // 2
INK = (25, 62, 138, 255)                # official-stamp indigo blue
INK_SOFT = (25, 62, 138, 230)

OUTER_R = 380                           # outer ring radius
INNER_R = 340                           # inner ring radius
TEXT_TOP_R = (OUTER_R + INNER_R) // 2   # baseline radius for curved text band
LOGO_MAX = 340                          # bounding box for centred logo


def find_font(size: int) -> ImageFont.FreeTypeFont:
    """Return a bold sans-serif face if available, else PIL default."""
    candidates = [
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\ARIALBD.TTF",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\calibrib.ttf",
        r"C:\Windows\Fonts\verdanab.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_curved_text(
    canvas: Image.Image,
    text: str,
    *,
    radius: int,
    font: ImageFont.FreeTypeFont,
    fill,
    start_angle_deg: float,
    clockwise: bool = True,
    letter_spacing_px: int = 4,
) -> None:
    """Lay ``text`` along a circle of ``radius`` centred on the canvas.

    ``start_angle_deg`` is measured from the +X axis (3 o'clock) growing CCW,
    matching the usual maths convention. Each glyph is rendered onto its own
    scratch image, rotated to face outward, then pasted onto ``canvas`` using
    alpha compositing so anti-aliased edges stay clean.
    """
    # Work out the angular width of each glyph so we can advance one at a time.
    total_arc_px = 0
    widths: list[int] = []
    for ch in text:
        bbox = font.getbbox(ch)
        w = bbox[2] - bbox[0]
        widths.append(w)
        total_arc_px += w + letter_spacing_px

    # Pixel width -> radians on our circle (arc = radius * theta).
    angle_rad = math.radians(start_angle_deg)
    direction = -1 if clockwise else 1

    for ch, w in zip(text, widths):
        step_rad = (w + letter_spacing_px) / radius
        # Anchor angle sits at the glyph centre, so advance half a step first.
        anchor = angle_rad + direction * (step_rad / 2)
        x = CX + radius * math.cos(anchor)
        y = CY - radius * math.sin(anchor)   # PIL y grows downward

        # Rotate so the glyph baseline sits tangent to the circle with the
        # top of the character pointing outward from the centre.
        if clockwise:
            rot_deg = math.degrees(anchor) - 90
        else:
            rot_deg = math.degrees(anchor) + 90

        # Render this single glyph onto a small transparent tile.
        bbox = font.getbbox(ch)
        gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad = 6
        tile_w, tile_h = gw + pad * 2, gh + pad * 2
        tile = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
        td = ImageDraw.Draw(tile)
        td.text((pad - bbox[0], pad - bbox[1]), ch, font=font, fill=fill)

        rotated = tile.rotate(rot_deg, resample=Image.BICUBIC, expand=True)
        rw, rh = rotated.size
        canvas.alpha_composite(rotated, (int(x - rw / 2), int(y - rh / 2)))

        angle_rad += direction * step_rad


def draw_star(draw: ImageDraw.ImageDraw, cx: int, cy: int, r_out: int, r_in: int, fill) -> None:
    """Draw a filled 5-point star centred on (cx, cy)."""
    pts = []
    for i in range(10):
        r = r_out if i % 2 == 0 else r_in
        # Start at the top of the star (12 o'clock).
        theta = math.radians(-90 + i * 36)
        pts.append((cx + r * math.cos(theta), cy + r * math.sin(theta)))
    draw.polygon(pts, fill=fill)


def blue_tinted_logo(source: Path, max_dim: int) -> Image.Image:
    """Load the gold logo and remap its opaque pixels to the stamp blue."""
    src = Image.open(source).convert("RGBA")
    # Contain within max_dim x max_dim keeping aspect ratio.
    src.thumbnail((max_dim, max_dim), Image.LANCZOS)

    px = src.load()
    w, h = src.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            # Treat luminance as opacity ramp: dark pixels stay transparent,
            # bright pixels become opaque blue. This preserves the original
            # geometric pattern regardless of whether it was gold-on-black
            # or already had an alpha mask.
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if lum < 40:
                px[x, y] = (0, 0, 0, 0)
            else:
                # Scale alpha by luminance so gradients stay smooth.
                new_a = int(min(255, lum * 1.05))
                px[x, y] = (INK[0], INK[1], INK[2], new_a)
    return src


def main() -> int:
    if not LOGO.exists():
        print(f"ERROR: {LOGO} not found", file=sys.stderr)
        return 1

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # ---- outer + inner ring ----------------------------------------
    for radius, width in ((OUTER_R, 8), (INNER_R, 3)):
        bbox = (CX - radius, CY - radius, CX + radius, CY + radius)
        draw.ellipse(bbox, outline=INK, width=width)

    # ---- curved top text -------------------------------------------
    top_font = find_font(34)
    # Start slightly past 9 o'clock (180 deg) sweeping clockwise across the
    # top of the ring. The text is centred by choosing the starting angle so
    # its midpoint lands at 12 o'clock (90 deg).
    top_text = "THE ADDRESS CO-OPERATIVE HOUSING SOCIETY LTD."
    total_arc = sum((top_font.getbbox(c)[2] - top_font.getbbox(c)[0]) + 4 for c in top_text)
    arc_rad = total_arc / TEXT_TOP_R
    start_top = 90 + math.degrees(arc_rad / 2)   # centred at 12 o'clock
    draw_curved_text(
        canvas,
        top_text,
        radius=TEXT_TOP_R,
        font=top_font,
        fill=INK,
        start_angle_deg=start_top,
        clockwise=True,
        letter_spacing_px=4,
    )

    # ---- curved bottom text ----------------------------------------
    bot_font = find_font(38)
    bot_text = "OFFICIAL SEAL"
    total_arc_b = sum((bot_font.getbbox(c)[2] - bot_font.getbbox(c)[0]) + 6 for c in bot_text)
    arc_rad_b = total_arc_b / TEXT_TOP_R
    # Bottom text reads left-to-right along the lower arc, so we render
    # counter-clockwise starting to the left of 6 o'clock (270 deg).
    start_bot = 270 - math.degrees(arc_rad_b / 2)
    draw_curved_text(
        canvas,
        bot_text,
        radius=TEXT_TOP_R,
        font=bot_font,
        fill=INK,
        start_angle_deg=start_bot,
        clockwise=False,
        letter_spacing_px=6,
    )

    # ---- side star separators --------------------------------------
    for side_deg in (0, 180):   # 3 o'clock and 9 o'clock
        theta = math.radians(side_deg)
        sx = int(CX + TEXT_TOP_R * math.cos(theta))
        sy = int(CY - TEXT_TOP_R * math.sin(theta))
        draw_star(draw, sx, sy, r_out=18, r_in=8, fill=INK)

    # ---- central blue-tinted logo ----------------------------------
    logo = blue_tinted_logo(LOGO, LOGO_MAX)
    lw, lh = logo.size
    canvas.alpha_composite(logo, (CX - lw // 2, CY - lh // 2))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, format="PNG", optimize=True)
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
