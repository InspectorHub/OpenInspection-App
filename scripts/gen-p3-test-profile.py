"""Generate the tiny CC0 Display P3 ICC profile used by the HEIC fixture."""

import struct
import sys
from pathlib import Path


def fixed(value: float) -> int:
    return round(value * 65536)


def xyz_tag(values: tuple[float, float, float]) -> bytes:
    return b'XYZ ' + bytes(4) + struct.pack('>iii', *(fixed(value) for value in values))


def mluc_tag(text: str) -> bytes:
    value = text.encode('utf-16-be')
    record = b'enUS' + struct.pack('>II', len(value), 28)
    return b'mluc' + bytes(4) + struct.pack('>II', 1, 12) + record + value


def curve_tag() -> bytes:
    # ICC parametricCurveType function 4: the piecewise sRGB transfer curve.
    values = (2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0.0, 0.0031308)
    return b'para' + bytes(4) + struct.pack('>HH7i', 4, 0, *(fixed(value) for value in values))


def matrix_tag(values: tuple[float, ...]) -> bytes:
    return b'sf32' + bytes(4) + struct.pack('>9i', *(fixed(value) for value in values))


def build_profile() -> bytes:
    # Display P3 RGB primaries adapted from D65 to the ICC D50 profile connection space.
    d50 = (0.9642, 1.0, 0.8249)
    chad = (
        1.0478860032, 0.0229187652, -0.0502160953,
        0.0295817825, 0.9904835185, -0.0170787077,
        -0.0092518808, 0.0150726075, 0.7516781336,
    )
    tags = {
        b'desc': mluc_tag('Synthetic Display P3 test profile'),
        b'cprt': mluc_tag('CC0 1.0 Universal'),
        b'wtpt': xyz_tag(d50),
        b'chad': matrix_tag(chad),
        b'rXYZ': xyz_tag((0.5151187009, 0.2411891678, -0.0010504527)),
        b'gXYZ': xyz_tag((0.2919778320, 0.6922440506, 0.0418791201)),
        b'bXYZ': xyz_tag((0.1571034670, 0.0665667815, 0.7840713326)),
        b'rTRC': curve_tag(),
        b'gTRC': curve_tag(),
        b'bTRC': curve_tag(),
    }

    header = bytearray(128)
    header[4:8] = b'TEST'
    header[8:12] = b'\x04\x00\x00\x00'
    header[12:16] = b'mntr'
    header[16:20] = b'RGB '
    header[20:24] = b'XYZ '
    struct.pack_into('>6H', header, 24, 2026, 10, 29, 0, 0, 0)
    header[36:40] = b'acsp'
    header[40:44] = b'MSFT'
    header[48:52] = b'TEST'
    header[52:56] = b'P3T1'
    struct.pack_into('>3i', header, 68, *(fixed(value) for value in d50))
    header[80:84] = b'CC0T'

    table = bytearray(struct.pack('>I', len(tags)))
    payload = bytearray()
    offset = 128 + 4 + 12 * len(tags)
    for signature, data in tags.items():
        aligned = (offset + 3) & ~3
        payload.extend(bytes(aligned - offset))
        offset = aligned
        table.extend(signature + struct.pack('>II', offset, len(data)))
        payload.extend(data)
        offset += len(data)
    profile = header + table + payload
    struct.pack_into('>I', profile, 0, len(profile))
    return bytes(profile)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: gen-p3-test-profile.py <output.icc>')
    Path(sys.argv[1]).write_bytes(build_profile())
