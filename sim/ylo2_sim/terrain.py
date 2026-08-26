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


def _quarter_pipe(base, radius, half_width, direction, deck=0.9, slices=24) -> List[Box]:
    """Transition de quarter pipe : un quart de cercle en tranches.

    Le profil h(u) = R - sqrt(R² - u²) part tangent au sol et finit vertical,
    comme une vraie transition. `direction` vaut +1 si le mur est du côté des
    x croissants. Chaque tranche prend la hauteur de son bord le plus haut :
    l'escalier reste au-dessus de la courbe, jamais dedans.
    """
    out, n = [], slices
    for i in range(n):
        u0, u1 = i / n * radius, (i + 1) / n * radius
        h = radius - math.sqrt(max(0.0, radius * radius - u1 * u1))
        a = base + u0 if direction > 0 else base - u1
        b = base + u1 if direction > 0 else base - u0
        out.append(Box(a, b + 0.001, -half_width, half_width, h))
    if deck > 0:                                    # plateforme derrière le coping
        if direction > 0:
            out.append(Box(base + radius, base + radius + deck,
                           -half_width, half_width, radius))
        else:
            out.append(Box(base - radius - deck, base - radius,
                           -half_width, half_width, radius))
    return out


def _bank(x0, x1, y0, y1, h0, h1) -> List[Box]:
    """Plan incliné en tranches : un bank, ou le flanc d'un funbox."""
    out, n = [], 14
    for i in range(n):
        a = x0 + (x1 - x0) * i / n
        b = x0 + (x1 - x0) * (i + 1) / n
        out.append(Box(a, b + 0.001, y0, y1, h0 + (h1 - h0) * (i + 1) / n))
    return out


def _skatepark() -> List[Box]:
    """Mini-plaza dans l'esprit des skateparks en béton de Californie.

    Un funbox central bordé d'un ledge, un kicker à l'entrée, et deux quarter
    pipes qui se font face comme les extrémités d'une mini-ramp. Les cotes
    sont réduites au gabarit du robot : un funbox de skate fait 40 cm de haut,
    celui-ci 180 mm, dans ce que passe une patte de 445 mm.

    Les modules sont largement espacés : il faut de l'élan avant chaque
    obstacle et de quoi se replacer après. Au moins 1,5 m de plat entre deux.
    """
    out: List[Box] = []
    out += _bank(1.40, 2.10, -0.75, 0.75, 0.0, 0.10)          # kicker d'entrée
    out += _bank(3.60, 4.30, -0.95, 0.95, 0.0, 0.18)          # montée du funbox
    out.append(Box(4.30, 5.30, -0.95, 0.95, 0.18))            # plateau
    out += _bank(5.30, 6.00, -0.95, 0.95, 0.18, 0.0)          # descente
    out.append(Box(3.40, 6.20, 1.70, 2.10, 0.20))             # ledge de grind
    out += _quarter_pipe(7.80, 0.45, 1.90, +1)
    out += _quarter_pipe(-2.60, 0.45, 1.90, -1)
    return out


def _big_ramp() -> List[Box]:
    """Mini-ramp : deux grandes transitions qui se font face.

    C'est l'objet de skate le plus simple et le plus riche — on n'y franchit
    rien, on y roule : la pente rend l'élan qu'on lui a donné. Une transition
    de 1,20 m ne se « passe » pas comme les rampes des autres terrains, elle
    se remonte tant qu'on a de la vitesse.
    """
    out: List[Box] = []
    radius, width = 1.20, 2.40
    out += _quarter_pipe(3.20, radius, width, +1, 1.30, slices=48)
    out += _quarter_pipe(-3.20, radius, width, -1, 1.30, slices=48)
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

    def support(self, x: float, y: float, cx: float, cy: float,
                radius: float = 0.075, samples: int = 4) -> float:
        """Sol vu par une ROUE de rayon `radius`, pas par un point.

        `height_at` n'interroge qu'un point : une roue de 75 mm arrivant sur
        la tranche d'une rampe la traversait donc jusqu'à ce que son centre
        la franchisse. Un pneu touche pourtant dès que sa jante rencontre le
        relief. Pour un sol h(u) et un décalage u sous l'essieu, le contact
        impose z >= h(u) + sqrt(R² - u²) : on prend le maximum sur l'empreinte
        et on redescend d'un rayon pour rendre une hauteur comparable. Sur sol
        plat le résultat est exactement `height_at`.
        """
        here = self.height_at(x, y)
        best = here
        for i in range(1, samples + 1):
            u = radius * i / samples
            lift = math.sqrt(max(0.0, radius * radius - u * u)) - radius
            for dx, dy in ((cx * u, cy * u), (-cx * u, -cy * u),
                           (-cy * u, cx * u), (cy * u, -cx * u)):
                h = self.height_at(x + dx, y + dy)
                # Un relief plus haut que le RAYON n'est pas un contact de
                # roulement, c'est un mur : le pneu bute contre sa face, il ne
                # monte pas dessus. Le compter ici téléporterait la roue au
                # sommet d'une marche de 130 mm dès qu'elle en approche à
                # 75 mm. Ces obstacles-là sont l'affaire du lever de patte.
                if h - here > radius:
                    continue
                if h + lift > best:
                    best = h + lift
        return best

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
    "skatepark": Terrain("Skatepark", "skatepark", 0.18, _skatepark()),
    "bigramp": Terrain("Big ramp", "bigramp", 0.30, _big_ramp()),
    "poutres": Terrain("Poutres", "poutres", 0.14,
                       [Box(1.4 + i * 0.7, 1.4 + i * 0.7 + 0.25, -1.2, 1.2, 0.14) for i in range(5)]),
}

FLAT = PRESETS["plat"]


def get(key: str) -> Terrain:
    if key not in PRESETS:
        raise KeyError("terrain inconnu : %s (parmi %s)" % (key, sorted(PRESETS)))
    return PRESETS[key]
