#!/usr/bin/env python3
"""Build a printable grayscale 3x3 checklist PDF for one Pokémon TCG set.

Cards are pulled from the Pokémon TCG API and drawn at true size (2.5 x 3.5 in),
nine to a US Letter page, in set order. Print it, then color or mark off the cards
you own.

    pip install pillow reportlab
    python3 scripts/printable_grid.py me55 "30th Celebration"

Output: <set_id>_grayscale.pdf in the current directory (override with -o).
Images are cached in ./.printable-cache/<set_id>/ so re-runs are fast.
For personal use only. Card art belongs to its owners.
"""
import argparse
import io
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

API = "https://api.pokemontcg.io/v2"
PAGE_W, PAGE_H = 8.5 * inch, 11 * inch
CARD_W, CARD_H = 2.5 * inch, 3.5 * inch
COLS = ROWS = 3
GAP = 0.06 * inch
CARD_PX_W = 600


def get(url, tries=4):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tcg-set-builder"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry any network failure
            last = e
    raise RuntimeError(f"GET {url} failed: {last}")


def sort_key(card):
    """Numbered cards in order, then lettered ones (B, G, R) by letter."""
    n = card["number"]
    m = re.match(r"\d+", n)
    return (0, int(m.group()), n) if m else (1, 0, n)


def fetch_cards(set_id):
    url = f"{API}/cards?q=set.id:{set_id}&pageSize=250&select=id,name,number,images"
    cards = json.loads(get(url))["data"]
    return sorted(cards, key=sort_key)


def grayscale_jpeg(card, cache_dir):
    path = os.path.join(cache_dir, card["id"] + ".jpg")
    if os.path.exists(path):
        return path
    img = Image.open(io.BytesIO(get(card["images"]["large"]))).convert("RGBA")
    flat = Image.new("RGBA", img.size, (255, 255, 255, 255))  # square off transparent corners
    flat.alpha_composite(img)
    gray = flat.convert("L")
    gray.thumbnail((CARD_PX_W, CARD_PX_W * 7 // 5), Image.LANCZOS)  # ~240 dpi at print size
    gray.save(path, "JPEG", quality=85, optimize=True)
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("set_id", help="API set id, e.g. me55")
    ap.add_argument("title", nargs="?", default=None, help="only used in the PDF metadata")
    ap.add_argument("-o", "--output", default=None)
    ap.add_argument("--cache", default=".printable-cache")
    args = ap.parse_args()

    out = args.output or f"{args.set_id}_grayscale.pdf"
    cache_dir = os.path.join(args.cache, args.set_id)
    os.makedirs(cache_dir, exist_ok=True)

    cards = fetch_cards(args.set_id)
    if not cards:
        sys.exit(f"No cards found for set '{args.set_id}'.")
    print(f"{len(cards)} cards, {-(-len(cards) // (COLS * ROWS))} pages", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda c: grayscale_jpeg(c, cache_dir), cards))

    grid_w = COLS * CARD_W + (COLS - 1) * GAP
    grid_h = ROWS * CARD_H + (ROWS - 1) * GAP
    x0 = (PAGE_W - grid_w) / 2
    y_top = PAGE_H - (PAGE_H - grid_h) / 2

    c = canvas.Canvas(out, pagesize=(PAGE_W, PAGE_H))
    c.setTitle(f"{args.title or args.set_id} printable grid")
    per_page = COLS * ROWS
    for i, path in enumerate(paths):
        slot = i % per_page
        if i and slot == 0:
            c.showPage()
        col, row = slot % COLS, slot // COLS
        x = x0 + col * (CARD_W + GAP)
        y = y_top - (row + 1) * CARD_H - row * GAP
        c.drawImage(ImageReader(path), x, y, CARD_W, CARD_H)
    c.save()
    print(f"Wrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
