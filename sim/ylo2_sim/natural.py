"""Couche de locomotion souple, identique à celle du visualiseur.

Ingrédients classiques des quadrupèdes modernes (Unitree Go2 et consorts),
tous cinématiques ici :

* consignes lissées par limitation d'accélération ;
* choix d'allure selon la vitesse, avec fondu des décalages de phase ;
* pied de vol en Hermite cubique dont les tangentes prolongent la vitesse
  d'appui — le pied quitte et retrouve le sol sans raclage ;
* placement de pose à la Raibert (demi-course + rattrapage d'erreur) ;
* enfoncement de caisse en milieu d'appui, report de masse latéral,
  inclinaison en virage, piqué proportionnel à l'accélération ;
* compensation d'assiette : les appuis restent plantés quand la caisse bouge ;
* respiration à l'arrêt.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from . import gait as gaitmod
from .model import DEFAULT, Leg, Model

G_ACC = 9.81


@dataclass
class Params:
    accel_lin: float = 0.45         # m/s²
    accel_ang: float = 2.0          # rad/s²
    raibert: float = 0.06           # gain de rattrapage de vitesse
    retraction: float = 1.18        # recul du pied juste avant le poser
    dip: float = 0.011              # enfoncement de caisse en appui (m)
    sway: float = 0.014             # report latéral de masse (m)
    sway_lead: float = 0.0          # avance de phase du report de masse
    bank: float = 0.55              # fraction de l'inclinaison idéale en virage
    pitch_accel: float = 0.16       # piqué par m/s²
    pitch_gait: float = 0.012       # oscillation de tangage sur le pas
    breath: float = 0.004           # respiration à l'arrêt (m)
    trot_above: float = 0.09        # seuil walk -> trot (m/s)
    walk_below: float = 0.06        # hystérésis trot -> walk
    blend: float = 3.5              # vitesse de fondu des allures (1/s)
    track: float = 1.0              # largeur de voie (1 = entraxe des hanches)
    duty_bias: float = 0.0          # allongement de la phase d'appui
    swing_scale: float = 1.0        # facteur de garde au sol
    yaw_wag: float = 0.0            # balancement du tronc en lacet (rad)
    height_bias: float = 1.0        # posture (1 = hauteur de consigne)
    hind_reach: float = 0.0         # avancée des appuis arrière (m)
    cycle_scale: float = 1.0        # allongement du cycle (cadence)
    settle: float = 0.0             # dépose lente en fin de vol


def profile(name: str) -> Params:
    """Réglages par style. « felin » : voie étroite, triple appui, report de
    masse anticipé, balancement du tronc, poser lent, posture basse."""
    if name in ("felin", "félin", "cat"):
        return Params(
            accel_lin=0.32, accel_ang=1.5, raibert=0.05, retraction=1.30,
            dip=0.016, sway=0.024, sway_lead=0.16, bank=0.80,
            pitch_accel=0.10, pitch_gait=0.004, breath=0.005,
            trot_above=0.17, walk_below=0.12, track=0.55, duty_bias=0.05,
            swing_scale=0.80, yaw_wag=0.020, height_bias=0.93,
            hind_reach=0.022, settle=0.14, cycle_scale=1.35, blend=1.8,
        )
    return Params()


def smoothstep(s: float) -> float:
    return s * s * (3.0 - 2.0 * s)


def hermite(p0: float, p1: float, tangent: float, s: float, retraction: float) -> float:
    """Hermite cubique, tangente de sortie allongée (retrait avant le poser)."""
    h00 = 2 * s ** 3 - 3 * s ** 2 + 1
    h10 = s ** 3 - 2 * s ** 2 + s
    h01 = -2 * s ** 3 + 3 * s ** 2
    h11 = s ** 3 - s ** 2
    return h00 * p0 + h10 * tangent + h01 * p1 + h11 * tangent * retraction


def swing_height(s: float, settle: float = 0.0) -> float:
    """Montée vive, apex avancé, poser amorti (aplati si `settle`)."""
    e = max(0.0, min(1.0, s)) ** 0.82
    base = math.sin(math.pi * e) * (1.0 - 0.18 * s)
    if settle and s > 1.0 - settle:
        base *= smoothstep((1.0 - s) / settle)
    return base


def level_to_body(v: Tuple[float, float, float], roll: float, pitch: float,
                  wag: float = 0.0):
    """Repère horizon -> repère tronc (garde les appuis plantés)."""
    cw, sw = math.cos(wag), math.sin(wag)
    x = cw * v[0] + sw * v[1]
    y = -sw * v[0] + cw * v[1]
    z = v[2]
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    return (
        cp * x - sp * z,
        sp * sr * x + cr * y + cp * sr * z,
        sp * cr * x - sr * y + cp * cr * z,
    )


@dataclass
class Natural:
    """État de la couche souple, attaché à un robot."""

    model: Model = field(default_factory=lambda: DEFAULT)
    params: Params = field(default_factory=Params)
    auto: bool = True

    vx: float = 0.0
    vy: float = 0.0
    wz: float = 0.0
    ax: float = 0.0
    duty: float = 0.5
    stance: float = 0.25
    off: Dict[str, float] = field(default_factory=dict)
    lift: Dict[str, Tuple[float, float]] = field(default_factory=dict)
    sway: float = 0.0
    yaw_wag: float = 0.0
    trot_mix: float = 1.0

    def __post_init__(self) -> None:
        g = gaitmod.GAITS["trot"]
        self.duty, self.stance = g.duty, g.stance
        self.trot_mix = 1.0
        for leg in self.model.legs:
            self.off.setdefault(leg.name, g.offsets[leg.name])
            self.lift.setdefault(leg.name, None)

    # --- outils ----------------------------------------------------------
    @staticmethod
    def _approach(current: float, target: float, rate: float, dt: float) -> float:
        step = rate * dt
        if abs(target - current) <= step:
            return target
        return current + math.copysign(step, target - current)

    def _blend_gait(self, g: gaitmod.Gait, dt: float) -> None:
        k = min(1.0, dt * self.params.blend)
        self.duty += (g.duty - self.duty) * k
        self.stance += (g.stance - self.stance) * k
        # le report de masse dépend de l'allure : on le fond aussi, sinon le
        # passage marche -> trot déplace les appuis d'un coup
        target = 1.0 if g.name in ("trot", "bound") else 0.0
        self.trot_mix += (target - self.trot_mix) * k
        for leg in self.model.legs:
            d = g.offsets[leg.name] - self.off[leg.name]
            if d > 0.5:
                d -= 1.0
            elif d < -0.5:
                d += 1.0
            self.off[leg.name] = (self.off[leg.name] + d * k) % 1.0

    def pick_gait(self, current: str) -> str:
        """Marche à basse vitesse, trot au-delà — comme un quadrupède réel."""
        if not self.auto or current in ("pace", "bound"):
            return current
        speed = math.hypot(self.vx, self.vy) + abs(self.wz) * 0.12
        if speed < 0.004:
            return "stand"
        if current == "stand":
            return "walk"
        if current != "trot" and speed > self.params.trot_above:
            return "trot"
        if current == "trot" and speed < self.params.walk_below:
            return "walk"
        return current

    # --- pas de simulation ------------------------------------------------
    def step(self, robot, dt: float) -> None:
        p = self.params
        cmd_vx, cmd_vy, cmd_wz = robot.vx, robot.vy, robot.wz
        prev_vx = self.vx

        self.vx = self._approach(self.vx, cmd_vx, p.accel_lin, dt)
        self.vy = self._approach(self.vy, cmd_vy, p.accel_lin, dt)
        self.wz = self._approach(self.wz, cmd_wz, p.accel_ang, dt)
        self.ax += ((self.vx - prev_vx) / max(dt, 1e-3) - self.ax) * min(1.0, dt * 6)

        name = self.pick_gait(robot.gait.name)
        if name != robot.gait.name:
            robot.gait = gaitmod.GAITS[name]
        g = robot.gait
        self._blend_gait(g, dt)

        moving = g.name != "stand"
        duty = min(max(self.duty + p.duty_bias, 0.4), 0.80) if moving else 1.0
        stance = self.stance * p.cycle_scale
        height = robot.height * p.height_bias

        if moving:
            cycle = stance / max(duty, 0.05)
            robot.phase = (robot.phase + dt / cycle) % 1.0
            yaw = robot.base[5] + self.wz * dt
            robot.base[0] += (self.vx * math.cos(yaw) - self.vy * math.sin(yaw)) * dt
            robot.base[1] += (self.vx * math.sin(yaw) + self.vy * math.cos(yaw)) * dt
            robot.base[5] = yaw

        # --- assiette ------------------------------------------------------
        load = 0.0
        for leg in self.model.legs:
            ph = (robot.phase + self.off[leg.name]) % 1.0
            if not moving or ph < duty:
                load += math.sin(math.pi * min(max(ph / duty, 0.0), 1.0))
        load /= 4.0

        breath = 0.0 if moving else math.sin(robot.t * 1.6) * p.breath
        robot.base[2] = height - (p.dip * load if moving else 0.0) + breath

        sway_phase = ((robot.phase + p.sway_lead) * math.tau
                      + math.pi / 2 * (1.0 - self.trot_mix))
        amp = p.sway * (1.0 + (0.45 - 1.0) * self.trot_mix)
        self.sway = math.sin(sway_phase) * amp if moving else 0.0
        # balancement du tronc en lacet : ce que ferait la colonne d'un félin
        self.yaw_wag = -math.sin(sway_phase) * p.yaw_wag if moving else 0.0

        bank = math.atan2(self.vx * self.wz, G_ACC)
        robot.base[3] += (-bank * p.bank + self.sway * 0.9 - robot.base[3]) * min(1.0, dt * 5)
        pitch_gait = math.sin(robot.phase * math.pi * 4 + 1.1) * p.pitch_gait if moving else 0.0
        target_pitch = max(-1.2, min(1.2, self.ax)) * p.pitch_accel + pitch_gait
        robot.base[4] += (target_pitch - robot.base[4]) * min(1.0, dt * 6)

        # --- pieds ---------------------------------------------------------
        from . import kinematics as kin

        for i, leg in enumerate(self.model.legs):
            # voie : le félin rapproche ses appuis de l'axe du corps
            nx = leg.x + (p.hind_reach if leg.front < 0 else 0.0)
            ny = (leg.y + leg.mirror * self.model.abad_plane) * p.track - self.sway

            vfx = self.vx - self.wz * ny
            vfy = self.vy + self.wz * nx
            sweep_x, sweep_y = vfx * stance, vfy * stance
            err_x = (self.vx - cmd_vx) * p.raibert
            err_y = (self.vy - cmd_vy) * p.raibert

            ph = (robot.phase + self.off[leg.name]) % 1.0
            fx, fy, fz, contact = nx, ny, -robot.base[2], True

            if moving:
                if ph < duty:                                   # appui
                    s = ph / duty
                    fx = nx + sweep_x * (0.5 - s)
                    fy = ny + sweep_y * (0.5 - s)
                    self.lift[leg.name] = (fx, fy)
                else:                                           # vol
                    s = (ph - duty) / (1.0 - duty)
                    p0 = self.lift[leg.name] or (nx - sweep_x * 0.5, ny - sweep_y * 0.5)
                    tan_x = sweep_x * (1.0 - duty) / duty
                    tan_y = sweep_y * (1.0 - duty) / duty
                    fx = hermite(p0[0], nx + sweep_x * 0.5 + err_x, tan_x, s, p.retraction)
                    fy = hermite(p0[1], ny + sweep_y * 0.5 + err_y, tan_y, s, p.retraction)
                    fz = -robot.base[2] + robot.swing * p.swing_scale * swing_height(s, p.settle)
                    contact = False

            target = level_to_body((fx, fy, fz), robot.base[3], robot.base[4], self.yaw_wag)
            angles = kin.inverse(leg, *target, model=self.model)
            for k, axis in enumerate(("haa", "hfe", "kfe")):
                robot.q[i * 3 + k] = angles[k]
            robot.contacts[i] = contact
