"""Générateur d'allure, calqué sur la configuration CHAMP du robot.

Les valeurs par défaut sont celles de
champ_for_ylo2/ylo2_config/config/gait/gait.yaml :
hauteur nominale 0,25 m, garde au sol 0,04 m, appui 0,25 s, Vx max 0,2 m/s,
ωz max 1 rad/s.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Tuple

from .model import DEFAULT, Leg, Model


@dataclass(frozen=True)
class Gait:
    name: str
    duty: float                    # part du cycle passée en appui
    stance: float                  # durée d'appui, en secondes
    offsets: Dict[str, float]      # décalage de phase par patte

    @property
    def cycle(self) -> float:
        return self.stance / self.duty


GAITS: Dict[str, Gait] = {
    "stand": Gait("stand", 1.0, 1.0, {"lf": 0.0, "rf": 0.0, "lh": 0.0, "rh": 0.0}),
    "walk":  Gait("walk", 0.75, 0.35, {"lf": 0.0, "rh": 0.25, "rf": 0.5, "lh": 0.75}),
    "trot":  Gait("trot", 0.50, 0.25, {"lf": 0.0, "rf": 0.5, "lh": 0.5, "rh": 0.0}),
    "pace":  Gait("pace", 0.50, 0.25, {"lf": 0.0, "lh": 0.0, "rf": 0.5, "rh": 0.5}),
    "bound": Gait("bound", 0.50, 0.20, {"lf": 0.0, "rf": 0.0, "lh": 0.5, "rh": 0.5}),
    # allures rapides : le rapport d'appui passe sous 0,5, d'où des instants
    # sans aucun appui — c'est la suspension d'un galop
    "canter": Gait("canter", 0.42, 0.16, {"rh": 0.0, "lh": 0.30, "rf": 0.35, "lf": 0.65}),
    "gallop": Gait("gallop", 0.34, 0.12, {"lh": 0.0, "rh": 0.12, "rf": 0.52, "lf": 0.64}),
}

# vitesses de référence par allure (m/s). Ordres de grandeur du commerce :
# Unitree Go2 annonce 3,7 m/s, le B2 6 m/s, le Go2-W roule à 2,5 m/s.
SPEED_REF: Dict[str, float] = {
    "stand": 0.0, "walk": 0.15, "trot": 0.50, "canter": 1.10, "gallop": 1.70,
    "pace": 0.45, "bound": 0.90,
}
LADDER = ["walk", "trot", "canter", "gallop"]
MAX_WALK_SPEED = 2.0        # butée du curseur, sur pattes
MAX_WHEEL_SPEED = 3.0       # en roues
DECLARED_SPEED = 1.7        # au-delà, les 20 rad/s de l'URDF sont dépassés
WHEEL_RADIUS = 0.075

MAX_VX = 2.0
MAX_VY = 0.6
MAX_WZ = 1.6
NOMINAL_HEIGHT = 0.25
SWING_HEIGHT = 0.04


def smoothstep(s: float) -> float:
    return s * s * (3.0 - 2.0 * s)


def foot_target(
    leg: Leg,
    gait: Gait,
    phase: float,
    vx: float,
    vy: float,
    wz: float,
    height: float,
    swing: float = SWING_HEIGHT,
    model: Model = DEFAULT,
) -> Tuple[Tuple[float, float, float], bool]:
    """Cible du pied (repère tronc) et état d'appui, pour une phase donnée."""
    nx = leg.x
    ny = leg.y + leg.mirror * model.abad_plane

    # vitesse du pied au sol : v + ω × r
    vfx = vx - wz * ny
    vfy = vy + wz * nx
    sweep_x = vfx * gait.stance
    sweep_y = vfy * gait.stance

    ph = (phase + gait.offsets[leg.name]) % 1.0

    if gait.name == "stand":
        return (nx, ny, -height), True

    if ph < gait.duty:                                   # appui
        s = ph / gait.duty
        return (nx + sweep_x * (0.5 - s), ny + sweep_y * (0.5 - s), -height), True

    s = (ph - gait.duty) / (1.0 - gait.duty)             # vol
    e = smoothstep(s)
    return (
        nx + sweep_x * (-0.5 + e),
        ny + sweep_y * (-0.5 + e),
        -height + math.sin(math.pi * s) * swing,
    ), False


def clamp_command(vx: float, vy: float, wz: float) -> Tuple[float, float, float]:
    """Sature la consigne aux maxima déclarés dans gait.yaml."""
    return (
        max(-MAX_VX, min(MAX_VX, vx)),
        max(-MAX_VY, min(MAX_VY, vy)),
        max(-MAX_WZ, min(MAX_WZ, wz)),
    )
