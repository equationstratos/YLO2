"""Figures : salto arrière, double salto, 540 McTwist.

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
from .natural import constrain, level_to_body, unwrap

G_ACC = 9.81

# poses articulaires (haa, hfe, kfe) en radians ; haa est reflété par patte
POSE: Dict[str, Dict[str, Tuple[float, float, float]]] = {
    "tuck":   {"front": (0.0, 1.55, -2.55), "hind": (0.0, 1.35, -2.60)},
    "pike":   {"front": (0.0, 1.70, -2.35), "hind": (0.0, 1.15, -2.50)},
    "reach":  {"front": (0.0, 0.55, -1.45), "hind": (0.0, 0.85, -1.70)},
    "twist":  {"front": (0.35, 1.45, -2.45), "hind": (-0.35, 1.30, -2.50)},
    "launch": {"front": (0.0, 0.35, -0.95), "hind": (0.0, 0.30, -0.85)},
}


@dataclass(frozen=True)
class WheelFigure:
    """Figure sur roues : la caisse est pilotée, les jambes tiennent la roue."""

    name: str
    label: str
    kind: str                   # wheelie, spin, jump, flip
    arm: float = 0.25
    rise: float = 0.40
    hold: float = 1.30
    drop: float = 0.45
    spin: float = 1.20
    settle: float = 0.35
    crouch: float = 0.30
    push: float = 0.16
    land: float = 0.26
    recover: float = 0.34
    pitch: float = -0.55
    lift: float = 0.34
    turns: float = 0.0
    twist: float = 0.0          # tours de lacet (540 McTwist : 1,5)
    cork: float = 0.0           # gîte pendant la vrille (rad)
    lean: float = 0.20
    vz: float = 0.0
    crouch_z: float = 0.80
    tuck: float = 0.15
    mode: str = "roues"

    @property
    def flight(self) -> float:
        return 2.0 * self.vz / G_ACC if self.vz else 0.0

    @property
    def apex(self) -> float:
        return self.vz ** 2 / (2 * G_ACC) if self.vz else 0.0

    @property
    def duration(self) -> float:
        if self.kind == "wheelie":
            return self.arm + self.rise + self.hold + self.drop
        if self.kind == "spin":
            return self.arm + self.spin + self.settle
        return self.crouch + self.push + self.flight + self.land + self.recover


WHEEL_FIGURES: Dict[str, WheelFigure] = {
    "wheelie": WheelFigure("wheelie", "Cabrage", "wheelie"),
    "pirouette": WheelFigure("pirouette", "Pirouette", "spin", arm=0.22, spin=1.20,
                             settle=0.35, turns=1.5, lean=0.20),
    "wheeljump": WheelFigure("wheeljump", "Saut", "jump", crouch=0.30, push=0.16,
                             land=0.26, recover=0.34, vz=2.30, crouch_z=0.80, tuck=0.15),
    "wheelflip": WheelFigure("wheelflip", "Salto roues", "flip", crouch=0.34, push=0.20,
                             land=0.26, recover=0.42, vz=2.95, crouch_z=0.72,
                             turns=1.0, tuck=0.20),
    # Deux tours sur roues : même impulsion que sur pattes (4,2 m/s), donc
    # accroupissement plus franc et reprise allongée.
    "wheeldoubleflip": WheelFigure("wheeldoubleflip", "Double salto roues", "flip",
                                   crouch=0.40, push=0.22, land=0.28, recover=0.50,
                                   vz=4.20, crouch_z=0.66, turns=2.0, tuck=0.16),
    # McTwist : salto complet pendant que la caisse vrille d'un tour et demi,
    # avec un peu de gîte pour incliner l'axe de vrille.
    "wheeltwist540": WheelFigure("wheeltwist540", "540 McTwist roues", "flip",
                                 crouch=0.36, push=0.20, land=0.26, recover=0.46,
                                 vz=3.35, crouch_z=0.70, turns=1.0, twist=1.5,
                                 cork=0.45, tuck=0.18),
}


@dataclass(frozen=True)
class Figure:
    """Une figure : phases au sol, envol balistique, rotations."""

    name: str = "backflip"
    label: str = "Salto arrière"
    turns: float = 1.0          # tours de tangage
    twist: float = 0.0          # tours de lacet (540 McTwist : 1,5)
    cork: float = 0.0           # inclinaison de vrille (rad)
    air: str = "tuck"           # pose en l'air
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


FIGURES: Dict[str, Figure] = {
    "backflip": Figure(),
    "doubleflip": Figure(
        name="doubleflip", label="Double salto", turns=2.0, air="pike",
        vz=4.20, crouch=0.40, load=0.12, push=0.21, land=0.26, recover=0.50,
        crouch_z=0.155, takeoff_z=0.33, absorb_z=0.175, travel=-0.16),
    "mctwist540": Figure(
        name="mctwist540", label="540 McTwist", turns=1.0, twist=1.5,
        cork=0.45, air="twist", vz=3.35, crouch=0.36, load=0.10, push=0.20,
        land=0.24, recover=0.46, crouch_z=0.160, takeoff_z=0.32,
        absorb_z=0.180, travel=-0.06),
}

DEFAULT_FLIP = FIGURES["backflip"]
Backflip = Figure          # compatibilité avec l'ancien nom


def _smooth(s: float) -> float:
    return s * s * (3.0 - 2.0 * s)


def _smoother(s: float) -> float:
    return s * s * s * (s * (s * 6 - 15) + 10)


def _pose_for(leg: Leg, pose: str) -> Tuple[float, float, float]:
    base = POSE[pose]["front" if leg.front > 0 else "hind"]
    return (base[0] * leg.mirror, base[1], base[2])       # l'abduction se reflète


def perform_wheels(robot, fig: WheelFigure) -> Dict[str, float]:
    """Figure sur roues : hauteur d'axe imposée à chaque roue, caisse pilotée."""
    from . import gait as gaitmod

    model = robot.model
    dt = robot.dt
    nat = robot.natural
    base = robot.terrain.height_at(robot.base[0], robot.base[1])
    ride = robot.height * 0.92
    radius = gaitmod.WHEEL_RADIUS
    yaw0 = robot.base[5]
    takeoff_q: List[float] = []
    for leg in model.legs:
        nat.fig_axle[leg.name] = None

    def place(axle, contact_of=None) -> None:
        cy, sy = math.cos(robot.base[5]), math.sin(robot.base[5])
        for i, leg in enumerate(model.legs):
            nx, ny = leg.x, leg.y + leg.mirror * model.abad_plane
            wx = robot.base[0] + cy * nx - sy * ny
            wy = robot.base[1] + sy * nx + cy * ny
            rel = axle(leg, robot.terrain.height_at(wx, wy)) - robot.base[2]
            prev = nat.fig_axle[leg.name]
            if prev is not None:                      # débattement borné
                rel = min(max(rel, prev - 1.6 * dt), prev + 1.6 * dt)
            nat.fig_axle[leg.name] = rel
            z = robot.base[2] + rel
            dx, dy = wx - robot.base[0], wy - robot.base[1]
            level = (cy * dx + sy * dy, -sy * dx + cy * dy, z - robot.base[2])
            target = constrain(model, leg,
                               level_to_body(level, robot.base[3], robot.base[4], 0.0))
            unwrap(robot.q, i, kin.inverse(leg, *target, model=model))
            robot.contacts[i] = contact_of(leg) if contact_of else True
            robot.foot_world[leg.name] = [wx, wy, z - radius]

    def pose_from(start, pose, k):
        for i, leg in enumerate(model.legs):
            pb = _pose_for(leg, pose)
            for j in range(3):
                q0 = start[i * 3 + j]
                robot.q[i * 3 + j] = q0 + (pb[j] - q0) * k
            robot.contacts[i] = False

    def pose_mix(a, b, k):
        for i, leg in enumerate(model.legs):
            pa, pb = _pose_for(leg, a), _pose_for(leg, b)
            for j in range(3):
                robot.q[i * 3 + j] = pa[j] + (pb[j] - pa[j]) * k
            robot.contacts[i] = False

    robot.pose_mode = "joint"
    steps = max(1, round(fig.duration / dt))

    for n in range(steps + 1):
        t = n * dt
        cy, sy = math.cos(robot.base[5]), math.sin(robot.base[5])
        robot.base[0] += nat.vx * cy * dt
        robot.base[1] += nat.vx * sy * dt
        for leg in model.legs:
            ny = leg.y + leg.mirror * model.abad_plane
            nat.spin[leg.name] = (nat.spin[leg.name]
                                  + (nat.vx - nat.wz * ny) / radius * dt) % math.tau

        if fig.kind == "wheelie":
            t1, t2, t3 = fig.arm, fig.arm + fig.rise, fig.arm + fig.rise + fig.hold
            if t < t1:
                s = _smooth(t / t1)
                robot.base[2] = base + ride * (1 - 0.12 * s) + radius
                robot.base[4] = 0.06 * s
                place(lambda leg, h: h + radius)
            elif t < t2:
                s = _smooth((t - t1) / fig.rise)
                robot.base[4] = 0.06 + (fig.pitch - 0.06) * s
                robot.base[2] = base + ride * (0.88 + 0.16 * s) + radius
                place(lambda leg, h, s=s: h + radius + (fig.lift * s if leg.front > 0 else 0.0),
                      lambda leg: leg.front < 0)
            elif t < t3:
                s = (t - t2) / fig.hold
                robot.base[4] = fig.pitch + math.sin(s * math.pi * 6) * 0.035
                robot.base[2] = base + ride * 1.04 + radius
                place(lambda leg: 0, None) if False else place(
                    lambda leg, h: h + radius + (fig.lift if leg.front > 0 else 0.0),
                    lambda leg: leg.front < 0)
            else:
                s = _smooth((t - t3) / fig.drop)
                robot.base[4] = fig.pitch * (1 - s)
                robot.base[2] = base + ride * (1.04 - 0.04 * s) + radius
                place(lambda leg, h, s=s: h + radius + (fig.lift * (1 - s) if leg.front > 0 else 0.0),
                      lambda leg, s=s: leg.front < 0 or s > 0.8)
        elif fig.kind == "spin":
            t1, t2 = fig.arm, fig.arm + fig.spin
            if t < t1:
                s = _smooth(t / t1)
                robot.base[2] = base + ride * (1 - 0.10 * s) + radius
                robot.base[3] = fig.lean * 0.4 * s
            elif t < t2:
                s = (t - t1) / fig.spin
                robot.base[5] = yaw0 + math.tau * fig.turns * _smoother(s)
                robot.base[3] = fig.lean * math.sin(math.pi * s)
                robot.base[2] = base + ride * 0.90 + radius
                nat.wz = math.tau * fig.turns / fig.spin
            else:
                s = _smooth((t - t2) / fig.settle)
                robot.base[5] = yaw0 + math.tau * fig.turns
                robot.base[3] = fig.lean * 0.2 * (1 - s)
                robot.base[2] = base + ride * (0.90 + 0.10 * s) + radius
                nat.wz *= 1 - min(1.0, dt * 6)
            place(lambda leg, h: h + radius)
        else:                                            # saut et salto
            t1 = fig.crouch
            t2 = t1 + fig.push
            t3 = t2 + fig.flight
            t4 = t3 + fig.land
            if t < t1:
                s = _smooth(t / t1)
                robot.base[2] = base + ride * (1 + (fig.crouch_z - 1) * s) + radius
                robot.base[4] = (-0.10 if fig.turns else 0.04) * s
                place(lambda leg, h: h + radius)
            elif t < t2:
                s = _smooth((t - t1) / fig.push)
                robot.base[2] = base + ride * (fig.crouch_z + (1.18 - fig.crouch_z) * s) + radius
                start_p = -0.10 if fig.turns else 0.04
                end_p = -0.50 if fig.turns else -0.14
                robot.base[4] = start_p + (end_p - start_p) * s
                place(lambda leg, h: h + radius)
            elif t < t3:
                tf = t - t2
                s = tf / fig.flight
                robot.base[2] = base + ride + radius + fig.vz * tf - 0.5 * G_ACC * tf * tf
                if fig.turns:
                    robot.base[4] = -0.50 - (math.tau * fig.turns - 0.50) * _smoother(s)
                    if fig.twist:                        # vrille + gîte du McTwist
                        robot.base[5] = yaw0 + math.tau * fig.twist * _smoother(s)
                        robot.base[3] = math.sin(math.pi * s) * fig.cork
                    if not takeoff_q:
                        takeoff_q.extend(robot.q)
                    if s < 0.45:
                        pose_from(takeoff_q, "tuck", _smooth(s / 0.45))
                    else:
                        pose_mix("tuck", "reach", _smooth((s - 0.45) / 0.55))
                    for leg in model.legs:
                        nat.fig_axle[leg.name] = None
                else:
                    robot.base[4] = -0.14 + 0.24 * _smooth(s)
                    arc = math.sin(math.pi * min(max(s, 0.0), 1.0))
                    hang = (ride + radius) + (ride * 0.5 - ride - radius) * arc
                    place(lambda leg, h, hang=hang: robot.base[2] - hang, lambda leg: False)
            elif t < t4:
                s = _smooth((t - t3) / fig.land)
                robot.base[2] = base + ride * (1.0 - 0.20 * s) + radius
                robot.base[4] = (0.10 * s) if fig.turns else (0.10 - 0.04 * s)
                if fig.twist:                            # on remet la gîte à plat
                    robot.base[5] = yaw0 + math.tau * fig.twist
                    robot.base[3] *= 1 - min(1.0, dt * 8)
                if fig.turns:                            # ouverture depuis la pose de vol
                    cy2, sy2 = math.cos(robot.base[5]), math.sin(robot.base[5])
                    for i, leg in enumerate(model.legs):
                        nx, ny = leg.x, leg.y + leg.mirror * model.abad_plane
                        wx = robot.base[0] + cy2 * nx - sy2 * ny
                        wy = robot.base[1] + sy2 * nx + cy2 * ny
                        dx, dy = wx - robot.base[0], wy - robot.base[1]
                        level = (cy2 * dx + sy2 * dy, -sy2 * dx + cy2 * dy,
                                 robot.terrain.height_at(wx, wy) + radius - robot.base[2])
                        target = constrain(model, leg, level_to_body(level, robot.base[3],
                                                                     robot.base[4], 0.0))
                        ground_q = kin.inverse(leg, *target, model=model)
                        air = _pose_for(leg, "reach")
                        unwrap(robot.q, i, [air[j] + (ground_q[j] - air[j]) * s for j in range(3)])
                        robot.contacts[i] = s > 0.4
                        nat.fig_axle[leg.name] = None
                else:
                    place(lambda leg, h: h + radius, lambda leg, s=s: s > 0.4)
            else:
                s = _smooth((t - t4) / fig.recover)
                robot.base[2] = base + ride * (0.80 + 0.20 * s) + radius
                robot.base[4] = 0.10 * (1 - s)
                robot.base[3] *= 1 - min(1.0, dt * 8)
                place(lambda leg, h: h + radius)

        robot._advance_recorded()

    robot.base[3] = 0.0
    robot.base[4] = 0.0
    if fig.kind == "spin":
        robot.base[5] = yaw0 + math.tau * fig.turns
        nat.wz = 0.0
    if fig.twist:
        robot.base[5] = yaw0 + math.tau * fig.twist
    nat.z_body, nat.vz = robot.base[2], 0.0
    for leg in model.legs:
        nat.wheel_z[leg.name] = None
        nat.wstep[leg.name] = None
    robot.pose_mode = "gait"

    return {
        "figure": fig.label,
        "duration_s": round(fig.duration, 3),
        "flight_s": round(fig.flight, 3),
        "apex_m": round(fig.apex, 3),
        "takeoff_vz_ms": fig.vz,
        "rotation_deg": round(360.0 * fig.turns if fig.kind == "flip" else 0.0, 1),
        "twist_deg": round(360.0 * (fig.turns if fig.kind == "spin" else fig.twist), 1),
        "travel_m": 0.0,
    }


