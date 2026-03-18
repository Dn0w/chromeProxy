#!/usr/bin/env python3
"""
setup.py — Generate extension icons for Chrome Proxy.
Run once before loading the extension in Chrome.

Usage: python3 setup.py
"""

import os
import struct
import zlib

ICON_DIR = os.path.join(os.path.dirname(__file__), "extension", "icons")


def make_png(size: int, r: int, g: int, b: int) -> bytes:
    """Create a minimal solid-color PNG using only stdlib."""

    def chunk(name: bytes, data: bytes) -> bytes:
        body = name + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    # Draw a rounded-square shape: proxy shield icon
    pixels = []
    cx, cy, rad = size / 2, size / 2, size * 0.42

    for y in range(size):
        row = []
        for x in range(size):
            # Rounded rectangle mask
            rx = abs(x - cx) - rad * 0.65
            ry = abs(y - cy) - rad * 0.65
            corner_r = rad * 0.35
            if rx > corner_r or ry > corner_r:
                inside = False
            elif rx > 0 and ry > 0:
                inside = (rx ** 2 + ry ** 2) <= corner_r ** 2
            else:
                inside = rx <= 0 or ry <= 0
                inside = inside and abs(x - cx) <= rad and abs(y - cy) <= rad

            if inside:
                # Slight gradient: brighter at top-left
                factor = 1.0 - 0.25 * ((x / size) + (y / size)) / 2
                pr = min(255, int(r * factor))
                pg = min(255, int(g * factor))
                pb = min(255, int(b * factor))
                row += [pr, pg, pb, 255]
            else:
                row += [0, 0, 0, 0]
        pixels.append(row)

    # Add a small dot/circle in the center (status indicator feel)
    dot_r = max(2, size // 8)
    for y in range(size):
        for x in range(size):
            if (x - cx) ** 2 + (y - cy) ** 2 <= dot_r ** 2:
                idx_x = x
                pixels[y][idx_x * 4 + 0] = 255
                pixels[y][idx_x * 4 + 1] = 255
                pixels[y][idx_x * 4 + 2] = 255
                pixels[y][idx_x * 4 + 3] = 220

    raw = b""
    for row in pixels:
        raw += b"\x00" + bytes(row)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA
    ihdr = chunk(b"IHDR", ihdr_data)
    idat = chunk(b"IDAT", zlib.compress(raw, 9))
    iend = chunk(b"IEND", b"")
    return signature + ihdr + idat + iend


def main():
    os.makedirs(ICON_DIR, exist_ok=True)

    # Teal/blue color matching the extension theme
    R, G, B = 56, 189, 248  # #38bdf8

    for size in (16, 48, 128):
        path = os.path.join(ICON_DIR, f"icon{size}.png")
        data = make_png(size, R, G, B)
        with open(path, "wb") as f:
            f.write(data)
        print(f"  Created {path} ({len(data)} bytes)")

    print("\n  Icons generated! You can now load the extension in Chrome.")
    print("  Then run:  cd native_host && ./install.sh <EXTENSION_ID>")


if __name__ == "__main__":
    main()
