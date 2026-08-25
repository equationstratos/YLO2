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
from typing import Dict, List, Optional, Sequence, Tuple

from . import gait as gaitmod
from .model import DEFAULT, Leg, Model

G_ACC = 9.81


@dataclass
class Params:
    accel_lin: float = 1.20         # m/s²
    accel_ang: float = 2.4          # rad/s²
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
    gait_scale: float = 1.0         # décalage des seuils d'allure
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
            accel_lin=1.00, accel_ang=1.9, raibert=0.05, retraction=1.30,
            dip=0.016, sway=0.024, sway_lead=0.16, bank=0.80,
            pitch_accel=0.10, pitch_gait=0.004, breath=0.005,
            trot_above=0.17, walk_below=0.12, track=0.55,
            swing_scale=0.80, yaw_wag=0.020, height_bias=0.93,
            hind_reach=0.022, settle=0.14, cycle_scale=1.20, blend=1.8,
            gait_scale=1.25, duty_bias=0.05,
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


def constrain(model, leg, t):
    """Ramène la cible dans l'enveloppe de la patte : au-dessus de la hanche
    ou trop loin, la cinématique inverse changerait de branche."""
    hx, hy, hz = leg.x, leg.y, model.leg_offset_z
    dx, dy, dz = t[0] - hx, t[1] - hy, t[2] - hz
    dz = min(dz, -0.06)
    off = abs(model.abad_plane)
    lat = math.hypot(dy, dz)
    if lat < off * 1.06:
        dz -= off * 1.06 - lat
    reach = math.sqrt(dx * dx + dy * dy + dz * dz)
    hi, lo = (model.l1 + model.l2) * 0.985, abs(model.l1 - model.l2) + 0.045
    if reach > hi:
        k = hi / reach
        dx, dy, dz = dx * k, dy * k, dz * k
    elif 1e-6 < reach < lo:
        k = lo / reach
        dx, dy, dz = dx * k, dy * k, dz * k
    return hx + dx, hy + dy, hz + dz