def perform(robot, flip: Figure = DEFAULT_FLIP) -> Dict[str, float]:
    """Exécute la figure sur un robot, en enregistrant chaque pas."""
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

    robot.pose_mode = "joint"                  # le générateur d'allure est débrayé
    phases: List[str] = []
    takeoff_q: List[float] = []                # pose au décollage, départ du groupé
    yaw0 = robot.base[5]

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
            robot.base[4] = -0.55 - (2 * math.pi * flip.turns - 0.55) * _smoother(s)
            if flip.twist:
                robot.base[5] = yaw0 + 2 * math.pi * flip.twist * _smoother(s)
                robot.base[3] = math.sin(math.pi * s) * flip.cork
            robot.base[0] += flip.travel * dt / flip.flight
            if not takeoff_q:
                takeoff_q.extend(robot.q)                   # on part de la pose réelle
            if s < 0.45:                                   # groupé
                pose_from(takeoff_q, flip.air, _smooth(s / 0.45))
            else:                                          # ouverture vers le sol
                pose_mix(flip.air, "reach", _smooth((s - 0.45) / 0.55))
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

        if t >= t_fly:
            robot.base[3] += (0.0 - robot.base[3]) * min(1.0, dt * 8)
        elif not flip.twist:
            robot.base[3] = 0.0
        robot._advance_recorded()

    robot.base[4] = 0.0
    robot.base[3] = 0.0
    robot.base[2] = robot.terrain.height_at(robot.base[0], robot.base[1]) + robot.height
    # la couche de marche repart d'appuis neufs, sinon les pieds sautent
    nat = robot.natural
    nat.z_body, nat.vz, nat.air = robot.base[2], 0.0, False
    for leg in model.legs:
        nat.plant[leg.name] = None
        nat.land[leg.name] = None
        nat.prev_foot[leg.name] = None
        nat.lift[leg.name] = None
    if flip.twist:
        robot.base[5] = yaw0 + 2 * math.pi * flip.twist
    robot.pose_mode = "gait"

    return {
        "figure": flip.label,
        "duration_s": round(flip.duration, 3),
        "flight_s": round(flip.flight, 3),
        "apex_m": round(flip.apex, 3),
        "takeoff_vz_ms": flip.vz,
        "rotation_deg": round(360.0 * flip.turns, 1),
        "twist_deg": round(360.0 * flip.twist, 1),
        "travel_m": flip.travel,
    }
