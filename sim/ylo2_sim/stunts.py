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
    kind: str                   # tilt, spin, jump, flip
    axis: str = "pitch"         # tilt : axe du basculement (pitch ou roll)
    angle: float = -1.45        # tilt : angle tenu (rad)
    stand: float = 0.34         # tilt : hauteur de caisse au-dessus de l'appui
    wobble: float = 0.030       # tilt : oscillation de tenue (rad)
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
    turns: float = 0.0
    sense: int = 1              # +1 salto arrière, -1 salto avant
    roll_turns: float = 0.0     # tours de roulis (saltos latéraux)
    entry: float = 0.20         # slide : mise en travers
    slide: float = 0.95         # slide : dérapage
    settle_slide: float = 0.45  # slide : arrêt
    yaw_sweep: float = 1.35     # slide : angle de travers (rad)
    decel: float = 3.4          # slide : freinage par le chasse des pneus
    side: int = 1               # slide et saltos latéraux : côté
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
        if self.kind == "tilt":
            return self.arm + self.rise + self.hold + self.drop
        if self.kind == "slide":
            return self.entry + self.slide + self.settle_slide
        if self.kind == "spin":
            return self.arm + self.spin + self.settle
        return self.crouch + self.push + self.flight + self.land + self.recover


WHEEL_FIGURES: Dict[str, WheelFigure] = {
    # Tenues sur deux roues : la caisse bascule autour de l'essieu resté au
    # sol pendant que les pattes porteuses se replient pour la mettre à
    # l'aplomb de cet appui.
    "wheelie": WheelFigure("wheelie", "Cabrage", "tilt", axis="pitch",
                           arm=0.30, rise=0.60, hold=1.40, drop=0.65,
                           angle=-1.45, stand=0.34, wobble=0.030),
    "sidestand": WheelFigure("sidestand", "Sur deux roues", "tilt", axis="roll",
                             arm=0.30, rise=0.70, hold=1.60, drop=0.75,
                             angle=1.40, stand=0.30, wobble=0.035),
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
    # Salto avant : même mécanique, sens inverse (`sense` = -1).
    "wheelfrontflip": WheelFigure("wheelfrontflip", "Salto avant roues", "flip",
                                  crouch=0.34, push=0.20, land=0.28, recover=0.44,
                                  vz=3.05, crouch_z=0.70, turns=1.0, sense=-1, tuck=0.18),
    # Saltos latéraux : un tour complet autour de l'axe de roulis.
    "wheelsideflipL": WheelFigure("wheelsideflipL", "Salto latéral gauche", "flip",
                                  crouch=0.34, push=0.20, land=0.28, recover=0.44,
                                  vz=3.05, crouch_z=0.70, roll_turns=1.0, tuck=0.18),
    "wheelsideflipR": WheelFigure("wheelsideflipR", "Salto latéral droit", "flip",
                                  crouch=0.34, push=0.20, land=0.28, recover=0.44,
                                  vz=3.05, crouch_z=0.70, roll_turns=-1.0, tuck=0.18),
    # Powerslide : la caisse pivote en travers, la quantité de mouvement
    # continue tout droit, les pneus chassent et le robot s'arrête.
    "powerslide": WheelFigure("powerslide", "Slide", "slide",
                              entry=0.20, slide=0.95, settle_slide=0.45,
                              yaw_sweep=1.35, lean=0.26, decel=3.4),
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
    sense: int = 1              # +1 salto arrière, -1 salto avant
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
    "frontflip": Figure(
        name="frontflip", label="Salto avant", turns=1.0, sense=-1, air="tuck",
        vz=3.10, crouch=0.34, load=0.10, push=0.19, land=0.24, recover=0.44,
        crouch_z=0.165, takeoff_z=0.32, absorb_z=0.185, travel=0.10),
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


def level_under_wheels(robot) -> float:
    """Dénivelé sous les quatre roues, en mètres.

    Une tenue fait pivoter la caisse autour d'une ligne de contact : ça
    suppose que cette ligne est horizontale. Sur une transition de quarter
    pipe ou en plein escalier elle ne l'est pas, et forcer la géométrie
    coûtait jusqu'à 132 rad/s sur la première image.
    """
    cy, sy = math.cos(robot.base[5]), math.sin(robot.base[5])
    heights = []
    for leg in robot.model.legs:
        nx, ny = leg.x, leg.y + leg.mirror * robot.model.abad_plane
        heights.append(robot.terrain.height_at(robot.base[0] + cy * nx - sy * ny,
                                               robot.base[1] + sy * nx + cy * ny))
    return max(heights) - min(heights)


def perform_wheels(robot, fig: WheelFigure) -> Dict[str, float]:
    """Figure sur roues : hauteur d'axe imposée à chaque roue, caisse pilotée."""
    from . import gait as gaitmod

    if fig.kind == "tilt":
        spread = level_under_wheels(robot)
        if spread > 0.03:
            raise ValueError(
                "%s demande un sol de niveau sous les quatre roues : "
                "%.0f mm de dénivelé ici" % (fig.label, spread * 1000))

    model = robot.model
    dt = robot.dt
    nat = robot.natural
    # Sol de référence : sous le centre de caisse en général, mais sous les
    # roues porteuses pour une tenue — c'est sur elles que tout s'appuie.
    if fig.kind == "tilt":
        cy0, sy0 = math.cos(robot.base[5]), math.sin(robot.base[5])
        heights = []
        for leg in robot.model.legs:
            grounded = (leg.mirror < 0) if fig.axis == "roll" else (leg.front < 0)
            if not grounded:
                continue
            nx, ny = leg.x, leg.y + leg.mirror * robot.model.abad_plane
            heights.append(robot.terrain.height_at(robot.base[0] + cy0 * nx - sy0 * ny,
                                                   robot.base[1] + sy0 * nx + cy0 * ny))
        base = sum(heights) / len(heights)
    else:
        base = robot.terrain.height_at(robot.base[0], robot.base[1])
    ride = robot.height * 0.92
    radius = gaitmod.WHEEL_RADIUS
    yaw0 = robot.base[5]
    takeoff_q: List[float] = []
    hold: Dict[str, object] = {"q": None, "z": 0.0, "sx": 0.0, "sy": 0.0}
    # Pendant une vrille, c'est la quantité de mouvement qui porte le robot en
    # ligne droite — pas son cap, qui tourne sous lui.
    carry_v = ([nat.vx * math.cos(yaw0), nat.vx * math.sin(yaw0)]
               if (fig.twist or fig.kind == "slide") else None)
    carry = carry_v
    fakie = [False]
    prev_a: Dict[str, List[float]] = {}
    # On amorce le limiteur de débattement sur la position réelle des pieds :
    # sinon la toute première image saute d'un rayon de roue (le pied est au
    # sol, l'essieu se veut à 75 mm) et coûte 57 rad/s.
    for i, leg in enumerate(model.legs):
        nat.fig_axle[leg.name] = kin.forward(leg, robot.q[i * 3:i * 3 + 3], model)[2]

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
        if carry:
            robot.base[0] += carry[0] * dt
            robot.base[1] += carry[1] * dt
        else:
            robot.base[0] += nat.vx * cy * dt
            robot.base[1] += nat.vx * sy * dt
        for leg in model.legs:
            ny = leg.y + leg.mirror * model.abad_plane
            nat.spin[leg.name] = (nat.spin[leg.name]
                                  + (nat.vx - nat.wz * ny) / radius * dt) % math.tau

        if fig.kind == "tilt":
            t1, t2, t3 = fig.arm, fig.arm + fig.rise, fig.arm + fig.rise + fig.hold
            if fig.axis == "roll":
                def on_ground(leg):
                    return leg.mirror < 0
            else:
                def on_ground(leg):
                    return leg.front < 0

            def axle_of(leg, k):
                """Essieu d'une patte dans le repère caisse.

                Les pattes levées gardent la pose figée à l'armement ; les
                pattes porteuses se replient pour amener la caisse à
                l'aplomb de leur essieu, sans quoi le tronc bascule derrière
                l'appui et le robot tomberait en arrière.
                """
                ny = leg.y + leg.mirror * model.abad_plane
                if not on_ground(leg):
                    return (leg.x, ny, hold["z"])
                if fig.axis == "roll":
                    a1 = (leg.x, -math.sin(fig.angle) * fig.stand,
                          -math.cos(fig.angle) * fig.stand)
                else:
                    a1 = (math.sin(fig.angle) * fig.stand, ny,
                          -math.cos(fig.angle) * fig.stand)
                a0 = (leg.x, ny, hold["z"])
                return tuple(a0[j] + (a1[j] - a0[j]) * k for j in range(3))

            def tilt(k, angle):
                """Bascule autour de l'essieu d'appui, qui reste posé."""
                roll = angle if fig.axis == "roll" else 0.0
                pitch = 0.0 if fig.axis == "roll" else angle
                robot.base[3], robot.base[4] = roll, pitch
                cr, sr = math.cos(roll), math.sin(roll)
                cp, sp = math.cos(pitch), math.sin(pitch)

                def rot(a):
                    yr = cr * a[1] - sr * a[2]
                    zr = sr * a[1] + cr * a[2]
                    return (cp * a[0] + sp * zr, yr, -sp * a[0] + cp * zr)

                # Cibles d'essieu de l'image, bornées en vitesse. Sur sol plat
                # la bascule est bien plus lente que la borne et rien ne change ;
                # sur un relief — le quarter pipe du skatepark — c'est ce qui
                # évite qu'entrer en tenue coûte 41 rad/s d'un coup.
                axles = {}
                for leg in model.legs:
                    want = list(axle_of(leg, k))
                    prev = prev_a.get(leg.name)
                    if prev is not None:
                        for j in range(3):
                            want[j] = min(max(want[j], prev[j] - 1.6 * dt),
                                          prev[j] + 1.6 * dt)
                    prev_a[leg.name] = want
                    axles[leg.name] = want

                ax = ay = az2 = fx = fy = 0.0
                n0 = 0
                for leg in model.legs:
                    if not on_ground(leg):
                        continue
                    o = rot(axles[leg.name])
                    ax += o[0]; ay += o[1]; az2 += o[2]
                    fx += leg.x; fy += leg.y + leg.mirror * model.abad_plane; n0 += 1
                ax /= n0; ay /= n0; az2 /= n0; fx /= n0; fy /= n0
                robot.base[2] = base + radius - az2
                sx, sy2 = fx - ax, fy - ay
                cy2, sy3 = math.cos(robot.base[5]), math.sin(robot.base[5])
                robot.base[0] += cy2 * (sx - hold["sx"]) - sy3 * (sy2 - hold["sy"])
                robot.base[1] += sy3 * (sx - hold["sx"]) + cy2 * (sy2 - hold["sy"])
                hold["sx"], hold["sy"] = sx, sy2
                for i, leg in enumerate(model.legs):
                    a = axles[leg.name]
                    if on_ground(leg):
                        unwrap(robot.q, i, kin.inverse(leg, *a, model=model))
                    else:
                        for j in range(3):
                            robot.q[i * 3 + j] = hold["q"][i * 3 + j]
                    o = rot(a)
                    robot.contacts[i] = on_ground(leg)
                    robot.foot_world[leg.name] = [
                        robot.base[0] + cy2 * o[0] - sy3 * o[1],
                        robot.base[1] + sy3 * o[0] + cy2 * o[1],
                        robot.base[2] + o[2] - radius,
                    ]
                    nat.fig_axle[leg.name] = None

            if t < t1:
                sc = _smooth(t / t1)
                robot.base[2] = base + ride * (1 - 0.12 * sc) + radius
                robot.base[3] = robot.base[4] = 0.0
                place(lambda leg, h: h + radius)
            else:
                if hold["q"] is None:
                    hold["q"] = list(robot.q)
                    hold["z"] = base + radius - robot.base[2]
                    hold["sx"] = hold["sy"] = 0.0
                    prev_a.clear()
                if t < t2:
                    k = _smooth((t - t1) / fig.rise)
                    tilt(k, fig.angle * k)
                elif t < t3:
                    sh = (t - t2) / fig.hold
                    tilt(1.0, fig.angle + math.sin(sh * math.pi * 5) * fig.wobble)
                else:
                    sd = _smooth((t - t3) / fig.drop)
                    if sd < 0.65:
                        k = 1 - sd / 0.65
                        tilt(k, fig.angle * k)
                    else:
                        u = _smooth((sd - 0.65) / 0.35)
                        robot.base[3] = robot.base[4] = 0.0
                        robot.base[2] = base + ride * (0.88 + 0.12 * u) + radius
                        cy2, sy3 = math.cos(robot.base[5]), math.sin(robot.base[5])
                        for i, leg in enumerate(model.legs):
                            nx, ny = leg.x, leg.y + leg.mirror * model.abad_plane
                            wx = robot.base[0] + cy2 * nx - sy3 * ny
                            wy = robot.base[1] + sy3 * nx + cy2 * ny
                            h = robot.terrain.height_at(wx, wy)
                            target = constrain(model, leg,
                                               (nx, ny, h + radius - robot.base[2]))
                            g = kin.inverse(leg, *target, model=model)
                            q0 = hold["q"]
                            unwrap(robot.q, i,
                                   [q0[i * 3 + j] + (g[j] - q0[i * 3 + j]) * u
                                    for j in range(3)])
                            robot.contacts[i] = True
                            robot.foot_world[leg.name] = [wx, wy, h]
                            nat.fig_axle[leg.name] = None
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
        elif fig.kind == "slide":
            # Powerslide : la caisse pivote en travers pendant que la quantité
            # de mouvement continue tout droit. Les pneus chassent — la roue ne
            # tourne plus qu'à la projection de la trajectoire sur le cap.
            t1 = fig.entry
            t2 = t1 + fig.slide
            sgn = fig.side
            sweep = fig.yaw_sweep * sgn
            if t < t1:
                s = _smooth(t / t1)
                robot.base[5] = yaw0 + sweep * 0.25 * s
                robot.base[3] = fig.lean * sgn * 0.5 * s
                robot.base[2] = base + ride * (1 - 0.06 * s) + radius
            elif t < t2:
                s = _smooth((t - t1) / fig.slide)
                robot.base[5] = yaw0 + sweep * (0.25 + 0.75 * s)
                robot.base[3] = fig.lean * sgn * (0.5 + 0.5 * math.sin(math.pi * s))
                robot.base[2] = base + ride * 0.94 + radius
                if carry_v:
                    sp = math.hypot(carry_v[0], carry_v[1])
                    ns = max(0.0, sp - fig.decel * dt)
                    if sp > 1e-6:
                        carry_v[0] *= ns / sp
                        carry_v[1] *= ns / sp
            else:
                s = _smooth((t - t2) / fig.settle_slide)
                robot.base[5] = yaw0 + sweep
                robot.base[3] = fig.lean * sgn * 0.5 * (1 - s)
                robot.base[2] = base + ride * (0.94 + 0.06 * s) + radius
                if carry_v:
                    carry_v[0] *= 1 - min(1.0, dt * 6)
                    carry_v[1] *= 1 - min(1.0, dt * 6)
            if carry_v:
                nat.vx = (carry_v[0] * math.cos(robot.base[5])
                          + carry_v[1] * math.sin(robot.base[5]))
            place(lambda leg, h: h + radius)

        else:                                            # saut et salto
            t1 = fig.crouch
            t2 = t1 + fig.push
            t3 = t2 + fig.flight
            t4 = t3 + fig.land
            sense = fig.sense
            arm_p = -0.10 * sense if fig.turns else 0.04
            off_p = -0.50 * sense if fig.turns else -0.14
            spinning = bool(fig.turns or fig.roll_turns)
            if t < t1:
                s = _smooth(t / t1)
                robot.base[2] = base + ride * (1 + (fig.crouch_z - 1) * s) + radius
                robot.base[4] = arm_p * s
                robot.base[3] = -0.10 * fig.roll_turns * s
                place(lambda leg, h: h + radius)
            elif t < t2:
                s = _smooth((t - t1) / fig.push)
                robot.base[2] = base + ride * (fig.crouch_z + (1.18 - fig.crouch_z) * s) + radius
                robot.base[4] = arm_p + (off_p - arm_p) * s
                robot.base[3] = (-0.10 * fig.roll_turns
                                 + (-0.30 * fig.roll_turns) * s)
                place(lambda leg, h: h + radius)
            elif t < t3:
                tf = t - t2
                s = tf / fig.flight
                robot.base[2] = base + ride + radius + fig.vz * tf - 0.5 * G_ACC * tf * tf
                if spinning:
                    if fig.turns:
                        robot.base[4] = off_p + (-math.tau * fig.turns * sense - off_p) * _smoother(s)
                        if fig.twist:                    # vrille + gîte du McTwist
                            robot.base[5] = yaw0 + math.tau * fig.twist * _smoother(s)
                            robot.base[3] = math.sin(math.pi * s) * fig.cork
                    else:
                        r0 = -0.40 * fig.roll_turns
                        robot.base[3] = r0 + (math.tau * fig.roll_turns - r0) * _smoother(s)
                        robot.base[4] = 0.0
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
                robot.base[4] = (0.10 * s) if spinning else (0.10 - 0.04 * s)
                # un tour de roulis ramène la caisse à l'endroit : 2π et 0,
                # c'est la même orientation, on recale sans dérouler à l'envers
                if fig.roll_turns:
                    robot.base[3] = 0.0
                if fig.twist:                            # on remet la gîte à plat
                    robot.base[5] = yaw0 + math.tau * fig.twist
                    robot.base[3] *= 1 - min(1.0, dt * 8)
                    # Un 540 tourne le robot d'un demi-tour net : il retombe
                    # face à l'arrière de sa trajectoire, les pneus traînés en
                    # arrière. C'est le « fakie » du skate — il continue sur
                    # son erre, roues à l'envers.
                    if not fakie[0]:
                        fakie[0] = True
                        nat.vx = -nat.vx
                        nat.direction = -nat.direction
                if spinning:                             # ouverture depuis la pose de vol
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
    if fig.kind == "slide":
        robot.base[5] = yaw0 + fig.yaw_sweep * fig.side
        nat.vx = 0.0
    if fig.twist:
        robot.base[5] = yaw0 + math.tau * fig.twist
    nat.z_body, nat.vz = robot.base[2], 0.0
    nat.blend_from(robot.q, 0.28)
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
        "tilt_deg": round(math.degrees(abs(fig.angle)) if fig.kind == "tilt" else 0.0, 1),
        "travel_m": 0.0,
    }


