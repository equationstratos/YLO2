"""Cinématique d'une patte YLO-2.

Chaîne : HAA (axe X) -> décalage d'abduction -> HFE (axe Y) -> cuisse L1 ->
KFE (axe Y) -> jambe L2 -> pied. Le point de contact est l'origine du repère
« foot », comme dans l'URDF.

Toutes les positions de pied sont exprimées dans le repère du tronc.
"""
from __future__ import annotations

import math
from typing import Sequence, Tuple

from .model import DEFAULT, Leg, Model


def inverse(leg: Leg, x: float, y: float, z: float, model: Model = DEFAULT) -> Tuple[float, float, float]:
    """Angles (haa, hfe, kfe) plaçant le pied en (x, y, z), repère tronc."""
    px = x - leg.x
    py = y - leg.y
    pz = z - model.leg_offset_z
    off = leg.mirror * model.abad_plane      # le joint KFE décale le plan sagittal

    radial = py * py + pz * pz
    zp = -math.sqrt(max(radial - off * off, 1e-12))
    q1 = math.atan2(pz, py) - math.atan2(zp, off)

    # plan sagittal après rotation d'abduction
    sx, sz = -px, -zp
    dist = math.hypot(sx, sz)
    lo, hi = model.reach()
    dist = min(max(dist, lo), hi)

    cos3 = (dist * dist - model.l1 ** 2 - model.l2 ** 2) / (2 * model.l1 * model.l2)
    q3 = -math.acos(min(1.0, max(-1.0, cos3)))
    q2 = math.atan2(sx, sz) - math.atan2(
        model.l2 * math.sin(q3), model.l1 + model.l2 * math.cos(q3)
    )
    return q1, q2, q3


def forward(leg: Leg, q: Sequence[float], model: Model = DEFAULT) -> Tuple[float, float, float]:
    """Position du pied (repère tronc) pour les angles donnés."""
    q1, q2, q3 = q
    s2, c2 = math.sin(q2), math.cos(q2)
    s23, c23 = math.sin(q2 + q3), math.cos(q2 + q3)

    ux = -model.l1 * s2 - model.l2 * s23
    uz = -model.l1 * c2 - model.l2 * c23
    uy = leg.mirror * -0.001                      # décalage du joint KFE

    ay = leg.mirror * model.abad + uy
    y = ay * math.cos(q1) - uz * math.sin(q1)
    z = ay * math.sin(q1) + uz * math.cos(q1)
    return leg.x + ux, leg.y + y, model.leg_offset_z + z


def neutral_foot(leg: Leg, height: float, model: Model = DEFAULT) -> Tuple[float, float, float]:
    """Pied au repos : patte verticale (HAA nul), à la hauteur demandée."""
    return leg.x, leg.y + leg.mirror * model.abad_plane, -height


def check_limits(joint: str, value: float, model: Model = DEFAULT) -> bool:
    """True si l'angle est dans la course URDF de cet axe."""
    limits = model.limits(joint)
    if limits is None:
        return True
    return limits[0] - 1e-9 <= value <= limits[1] + 1e-9


def reachable(leg: Leg, x: float, y: float, z: float, model: Model = DEFAULT) -> bool:
    """True si la cible est dans l'enveloppe de travail (sans saturation)."""
    px, py, pz = x - leg.x, y - leg.y, z - model.leg_offset_z
    off = leg.mirror * model.abad_plane
    radial = py * py + pz * pz
    if radial < off * off:
        return False
    zp = -math.sqrt(radial - off * off)
    dist = math.hypot(px, zp)
    lo, hi = model.reach()
    return lo <= dist <= hi
