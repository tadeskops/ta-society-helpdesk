"""Emit a fully-editable draw.io mirror of TaStampBlue.png.

Output: assets/images/TaStampBlue.drawio

The layout constants and math are copied from build-stamp.py so the two files
stay visually identical. Every element becomes its own mxCell so you can:
  - Double-click any letter to change it (rotation stays).
  - Drag the centre logo to resize / move it.
  - Recolour rings or stars in the Style sidebar (Fill & Line).
  - Delete individual glyphs if you want to shorten a text ring.

Run:
  python .\\scripts\\build-stamp-drawio.py
"""
from __future__ import annotations

import base64
import math
import sys
import xml.sax.saxutils as sx
from pathlib import Path

from PIL import ImageFont

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "images" / "TaLogo.png"
OUT  = ROOT / "assets" / "images" / "TaStampBlue.drawio"

# ---- geometry (mirrors build-stamp.py) -----------------------------
PAGE   = 850                    # add 25 px margin around 800 px stamp
CX = CY = PAGE // 2             # centre in page coords
OUTER_R = 385
INNER_R = 300                   # wider band for taller text
TEXT_TOP_R = 335                # gap under outer ring, closer to inner
LOGO_MAX = 380                  # matches the PNG generator
LOGO_Y_SHIFT = 30               # nudge the logo up to make room for PIN caption
INK = "#193E8A"
GOLD = "#C8A45E"                # matches the TaLogo gold theme
PIN_TEXT = "PIN 411045"
PIN_FSIZE = 34
STAR_GAP_DEG = 6                # angular gap between text endpoint and star
STAR_SIZE = 46

TOP_TEXT   = "THE ADDRESS CO-OPERATIVE HOUSING SOCIETY LTD."
TOP_FSIZE  = 40
TOP_SPACE  = 1
BOT_TEXT   = "PUNE-BANER"
BOT_FSIZE  = 56
BOT_SPACE  = 6


def find_font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\calibrib.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def ellipse_cell(cid: int, radius: int, stroke: int) -> str:
    x = CX - radius
    y = CY - radius
    d = radius * 2
    style = (
        f"ellipse;whiteSpace=wrap;html=1;fillColor=none;"
        f"strokeColor={INK};strokeWidth={stroke};"
    )
    return (
        f'<mxCell id="e{cid}" value="" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{d}" height="{d}" as="geometry"/>'
        f"</mxCell>"
    )


def star_cell(cid: int, cx: int, cy: int, size: int) -> str:
    # Use the Unicode BLACK STAR (U+2605) as a text glyph so the .drawio
    # file has zero external stencil dependencies. Editable via double-click
    # if you want to swap it for a different marker.
    x = cx - size // 2
    y = cy - size // 2
    style = (
        "text;html=1;strokeColor=none;fillColor=none;align=center;"
        f"verticalAlign=middle;fontSize={size};fontColor={INK};"
    )
    return (
        f'<mxCell id="s{cid}" value="\u2605" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{size}" height="{size}" as="geometry"/>'
        f"</mxCell>"
    )


def glyph_cell(
    cid: str,
    ch: str,
    cx: float,
    cy: float,
    rot_deg: float,
    font_size: int,
    box_w: int,
    box_h: int,
) -> str:
    """Emit one letter as a rotated text cell centred on (cx, cy)."""
    x = cx - box_w / 2
    y = cy - box_h / 2
    val = sx.escape(ch)
    # draw.io rotation is clockwise; our maths convention is CCW, so flip sign.
    style = (
        f"text;html=1;strokeColor=none;fillColor=none;align=center;"
        f"verticalAlign=middle;whiteSpace=wrap;rounded=0;"
        f"fontSize={font_size};fontStyle=1;fontColor={INK};"
        f"rotation={-rot_deg:.2f};"
    )
    return (
        f'<mxCell id="{cid}" value="{val}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x:.2f}" y="{y:.2f}" '
        f'width="{box_w}" height="{box_h}" as="geometry"/>'
        f"</mxCell>"
    )


def curved_text_cells(
    text: str,
    *,
    prefix: str,
    radius: int,
    font_size: int,
    letter_spacing_px: int,
    start_angle_deg: float,
    clockwise: bool,
) -> list[str]:
    """Lay text along a circle, one rotated cell per glyph."""
    font = find_font(font_size)
    widths = [font.getbbox(ch)[2] - font.getbbox(ch)[0] for ch in text]

    angle_rad = math.radians(start_angle_deg)
    direction = -1 if clockwise else 1
    cells: list[str] = []
    for i, (ch, w) in enumerate(zip(text, widths)):
        step_rad = (w + letter_spacing_px) / radius
        anchor = angle_rad + direction * (step_rad / 2)
        gx = CX + radius * math.cos(anchor)
        gy = CY - radius * math.sin(anchor)   # y grows down in draw.io too
        # tangent orientation, top of glyph faces outward from centre
        if clockwise:
            rot_deg = math.degrees(anchor) - 90
        else:
            rot_deg = math.degrees(anchor) + 90

        # Give each glyph a snug bounding box so rotation pivots correctly.
        box_w = max(w + 6, font_size)
        box_h = int(font_size * 1.4)
        cells.append(glyph_cell(f"{prefix}{i:02d}", ch, gx, gy, rot_deg, font_size, box_w, box_h))
        angle_rad += direction * step_rad
    return cells


