"""Terrains et obstacles, identiques à ceux du visualiseur.

Chaque terrain est une liste de boîtes posées au sol : la même description
donne la hauteur sous un pied et les volumes affichés côté navigateur.

Cotes calées sur le commerce : un Unitree Go2 monte des marches d'environ
16 cm, un B2 des marches de 20 à 25 cm et des pentes jusqu'à 45°. YLO-2 a
une patte de 445 mm, donc 12 à 18 cm sont dans son gabarit.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class Box:
    x0: float
    x1: float
    y0: float
    y1: float
    h: float


def _stairs(start_x, steps, rise, run, half_width, down=True) -> List[Box]:
    out = [Box(start_x + i * run, start_x + (i + 1) * run, -half_width, half_width, (i + 1) * rise)
           for i in range(steps)]
    top = start_x + steps * run
    out.append(Box(top, top + 1.6, -half_width, half_width, steps * rise))
    if down:
        out += [Box(top + 1.6 + i * run, top + 1.6 + (i + 1) * run,
                    -half_width, half_width, (steps - i - 1) * rise) for i in range(steps)]
    return out


def _rubble(x0, x1, half_width, cell, max_h) -> List[Box]:
    out, seed = [], 7
    def rnd():
        nonlocal seed
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    x = x0
    while x < x1:
        y = -half_width
        while y < half_width:
            h = round(rnd() * 3) / 3 * max_h
            if h > 0.001:
                out.append(Box(x, x + cell, y, y + cell, h))
            y += cell
        x += cell
    return out


def _ramp(angle_deg=20.0) -> List[Box]:
    out, n, length = [], 40, 2.2
    rise = math.tan(math.radians(angle_deg)) * length
    for i in range(n):
        x0 = 1.2 + i * (length / n)
        out.append(Box(x0, x0 + length / n + 0.001, -1.2, 1.2, (i + 1) / n * rise))
    out.append(Box(1.2 + length, 1.2 + length + 1.4, -1.2, 1.2, rise))
    for i in range(n):
        x0 = 1.2 + length + 1.4 + i * (length / n)
        out.append(Box(x0, x0 + length / n + 0.001, -1.2, 1.2, (1 - (i + 1) / n) * rise))
    return out


@dataclass
class Terrain:
    name: str = "Sol plat"
    key: str = "plat"
    max_step: float = 0.0
    boxes: List[Box] = field(default_factory=list)

    def height_at(self, x: float, y: float) -> float:
        h = 0.0
        for b in self.boxes:
            if b.x0 <= x < b.x1 and b.y0 <= y < b.y1 and b.h > h:
                h = b.h
        return h

    def max_height_along(self, x0, y0, x1, y1, samples: int = 8) -> float:
        return max(self.height_at(x0 + (x1 - x0) * i / samples, y0 + (y1 - y0) * i / samples)
                   for i in range(samples + 1))

    def step_ahead(self, x, y, yaw, distance: float = 0.75, samples: int = 10) -> float:
        here = self.height_at(x, y)
        worst = 0.0
        for i in range(1, samples + 1):
            d = distance * i / samples
            worst = max(worst, abs(self.height_at(x + math.cos(yaw) * d,
                                                  y + math.sin(yaw) * d) - here))
        return worst


PRESETS: Dict[str, Terrain] = {
    "plat": Terrain("Sol plat", "plat", 0.0, []),
    "escalier": Terrain("Escalier", "escalier", 0.13, _stairs(1.2, 8, 0.13, 0.30, 1.1)),
    "marches_hautes": Terrain("Marches hautes", "marches_hautes", 0.18, _stairs(1.4, 5, 0.18, 0.36, 1.0)),
    "plateforme": Terrain("Plateforme", "plateforme", 0.24, [Box(1.5, 4.0, -1.2, 1.2, 0.24)]),
    "rampe": Terrain("Rampe 20°", "rampe", 0.05, _ramp(20.0)),
    "gravats": Terrain("Gravats", "gravats", 0.09, _rubble(1.0, 5.0, 1.0, 0.28, 0.09)),
    "poutres": Terrain("Poutres", "poutres", 0.14,
                       [Box(1.4 + i * 0.7, 1.4 + i * 0.7 + 0.25, -1.2, 1.2, 0.14) for i in range(5)]),
}

FLAT = PRESETS["plat"]


def get(key: str) -> Terrain:
    if key not in PRESETS:
        raise KeyError("terrain inconnu : %s (parmi %s)" % (key, sorted(PRESETS)))
    return PRESETS[key]
