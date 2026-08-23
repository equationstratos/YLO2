"""Figures : salto arrière.

Le vol est balistique — hauteur et rotation sont imposées par la gravité,
pas par une courbe décorative. Le reste (armement, poussée, réception) est
une suite de poses interpolées, comme le ferait un contrôleur scripté à
bord. Le simulateur vérifie ensuite butées et vitesses articulaires.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Tuple

from . import kinematics as kin
from .model import DEFAULT, Leg, Model

G_ACC = 9.81

# poses articulaires (haa, hfe, kfe) en radians
POSE: Dict[str, Dict[str, Tuple[float, float, float]]] = {
    "tuck":   {"front": (0.0, 1.55, -2.55), "hind": (0.0, 1.35, -2.60)},
    "reach":  {"front": (0.0, 0.55, -1.45), "hind": (0.0, 0.85, -1.70)},
    "launch": {"front": (0.0, 0.35, -0.95), "hind": (0.0, 0.30, -0.85)},
}


@dataclass(frozen=True)
class Backflip:
    crouch: float = 0.34        # accroupissement
    load: float = 0.10          # bascule arrière
    push: float = 0.19          # poussée
    land: float = 0.22          # réception amortie
    recover: float = 0.42       # retour en station
    vz: float = 2.95            # vitesse verticale au décollage (m/s)
    crouch_z: float = 0.165
    takeoff_z: float = 0.32
    absorb_z: float = 0.185
    travel: float = -0.10       # recul pendant la figure (m)

    @property
    def flight(self) -> float:
        return 2.0 * self.vz / G_ACC

    @property
    def duration(self) -> float:
        return self.crouch + self.load + self.push + self.flight + self.land + self.recover

    @property
    def apex(self) -> float:
        return self.takeoff_z + self.vz ** 2 / (2 * G_ACC)


DEFAULT_FLIP = Backflip()


def _smooth(s: float) -> float:
    return s * s * (3.0 - 2.0 * s)


def _smoother(s: float) -> float:
    return s * s * s * (s * (s * 6 - 15) + 10)


def _pose_for(leg: Leg, pose: str) -> Tuple[float, float, float]:
    return POSE[pose]["front" if leg.front > 0 else "hind"]


def perform(robot, flip: Backflip = DEFAULT_FLIP) -> Dict[str, float]:
    """Exécute le salto sur un robot, en enregistrant chaque pas."""
    model = robot.model
    dt = robot.dt
    steps = max(1, round(flip.duration / dt))

    t_crouch = flip.crouch
    t_load = t_crouch + flip.load
    t_push = t_load + flip.push
    t_fly = t_push + flip.flight
    t_land = t_fly + flip.land

    def ground(height: float, shift_x: float = 0.0) -> None:
        for i, leg in enumerate(model.legs):
            target = (leg.x + shift_x, leg.y + leg.mirror * model.abad_plane, -height)
            angles = kin.inverse(leg, *target, model=model)
            for k in range(3):
                robot.q[i * 3 + k] = angles[k]
            robot.contacts[i] = True

    def pose_from(start: List[float], b: str, k: float) -> None:
        """Interpole depuis une pose mesurée vers une pose de référence."""
        for i, leg in enumerate(model.legs):
            pb = _pose_for(leg, b)
            for j in range(3):
                q0 = start[i * 3 + j]
                robot.q[i * 3 + j] = q0 + (pb[j] - q0) * k
            robot.contacts[i] = False

    def pose_mix(a: str, b: str, k: float) -> None:
        """Pose interpolée entre deux références : vitesse bornée et
        indépendante de la cadence, contrairement à un filtre exponentiel."""
        for i, leg in enumerate(model.legs):
            pa, pb = _pose_for(leg, a), _pose_for(leg, b)
            for j in range(3):
                robot.q[i * 3 + j] = pa[j] + (pb[j] - pa[j]) * k
            robot.contacts[i] = False

    def pose_to_ground(a: str, k: float, height: float, shift_x: float) -> None:
        """Ouverture des jambes vers la pose d'appui, en douceur."""
        for i, leg in enumerate(model.legs):
            pa = _pose_for(leg, a)
            target = (leg.x + shift_x, leg.y + leg.mirror * model.abad_plane, -height)
            pb = kin.inverse(leg, *target, model=model)
            for j in range(3):
                robot.q[i * 3 + j] = pa[j] + (pb[j] - pa[j]) * k
            robot.contacts[i] = k > 0.5

    robot.mode = "joint"                       # le générateur d'allure est débrayé
    phases: List[str] = []
    takeoff_q: List[float] = []                # pose au décollage, départ du groupé

    for n in range(steps + 1):
        t = n * dt
        if t < t_crouch:
            phases.append("armement")
            s = _smooth(t / t_crouch)
            robot.base[2] = robot.height + (flip.crouch_z - robot.height) * s
            robot.base[4] = 0.06 * s
            ground(robot.base[2], 0.02 * s)
        elif t < t_load:
            phases.append("bascule")
            s = _smooth((t - t_crouch) / flip.load)
            robot.base[2] = flip.crouch_z
            robot.base[4] = 0.06 + (-0.10 - 0.06) * s
            ground(robot.base[2], 0.02 + (-0.01 - 0.02) * s)
        elif t < t_push:
            phases.append("poussée")
            s = _smooth((t - t_load) / flip.push)
            robot.base[2] = flip.crouch_z + (flip.takeoff_z - flip.crouch_z) * s
            robot.base[4] = -0.10 + (-0.55 + 0.10) * s
            robot.base[0] += flip.travel * dt * 0.5
            ground(min(robot.base[2], model.l1 + model.l2 - 0.02), -0.01)
        elif t < t_fly:
            phases.append("vol")
            s = (t - t_push) / flip.flight
            tf = t - t_push
            robot.base[2] = flip.takeoff_z + flip.vz * tf - 0.5 * G_ACC * tf * tf
            robot.base[4] = -0.55 - (2 * math.pi - 0.55) * _smoother(s)
            robot.base[0] += flip.travel * dt / flip.flight
            if not takeoff_q:
                takeoff_q.extend(robot.q)                   # on part de la pose réelle
            if s < 0.45:                                   # groupé
                pose_from(takeoff_q, "tuck", _smooth(s / 0.45))
            else:                                          # ouverture vers le sol
                pose_mix("tuck", "reach", _smooth((s - 0.45) / 0.55))
        elif t < t_land:
            phases.append("réception")
            s = _smooth((t - t_fly) / flip.land)
            robot.base[2] = flip.takeoff_z + (flip.absorb_z - flip.takeoff_z) * s
            robot.base[4] = 0.12 * s              # -2π ≡ 0 : on ne déroule pas la rotation
            pose_to_ground("reach", s, robot.base[2], 0.015)
        else:
            phases.append("stabilisation")
            s = _smooth(min(1.0, (t - t_land) / flip.recover))
            bounce = math.sin(math.pi * s * 2) * 0.012 * (1 - s)
            robot.base[2] = flip.absorb_z + (robot.height - flip.absorb_z) * s + bounce
            robot.base[4] = 0.12 * (1 - s) + math.sin(math.pi * s * 3) * 0.02 * (1 - s)
            ground(robot.base[2], 0.015 * (1 - s))

        robot.base[3] = 0.0
        robot._advance_recorded()

    robot.base[4] = 0.0
    robot.base[2] = robot.height
    robot.mode = "gait"

    return {
        "duration_s": round(flip.duration, 3),
        "flight_s": round(flip.flight, 3),
        "apex_m": round(flip.apex, 3),
        "takeoff_vz_ms": flip.vz,
        "rotation_deg": 360.0,
        "travel_m": flip.travel,
    }