def logo_cell(cid: int) -> str:
    """Embed the centre logo as a base64 data URI so the .drawio file is self-contained."""
    data = base64.b64encode(LOGO.read_bytes()).decode("ascii")
    x = CX - LOGO_MAX // 2
    y = CY - LOGO_MAX // 2 - LOGO_Y_SHIFT
    style = (
        "shape=image;imageAspect=1;aspect=fixed;html=1;"
        f"image=data:image/png,{data};"
    )
    return (
        f'<mxCell id="logo{cid}" value="" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" '
        f'width="{LOGO_MAX}" height="{LOGO_MAX}" as="geometry"/>'
        "</mxCell>"
    )


def pin_cell(cid: int) -> str:
    """Gold PIN caption sitting directly under the centre logo."""
    w, h = 260, 44
    x = CX - w // 2
    y = CY - LOGO_MAX // 2 - LOGO_Y_SHIFT + LOGO_MAX + 6
    style = (
        "text;html=1;strokeColor=none;fillColor=none;align=center;"
        f"verticalAlign=middle;fontSize={PIN_FSIZE};fontStyle=1;fontColor={GOLD};"
    )
    return (
        f'<mxCell id="pin{cid}" value="{sx.escape(PIN_TEXT)}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>'
        f"</mxCell>"
    )


def build() -> str:
    cells: list[str] = [
        '<mxCell id="0"/>',
        '<mxCell id="1" parent="0"/>',
        ellipse_cell(1, OUTER_R, 14),
        ellipse_cell(2, INNER_R, 6),
    ]

    # Top text — centred at 12 o'clock, sweeps clockwise across the top arc.
    top_font = find_font(TOP_FSIZE)
    top_arc_px = sum((top_font.getbbox(c)[2] - top_font.getbbox(c)[0]) + TOP_SPACE for c in TOP_TEXT)
    top_arc_rad = top_arc_px / TEXT_TOP_R
    top_start = 90 + math.degrees(top_arc_rad / 2)
    cells.extend(curved_text_cells(
        TOP_TEXT,
        prefix="t",
        radius=TEXT_TOP_R,
        font_size=TOP_FSIZE,
        letter_spacing_px=TOP_SPACE,
        start_angle_deg=top_start,
        clockwise=True,
    ))

    # Bottom text — centred at 6 o'clock, reads left-to-right along lower arc.
    bot_font = find_font(BOT_FSIZE)
    bot_arc_px = sum((bot_font.getbbox(c)[2] - bot_font.getbbox(c)[0]) + BOT_SPACE for c in BOT_TEXT)
    bot_arc_rad = bot_arc_px / TEXT_TOP_R
    bot_start = 270 - math.degrees(bot_arc_rad / 2)
    cells.extend(curved_text_cells(
        BOT_TEXT,
        prefix="b",
        radius=TEXT_TOP_R,
        font_size=BOT_FSIZE,
        letter_spacing_px=BOT_SPACE,
        start_angle_deg=bot_start,
        clockwise=False,
    ))

    # Star separators anchored to the endpoints of the top text arc so they
    # always follow whatever sentence the top ring carries (edit TOP_TEXT
    # and the stars still land just outside the first and last glyph).
    top_half_arc_deg = math.degrees(top_arc_rad / 2)
    for edge_deg in (top_start + STAR_GAP_DEG, 90 - top_half_arc_deg - STAR_GAP_DEG):
        theta = math.radians(edge_deg)
        sx_px = int(CX + TEXT_TOP_R * math.cos(theta))
        sy_px = int(CY - TEXT_TOP_R * math.sin(theta))
        cells.append(star_cell(len(cells), sx_px, sy_px, size=STAR_SIZE))

    # Centre logo last so it sits on top of the rings.
    cells.append(logo_cell(1))
    cells.append(pin_cell(1))

    body = "\n        ".join(cells)
    xml = (
        '<mxfile host="Electron" version="24.0.0" type="device">\n'
        '  <diagram name="TaStampBlue" id="stamp">\n'
        f'    <mxGraphModel dx="1000" dy="800" grid="1" gridSize="10" guides="1" '
        f'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        f'pageWidth="{PAGE}" pageHeight="{PAGE}" math="0" shadow="0">\n'
        "      <root>\n"
        f"        {body}\n"
        "      </root>\n"
        "    </mxGraphModel>\n"
        "  </diagram>\n"
        "</mxfile>\n"
    )
    return xml


def main() -> int:
    if not LOGO.exists():
        print(f"ERROR: {LOGO} not found", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build(), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
