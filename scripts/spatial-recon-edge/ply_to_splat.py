"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                        | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 box-side recon service — pure-Python .ply -> .splat converter (zero deps, no numpy) so nerfstudio's exported 3D gaussian-splat .ply becomes the antimatter15 .splat the OSHAL viewer streams. Handles a trained-3DGS .ply (x,y,z + f_dc SH colour + opacity + log-scale + rotation quaternion) AND a plain colored point cloud (each point -> a small isotropic gaussian sized off the cloud bbox). ASCII + binary_little/big_endian. Capped at MAX_GAUSSIANS with a stride-subsample. Mirrors the TS src/features/spatial-mapping/services/import-format.ts contract so BOTH the import lane and the box produce byte-identical splats.
"""

import math
import struct
from typing import Dict, List, Optional, Tuple

STRIDE = 32                     # bytes per gaussian in the .splat format
SH_C0 = 0.28209479177387814     # spherical-harmonics band-0 constant
MAX_GAUSSIANS = 2_000_000       # viewer ceiling; larger inputs are stride-subsampled

# PLY scalar type -> (struct char, byte size).
_TYPE = {
    "char": ("b", 1), "int8": ("b", 1), "uchar": ("B", 1), "uint8": ("B", 1),
    "short": ("h", 2), "int16": ("h", 2), "ushort": ("H", 2), "uint16": ("H", 2),
    "int": ("i", 4), "int32": ("i", 4), "uint": ("I", 4), "uint32": ("I", 4),
    "float": ("f", 4), "float32": ("f", 4), "double": ("d", 8), "float64": ("d", 8),
}


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _clamp_byte(v: float) -> int:
    return int(_clamp(round(v), 0, 255))


def _sigmoid(v: float) -> float:
    return 1.0 / (1.0 + math.exp(-v))


def _exp_scale(v: float) -> float:
    if not math.isfinite(v):
        return 0.01
    return _clamp(math.exp(v), 0.0005, 3.0)


class _Header:
    __slots__ = ("fmt", "count", "props", "data_start")

    def __init__(self, fmt: str, count: int, props: List[Tuple[str, str]], data_start: int):
        self.fmt = fmt              # 'ascii' | 'le' | 'be'
        self.count = count
        self.props = props          # ordered [(name, type), ...]
        self.data_start = data_start


def _parse_header(buf: bytes) -> _Header:
    marker = buf.find(b"end_header")
    if not buf[:3] == b"ply" or marker < 0:
        raise ValueError("not a PLY file (missing ply magic / end_header)")
    data_start = buf.find(b"\n", marker) + 1
    lines = buf[:marker].decode("ascii", "replace").split("\n")
    fmt, count, in_vertex, props = "ascii", 0, False, []
    for line in lines:
        p = line.strip().split()
        if not p:
            continue
        if p[0] == "format":
            fmt = "be" if p[1] == "binary_big_endian" else "le" if p[1] == "binary_little_endian" else "ascii"
        elif p[0] == "element":
            in_vertex = p[1] == "vertex"
            if in_vertex:
                count = int(p[2])
        elif p[0] == "property" and in_vertex and p[1] != "list":
            props.append((p[2], p[1]))
    if count <= 0 or not props:
        raise ValueError("PLY has no vertex element / properties")
    return _Header(fmt, count, props, data_start)


def _read_vertices(buf: bytes, h: _Header, step: int) -> List[Dict[str, float]]:
    if h.fmt == "ascii":
        return _read_ascii(buf, h, step)
    return _read_binary(buf, h, step)


def _read_ascii(buf: bytes, h: _Header, step: int) -> List[Dict[str, float]]:
    body = buf[h.data_start:].decode("ascii", "replace").split("\n")
    names = [n for n, _ in h.props]
    out: List[Dict[str, float]] = []
    for i in range(0, h.count, step):
        if i >= len(body):
            break
        cols = body[i].split()
        if len(cols) < len(names):
            continue
        out.append({names[k]: float(cols[k]) for k in range(len(names))})
    return out


def _read_binary(buf: bytes, h: _Header, step: int) -> List[Dict[str, float]]:
    endian = "<" if h.fmt == "le" else ">"
    chars, offs, stride = [], [], 0
    for _, t in h.props:
        if t not in _TYPE:
            raise ValueError(f"unsupported PLY property type: {t}")
        c, sz = _TYPE[t]
        chars.append(c)
        offs.append(stride)
        stride += sz
    row_fmt = endian + "".join(chars)
    row = struct.Struct(row_fmt)
    names = [n for n, _ in h.props]
    out: List[Dict[str, float]] = []
    pos = h.data_start
    end = len(buf)
    i = 0
    while i < h.count and pos + stride <= end:
        vals = row.unpack_from(buf, pos)
        out.append({names[k]: float(vals[k]) for k in range(len(names))})
        i += step
        pos = h.data_start + i * stride
    return out


def _quat_bytes(w: float, x: float, y: float, z: float) -> Tuple[int, int, int, int]:
    n = math.sqrt(w * w + x * x + y * y + z * z) or 1.0
    return (_clamp_byte(w / n * 128 + 128), _clamp_byte(x / n * 128 + 128),
            _clamp_byte(y / n * 128 + 128), _clamp_byte(z / n * 128 + 128))


def _pack_3dgs(v: Dict[str, float]) -> bytes:
    def col(f: float) -> int:
        return _clamp_byte(_clamp(0.5 + SH_C0 * f, 0.0, 1.0) * 255)
    alpha = _clamp_byte(_sigmoid(v["opacity"]) * 255) if "opacity" in v else 255
    qw = v.get("rot_0")
    q = _quat_bytes(v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]) if qw is not None else (255, 128, 128, 128)
    return struct.pack(
        "<3f3f4B4B",
        v["x"], v["y"], v["z"],
        _exp_scale(v["scale_0"]), _exp_scale(v["scale_1"]), _exp_scale(v["scale_2"]),
        col(v["f_dc_0"]), col(v["f_dc_1"]), col(v["f_dc_2"]), alpha,
        q[0], q[1], q[2], q[3],
    )


def _color_plan(props: List[Tuple[str, str]]) -> Optional[Tuple[str, str, str, bool]]:
    by = {n: t for n, t in props}
    for r, g, b in (("red", "green", "blue"), ("r", "g", "b"), ("diffuse_red", "diffuse_green", "diffuse_blue")):
        if r in by and g in by and b in by:
            to255 = by[r].startswith("float") or by[r] == "double"
            return (r, g, b, to255)
    return None


def _bbox_scale(verts: List[Dict[str, float]]) -> float:
    xs = [v["x"] for v in verts]
    ys = [v["y"] for v in verts]
    zs = [v["z"] for v in verts]
    diag = math.sqrt((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2 + (max(zs) - min(zs)) ** 2) or 1.0
    return _clamp(diag * 0.004, 0.004, 0.1)


def _pack_point(v: Dict[str, float], scale: float, plan) -> bytes:
    if plan is None:
        r = g = b = 200
    else:
        rk, gk, bk, to255 = plan
        f = 255.0 if to255 else 1.0
        r, g, b = _clamp_byte(v[rk] * f), _clamp_byte(v[gk] * f), _clamp_byte(v[bk] * f)
    return struct.pack("<3f3f4B4B", v["x"], v["y"], v["z"], scale, scale, scale, r, g, b, 255, 255, 128, 128, 128)


def convert_ply_to_splat(data: bytes) -> bytes:
    """Convert a PLY (trained 3DGS or colored point cloud) to a packed .splat buffer."""
    h = _parse_header(data)
    step = max(1, math.ceil(h.count / MAX_GAUSSIANS))
    verts = _read_vertices(data, h, step)
    if not verts:
        raise ValueError("PLY produced no readable vertices")
    is_3dgs = any(n == "f_dc_0" for n, _ in h.props)
    if is_3dgs:
        return b"".join(_pack_3dgs(v) for v in verts)
    scale = _bbox_scale(verts)
    plan = _color_plan(h.props)
    return b"".join(_pack_point(v, scale, plan) for v in verts)


def gaussian_count(splat: bytes) -> int:
    """Number of gaussian records in a .splat buffer."""
    if len(splat) == 0 or len(splat) % STRIDE != 0:
        raise ValueError(f"malformed .splat ({len(splat)} bytes; must be a non-zero multiple of {STRIDE})")
    return len(splat) // STRIDE