def unwrap(q, leg_index, angles):
    """Angles continus : on garde la branche la plus proche du pas précédent."""
    base = leg_index * 3
    for j, value in enumerate(angles):
        prev = q[base + j]
        while value - prev > math.pi:
            value -= math.tau
        while prev - value > math.pi:
            value += math.tau
        q[base + j] = value


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
    lift: Dict[str, Tuple[float, float, float]] = field(default_factory=dict)
    plant: Dict[str, Tuple[float, float, float]] = field(default_factory=dict)
    land: Dict[str, list] = field(default_factory=dict)
    clear: Dict[str, float] = field(default_factory=dict)
    prev_foot: Dict[str, Tuple[float, float, float]] = field(default_factory=dict)
    wheel_z: Dict[str, Optional[float]] = field(default_factory=dict)
    wstep: Dict[str, Optional[dict]] = field(default_factory=dict)
    fig_axle: Dict[str, Optional[float]] = field(default_factory=dict)
    spin: Dict[str, float] = field(default_factory=dict)
    sway: float = 0.0
    yaw_wag: float = 0.0
    trot_mix: float = 1.0
    rough: float = 0.0
    governor: float = 1.0
    air: bool = False
    vz: float = 0.0
    z_body: float = 0.25
    air_time: float = 0.0
    last_air: float = 0.0
    wheel_warn: float = 0.0
    wheel_warn_max: float = 0.0
    # sens de marche des roues : un 540 se reçoit en fakie, roues en arrière
    direction: int = 1
    # fondu de pose : après une figure, la marche reprend depuis la pose de
    # sortie plutôt que d'y sauter d'une image (équivalent de Motion.blendFrom)
    morph_from: Optional[List[float]] = None
    morph_k: float = 1.0
    morph_dur: float = 0.3

    def __post_init__(self) -> None:
        g = gaitmod.GAITS["trot"]
        self.duty, self.stance = g.duty, g.stance
        self.trot_mix = 1.0
        for leg in self.model.legs:
            self.off.setdefault(leg.name, g.offsets[leg.name])
            for store in (self.lift, self.plant, self.land, self.prev_foot, self.wheel_z,
                          self.wstep, self.fig_axle):
                store.setdefault(leg.name, None)
            self.clear.setdefault(leg.name, 0.0)
            self.spin.setdefault(leg.name, 0.0)

    # --- outils ----------------------------------------------------------
    def blend_from(self, q: Sequence[float], seconds: float = 0.3) -> None:
        """Reprend la marche depuis la pose `q`, fondue en `seconds`."""
        self.morph_from = list(q)
        self.morph_dur = max(seconds, 1e-3)
        self.morph_k = 0.0

    def _apply_morph(self, robot, dt: float) -> None:
        if self.morph_from is None or self.morph_k >= 1.0:
            return
        self.morph_k = min(1.0, self.morph_k + dt / self.morph_dur)
        e = self.morph_k * self.morph_k * (3.0 - 2.0 * self.morph_k)
        for i in range(len(robot.q)):
            robot.q[i] = self.morph_from[i] + (robot.q[i] - self.morph_from[i]) * e
        if self.morph_k >= 1.0:
            self.morph_from = None

    @staticmethod
    def _approach(current: float, target: float, rate: float, dt: float) -> float:
        step = rate * dt
        if abs(target - current) <= step:
            return target
        return current + math.copysign(step, target - current)

    def _blend_gait(self, g: gaitmod.Gait, dt: float, speed: float = 0.0) -> None:
        k = min(1.0, dt * self.params.blend)
        self.duty += (g.duty - self.duty) * k
        target_stance = self.cadence(g, speed) * self.params.cycle_scale
        self.stance += (target_stance - self.stance) * k
        # le report de masse dépend de l'allure : on le fond aussi, sinon le
        # passage marche -> trot déplace les appuis d'un coup
        target = 0.0 if g.name == "walk" else 1.0
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

    # --- échelle d'allures --------------------------------------------------
    def pick_gait(self, current: str) -> str:
        """Pas, trot, canter, galop : l'allure suit la vitesse."""
        if not self.auto or current in ("pace", "bound"):
            return current
        speed = math.hypot(self.vx, self.vy) + abs(self.wz) * 0.12
        if speed < 0.02:
            return "stand"
        bounds = [math.sqrt(gaitmod.SPEED_REF[a] * gaitmod.SPEED_REF[b]) * self.params.gait_scale
                  for a, b in zip(gaitmod.LADDER, gaitmod.LADDER[1:])]
        want = gaitmod.LADDER[-1]
        for name, edge in zip(gaitmod.LADDER, bounds):
            if speed < edge:
                want = name
                break
        if current in gaitmod.LADDER:
            cur, idx = gaitmod.LADDER.index(current), gaitmod.LADDER.index(want)
            if abs(idx - cur) == 1:                     # hystérésis
                edge = bounds[min(cur, idx)]
                if idx > cur and speed < edge * 1.08:
                    return current
                if idx < cur and speed > edge * 0.92:
                    return current
        return want

    @staticmethod
    def cadence(g: gaitmod.Gait, speed: float) -> float:
        """Durée d'appui : décroît en v^-0.55, comme chez l'animal."""
        ref = gaitmod.SPEED_REF.get(g.name, 0.5)
        if not ref:
            return g.stance
        v = max(speed, 0.04)
        return min(max(g.stance * (ref / v) ** 0.55, g.stance * 0.55), g.stance * 2.2)

    # --- pas de simulation ---------------------------------------------------
    def step(self, robot, dt: float) -> None:
        from . import kinematics as kin

        p = self.params
        model = self.model
        terrain = robot.terrain
        cmd_vx, cmd_vy, cmd_wz = robot.vx, robot.vy, robot.wz
        prev_vx = self.vx

        # relief devant : on ralentit avant de l'aborder, comme un vrai robot
        ahead = terrain.step_ahead(robot.base[0], robot.base[1], robot.base[5], 0.75)
        self.rough += (ahead - self.rough) * min(1.0, dt * 3)
        self.governor = min(max(1.0 - self.rough / 0.22, 0.25), 1.0)

        self.vx = self._approach(self.vx, cmd_vx * self.governor, p.accel_lin, dt)
        self.vy = self._approach(self.vy, cmd_vy * self.governor, p.accel_lin, dt)
        self.wz = self._approach(self.wz, cmd_wz, p.accel_ang, dt)
        self.ax += ((self.vx - prev_vx) / max(dt, 1e-3) - self.ax) * min(1.0, dt * 6)

        speed = math.hypot(self.vx, self.vy)
        name = self.pick_gait(robot.gait.name)
        if name != robot.gait.name:
            robot.gait = gaitmod.GAITS[name]
        g = robot.gait
        self._blend_gait(g, dt, speed)

        moving = g.name != "stand"
        fast_duty = min(max(speed / 1.4, 0.0), 1.0)
        duty = (min(max(self.duty + p.duty_bias - 0.10 * fast_duty, 0.28), 0.80)
                if moving else 1.0)
        stance = self.stance
        cycle = stance / max(duty, 0.05)
        rough_k = min(max(self.rough / 0.20, 0.0), 1.0)
        height = robot.height * p.height_bias * (1 + rough_k * 0.18)

        if moving:
            robot.phase = (robot.phase + dt / cycle) % 1.0
            yaw = robot.base[5] + self.wz * dt
            robot.base[0] += (self.vx * math.cos(yaw) - self.vy * math.sin(yaw)) * dt
            robot.base[1] += (self.vx * math.sin(yaw) + self.vy * math.cos(yaw)) * dt
            robot.base[5] = yaw

        fast = min(max(speed / 1.2, 0.0), 1.0)
        sway_phase = ((robot.phase + p.sway_lead) * math.tau
                      + math.pi / 2 * (1.0 - self.trot_mix))
        amp = p.sway * (1.0 + (0.45 - 1.0) * self.trot_mix) * (1 - 0.6 * fast)
        self.sway = math.sin(sway_phase) * amp if moving else 0.0
        self.yaw_wag = -math.sin(sway_phase) * p.yaw_wag * (1 - 0.5 * fast) if moving else 0.0
        swing_h = robot.swing * p.swing_scale * (1 + 1.1 * fast) + self.rough * 0.55

        cy, sy = math.cos(robot.base[5]), math.sin(robot.base[5])
        contacts, support = 0, []

        for i, leg in enumerate(model.legs):
            nx = leg.x + (p.hind_reach if leg.front < 0 else 0.0)
            ny = (leg.y + leg.mirror * model.abad_plane) * p.track - self.sway
            hip = (robot.base[0] + cy * nx - sy * ny, robot.base[1] + sy * nx + cy * ny)

            vfx = self.vx - self.wz * ny
            vfy = self.vy + self.wz * nx
            wvx, wvy = cy * vfx - sy * vfy, sy * vfx + cy * vfy

            ph = (robot.phase + self.off[leg.name]) % 1.0

            if not moving:
                foot = [hip[0], hip[1], terrain.height_at(hip[0], hip[1])]
                self.plant[leg.name] = list(foot)
                contact = True
            elif ph < duty:                                   # appui
                if self.plant[leg.name] is None:
                    src = self.prev_foot[leg.name] or self.land[leg.name] or [hip[0], hip[1], 0.0]
                    self.plant[leg.name] = [src[0], src[1], terrain.height_at(src[0], src[1])]
                foot = list(self.plant[leg.name])
                self.lift[leg.name] = list(foot)
                contact = True
            else:                                             # vol
                s = (ph - duty) / (1.0 - duty)
                if self.plant[leg.name] is not None:
                    self.lift[leg.name] = list(self.plant[leg.name])
                    self.plant[leg.name] = None
                p0 = self.lift[leg.name] or [hip[0], hip[1], 0.0]

                err_x = (self.vx - cmd_vx) * p.raibert
                err_y = (self.vy - cmd_vy) * p.raibert
                tdx = hip[0] + wvx * stance * 0.5 + (cy * err_x - sy * err_y)
                tdy = hip[1] + wvy * stance * 0.5 + (sy * err_x + cy * err_y)

                # pas raccourci si la cible sort du domaine atteignable
                drop = self.z_body + model.leg_offset_z - terrain.height_at(tdx, tdy)
                max_h = math.sqrt(max(0.01, ((model.l1 + model.l2) * 0.93) ** 2 - drop * drop))
                dxh, dyh = tdx - hip[0], tdy - hip[1]
                horiz = math.hypot(dxh, dyh)
                if horiz > max_h:
                    k = max_h / horiz
                    tdx, tdy = hip[0] + dxh * k, hip[1] + dyh * k
                wanted = [tdx, tdy, terrain.height_at(tdx, tdy)]
                obstacle = terrain.max_height_along(p0[0], p0[1], tdx, tdy, 8)

                if self.land[leg.name] is None:
                    self.land[leg.name] = wanted
                    self.clear[leg.name] = obstacle
                else:
                    kl = min(1.0, dt * 9)
                    for j in range(3):
                        self.land[leg.name][j] += (wanted[j] - self.land[leg.name][j]) * kl
                    self.clear[leg.name] += (obstacle - self.clear[leg.name]) * kl
                land = self.land[leg.name]

                tan_x = wvx * stance * (1 - duty) / duty
                tan_y = wvy * stance * (1 - duty) / duty
                fx = hermite(p0[0], land[0], tan_x, s, p.retraction)
                fy = hermite(p0[1], land[1], tan_y, s, p.retraction)
                line = p0[2] + (land[2] - p0[2]) * smoothstep(s)
                over = max(0.0, max(p0[2], land[2], self.clear[leg.name]) - line)
                fz = line + over * math.sin(math.pi * min(max(s, 0.0), 1.0)) \
                    + swing_h * swing_height(s, p.settle)
                foot = [fx, fy, fz]
                contact = False

            # limiteur : un pied ne va pas plus vite que les actionneurs
            prev = self.prev_foot[leg.name]
            if prev:
                d = math.dist(foot, prev)
                maxd = 3.2 * dt
                if d > maxd:
                    k = maxd / d
                    foot = [prev[j] + (foot[j] - prev[j]) * k for j in range(3)]
            self.prev_foot[leg.name] = list(foot)

            robot.foot_world[leg.name] = foot
            robot.contacts[i] = contact
            if contact:
                contacts += 1
                support.append((leg, foot))

        # --- caisse : appuis au sol, sinon vol balistique ---
        if support:
            mean = sum(f[2] for _, f in support) / len(support)
            highest = max(f[2] for _, f in support)
            ground_z = mean + (highest - mean) * 0.55
        else:
            ground_z = self.z_body - height

        dip = p.dip * (1 + 2.4 * fast) if moving else 0.0
        breath = 0.0 if moving else math.sin(robot.t * 1.6) * p.breath
        z_target = ground_z + height - dip * 0.5 + breath

        if contacts == 0:
            self.air = True
            self.air_time += dt
            self.vz -= G_ACC * dt
            self.z_body += self.vz * dt
            if self.z_body < z_target:
                self.z_body, self.vz = z_target, 0.0
        else:
            if self.air:
                self.last_air = self.air_time
                self.air_time = 0.0
                self.vz = min(self.vz, -0.15)
            self.air = False
            k, c = 90.0, 2 * math.sqrt(90.0) * 0.85
            acc = k * (z_target - self.z_body) - c * self.vz
            self.vz = min(max(self.vz + acc * dt, -1.0), 1.0)
            self.z_body += self.vz * dt
        robot.base[2] = self.z_body

        front = [f[2] for l, f in support if l.front > 0]
        rear = [f[2] for l, f in support if l.front < 0]
        left = [f[2] for l, f in support if l.mirror > 0]
        right = [f[2] for l, f in support if l.mirror < 0]
        slope_pitch = (math.atan2(sum(rear) / len(rear) - sum(front) / len(front),
                                  2 * model.leg_offset_x) if front and rear else 0.0)
        slope_roll = (math.atan2(sum(left) / len(left) - sum(right) / len(right),
                                 2 * model.leg_offset_y) if left and right else 0.0)
        bank = math.atan2(self.vx * self.wz, G_ACC)
        pitch_gait = (math.sin(robot.phase * math.pi * 4 + 1.1) * p.pitch_gait * (1 + 2.2 * fast)
                      if moving else 0.0)
        robot.base[3] += (slope_roll - bank * p.bank + self.sway * 0.9 - robot.base[3]) * min(1.0, dt * 6)
        robot.base[4] += (slope_pitch + min(max(self.ax, -2), 2) * p.pitch_accel + pitch_gait
                          - robot.base[4]) * min(1.0, dt * 6)

        # --- cinématique inverse ---
        for i, leg in enumerate(model.legs):
            f = robot.foot_world[leg.name]
            dx, dy = f[0] - robot.base[0], f[1] - robot.base[1]
            level = (cy * dx + sy * dy, -sy * dx + cy * dy, f[2] - robot.base[2])
            target = constrain(model, leg, level_to_body(level, robot.base[3], robot.base[4],
                                                         self.yaw_wag))
            angles = kin.inverse(leg, *target, model=model)
            unwrap(robot.q, i, angles)
        self._apply_morph(robot, dt)

    # --- mode roues, à la manière des Go2-W --------------------------------
    def step_wheels(self, robot, dt: float) -> None:
        from . import kinematics as kin

        model = self.model
        terrain = robot.terrain
        ahead = terrain.step_ahead(robot.base[0], robot.base[1], robot.base[5], 0.9)
        self.rough += (ahead - self.rough) * min(1.0, dt * 3)
        self.governor = min(max(1.0 - self.rough / 0.30, 0.28), 1.0)

        cmd_vx = (min(max(robot.vx * self.direction, -gaitmod.MAX_WHEEL_SPEED),
                      gaitmod.MAX_WHEEL_SPEED) * self.governor)
        prev_vx = self.vx

        # freinage plus vif que l'accélération, et arrêt franc
        braking = abs(cmd_vx) < abs(self.vx) * 0.98
        self.vx = self._approach(self.vx, cmd_vx, 4.5 if braking else 2.4, dt)
        if abs(cmd_vx) < 1e-3 and abs(self.vx) < 0.02:
            self.vx = 0.0
        self.vy = self._approach(self.vy, 0.0, 2.4, dt)
        self.wz = self._approach(self.wz, robot.wz, 3.2, dt)
        self.ax += ((self.vx - prev_vx) / max(dt, 1e-3) - self.ax) * min(1.0, dt * 8)

        robot.phase = (robot.phase + dt * 0.6) % 1.0
        robot.base[5] += self.wz * dt
        robot.base[0] += self.vx * math.cos(robot.base[5]) * dt
        robot.base[1] += self.vx * math.sin(robot.base[5]) * dt

        cy, sy = math.cos(robot.base[5]), math.sin(robot.base[5])
        rough_k = min(max(self.rough / 0.25, 0.0), 1.0)
        height = robot.height * 0.92 * (1 + rough_k * 0.22)
        heights, points, grounded = [], [], []
        partner = {"lf": "rh", "rh": "lf", "rf": "lh", "lh": "rf"}
        stepping = sum(1 for l in model.legs if self.wstep.get(l.name))

        for leg in model.legs:
            nx, ny = leg.x, leg.y + leg.mirror * model.abad_plane
            wx = robot.base[0] + cy * nx - sy * ny
            wy = robot.base[1] + sy * nx + cy * ny
            raw = terrain.height_at(wx, wy)

            # une roue de 75 mm ne monte pas une marche de 130 mm : la patte
            # la soulève par-dessus, comme le fait un Go2-W
            look = 0.22 if self.vx >= 0 else -0.22
            ahead_h = terrain.height_at(wx + cy * look, wy + sy * look)
            rise = ahead_h - raw
            if (not self.wstep.get(leg.name) and abs(rise) > gaitmod.WHEEL_RADIUS * 0.45
                    and stepping < 2 and not self.wstep.get(partner[leg.name])
                    and abs(self.vx) < 1.5):
                cur = self.wheel_z[leg.name]
                self.wstep[leg.name] = {"t": 0.0, "dur": 0.34,
                                        "from": raw if cur is None else cur, "to": ahead_h}
                stepping += 1

            st = self.wstep.get(leg.name)
            contact = True
            if st:
                st["t"] += dt
                s_ = min(max(st["t"] / st["dur"], 0.0), 1.0)
                line = st["from"] + (st["to"] - st["from"]) * smoothstep(s_)
                top = max(st["from"], st["to"])
                h = line + (0.055 + max(0.0, top - max(st["from"], st["to"]))) * math.sin(math.pi * s_)
                contact = s_ > 0.85
                if s_ >= 1.0:
                    self.wheel_z[leg.name] = st["to"]
                    self.wstep[leg.name] = None
            else:
                prev = self.wheel_z[leg.name]
                if prev is None:
                    h = raw
                else:                              # suspension : vitesse bornée
                    target = prev + (raw - prev) * min(1.0, dt * 8)
                    rate = 0.55 * dt
                    h = min(max(target, prev - rate), prev + rate)
            self.wheel_z[leg.name] = h
            heights.append((leg, h))
            points.append((wx, wy, h, contact))
            if contact:
                grounded.append(h)
            v_wheel = self.vx - self.wz * ny
            self.spin[leg.name] = (self.spin[leg.name]
                                   + v_wheel / gaitmod.WHEEL_RADIUS * dt) % math.tau

        ground = sum(grounded) / len(grounded) if grounded else self.z_body - height - gaitmod.WHEEL_RADIUS
        z_target = ground + height + gaitmod.WHEEL_RADIUS
        k, c = 60.0, 2 * math.sqrt(60.0) * 0.9
        self.vz += (k * (z_target - self.z_body) - c * self.vz) * dt
        self.z_body += self.vz * dt
        robot.base[2] = self.z_body

        front = [h for l, h in heights if l.front > 0]
        rear = [h for l, h in heights if l.front < 0]
        left = [h for l, h in heights if l.mirror > 0]
        right = [h for l, h in heights if l.mirror < 0]
        bank = math.atan2(self.vx * self.wz, G_ACC)
        robot.base[4] += (math.atan2(sum(rear) / 2 - sum(front) / 2, 2 * model.leg_offset_x)
                          + min(max(self.ax, -4), 4) * 0.10 - robot.base[4]) * min(1.0, dt * 8)
        robot.base[3] += (math.atan2(sum(left) / 2 - sum(right) / 2, 2 * model.leg_offset_y)
                          - bank * 0.9 - robot.base[3]) * min(1.0, dt * 8)
        self.sway = self.yaw_wag = 0.0

        step = terrain.step_ahead(robot.base[0], robot.base[1], robot.base[5], 0.7)
        self.wheel_warn = step if step > gaitmod.WHEEL_RADIUS * 0.9 else 0.0
        self.wheel_warn_max = max(self.wheel_warn_max, self.wheel_warn)

        for i, (leg, (wx, wy, h, contact)) in enumerate(zip(model.legs, points)):
            dx, dy = wx - robot.base[0], wy - robot.base[1]
            level = (cy * dx + sy * dy, -sy * dx + cy * dy,
                     h + gaitmod.WHEEL_RADIUS - robot.base[2])
            target = constrain(model, leg, level_to_body(level, robot.base[3], robot.base[4], 0.0))
            angles = kin.inverse(leg, *target, model=model)
            unwrap(robot.q, i, angles)
            robot.contacts[i] = contact
            robot.foot_world[leg.name] = [wx, wy, h]
        self._apply_morph(robot, dt)
