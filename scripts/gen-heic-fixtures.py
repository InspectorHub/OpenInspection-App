#!/usr/bin/env python3
"""Regenerate the synthetic HEIC regression fixtures (developer-only)."""

from __future__ import annotations

import argparse
import binascii
import struct
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path
import zlib

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "src" / "media" / "heic" / "fixtures"


def png_chunk(kind: bytes, data: bytes) -> bytes:
    checksum = binascii.crc32(kind + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)


def save_rgb16_png(path: Path, width: int, height: int, color_at, exif: bytes | None = None) -> None:
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # PNG filter: None.
        for x in range(width):
            rows.extend(struct.pack(">HHH", *color_at(x, y)))

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png.extend(png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 16, 2, 0, 0, 0)))
    if exif:
        png.extend(png_chunk(b"eXIf", exif))
    png.extend(png_chunk(b"IDAT", zlib.compress(rows, level=9)))
    png.extend(png_chunk(b"IEND", b""))
    path.write_bytes(png)


def save_grid_png(path: Path) -> None:
    colors = ((65535, 0, 0), (0, 65535, 0), (0, 0, 65535), (65535, 50000, 0))
    save_rgb16_png(path, 128, 96, lambda x, y: colors[int(x >= 64) + 2 * int(y >= 48)])


def save_10bit_png(path: Path) -> None:
    save_rgb16_png(path, 64, 48, lambda x, y: (round(x * 65535 / 63), round(y * 65535 / 47), 24000))


def save_gps_png(path: Path) -> None:
    exif = Image.Exif()
    exif[0x010E] = "Synthetic GPS fixture"
    exif[34853] = {
        1: "N",
        2: (Fraction(37), Fraction(46), Fraction(3)),
        3: "W",
        4: (Fraction(122), Fraction(25), Fraction(9)),
    }
    exif_data = exif.tobytes()
    if not exif_data.startswith(b"Exif\x00\x00"):
        raise RuntimeError("Pillow produced an unexpected EXIF prefix")
    save_rgb16_png(path, 64, 48, lambda _x, _y: (10000, 30000, 50000), exif_data[6:])


def encode(encoder: Path, source: Path, output: Path, *, grid: bool = False) -> None:
    command = [
        str(encoder),
        "--quality",
        "90",
        "--bit-depth",
        "10",
    ]
    if grid:
        command.extend(["--cut-tiles", "64"])
    command.extend(["--output", str(output), str(source)])
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--heif-enc",
        type=Path,
        required=True,
        help="path to a libheif heif-enc build with the x265 Main10 encoder",
    )
    args = parser.parse_args()
    if not args.heif_enc.is_file():
        parser.error(f"heif-enc executable does not exist: {args.heif_enc}")

    FIXTURES.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="oi-heic-fixtures-") as temporary:
        sources = Path(temporary)
        grid_png = sources / "grid.png"
        tenbit_png = sources / "tenbit.png"
        gps_png = sources / "gps-source.png"
        save_grid_png(grid_png)
        save_10bit_png(tenbit_png)
        save_gps_png(gps_png)
        with Image.open(gps_png) as check:
            gps_ifd = check.getexif().get_ifd(34853)
            if gps_ifd.get(2) != (37.0, 46.0, 3.0) or gps_ifd.get(4) != (122.0, 25.0, 9.0):
                raise RuntimeError("the generated GPS PNG did not retain its synthetic GPS IFD")

        encode(args.heif_enc, grid_png, FIXTURES / "fixture-grid.heic", grid=True)
        encode(args.heif_enc, tenbit_png, FIXTURES / "fixture-10bit.heic")
        encode(args.heif_enc, gps_png, FIXTURES / "fixture-gps.heic")


if __name__ == "__main__":
    main()
