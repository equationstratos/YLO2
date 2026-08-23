"""Format d'échange entre le simulateur et le visualiseur 3D.

    {
      "format": "ylo2.trajectory/1",
      "source": "scripts/trot_forward.py",
      "dt": 0.02,
      "joints": ["lf_haa", ...12 noms...],
      "frames": [
        {"t": 0.0, "q": [12 angles rad], "base": [x, y, z, roll, pitch, yaw],
         "contact": [lf, rf, lh, rh], "phase": 0.0}
      ]
    }
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

FORMAT = "ylo2.trajectory/1"


def dump(path: str, dt: float, joints: List[str], frames: List[Dict[str, Any]],
         source: str = "", meta: Dict[str, Any] = None) -> str:
    payload: Dict[str, Any] = {
        "format": FORMAT,
        "source": source,
        "dt": dt,
        "joints": joints,
        "frames": frames,
    }
    if meta:
        payload["meta"] = meta
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    return path


def load(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not str(data.get("format", "")).startswith("ylo2.trajectory"):
        raise ValueError(f"format inattendu : {data.get('format')!r}")
    return data