def perform(robot, flip: Figure = DEFAULT_FLIP) -> Dict[str, float]:
    """Exécute la figure sur un robot, en enregistrant chaque pas."""
    model = robot.model
    dt = robot.dt
    # +1 salto arrière, -1 salto avant : retourne bascule, poussée et rotation
    sense = flip.sense
    t0 = robot.t
    steps = max(1, round(flip.duration / dt))

    t_crouch = flip.crouch
    t_load = t_crouch + flip.load
    t_push = t_load + flip.push
    t_fly = t_push + flip.flight
    t_land = t_fly + flip.land

    entry_q = list(robot.q)

    def ground(height: float, shift_x: float = 0.0) -> None:
        # Entrée de figure : on vient de la pose de marche, qui n'a aucune
        # raison d'être celle de l'armement. Sans ce fondu la première image
        # saute — le robot ne bouge pas vraiment, mais le moteur, si : 115 rad/s.
        blend = _smooth(min(1.0, (robot.t - t0) / max(flip.crouch * 0.5, 1e-3)))
        for i, leg in enumerate(model.legs):
            target = (leg.x + shift_x, leg.y + leg.mirror * model.abad_plane, -height)
            angles = kin.inverse(leg, *target, model=model)
            for k in range(3):
                q0 = entry_q[i * 3 + k]
                robot.q[i * 3 + k] = q0 + (angles[k] - q0) * blend
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
            robot.base[4] = 0.06 * sense * s
            ground(robot.base[2], 0.02 * sense * s)
        elif t < t_load:
            phases.append("bascule")
            s = _smooth((t - t_crouch) / flip.load)
            robot.base[2] = flip.crouch_z
            robot.base[4] = (0.06 + (-0.10 - 0.06) * s) * sense
            ground(robot.base[2], (0.02 + (-0.01 - 0.02) * s) * sense)
        elif t < t_push:
            phases.append("poussée")
            s = _smooth((t - t_load) / flip.push)
            robot.base[2] = flip.crouch_z + (flip.takeoff_z - flip.crouch_z) * s
            robot.base[4] = (-0.10 + (-0.55 + 0.10) * s) * sense
            robot.base[0] += flip.travel * dt * 0.5
            ground(min(robot.base[2], model.l1 + model.l2 - 0.02), -0.01 * sense)
        elif t < t_fly:
            phases.append("vol")
            s = (t - t_push) / flip.flight
            tf = t - t_push
            robot.base[2] = flip.takeoff_z + flip.vz * tf - 0.5 * G_ACC * tf * tf
            robot.base[4] = (-0.55 - (2 * math.pi * flip.turns - 0.55) * _smoother(s)) * sense
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
        nat.clear[leg.name] = 0.0
    # la marche reprend depuis la pose de sortie au lieu d'y sauter : sans ce
    # fondu, la première image d'allure après une figure coûtait 56 rad/s
    nat.blend_from(robot.q, 0.28)
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
