"""Simulateur cinématique YLO-2.

Ce n'est pas un simulateur dynamique : il n'y a ni masse en mouvement, ni
contact, ni couple. Il reproduit la chaîne réellement embarquée — consigne de
marche -> trajectoires de pieds -> cinématique inverse -> consignes position
sur les moteus — et vérifie ce qui est vérifiable à ce niveau : butées,
vitesses articulaires, enveloppe de travail, stabilité statique.
"""
from __future__ import annotations

import math
from dataclasses import replace
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import gait as gaitmod
from . import kinematics as kin
from . import moteus, stunts, terrain as terrainmod, trajectory
from .model import DEFAULT, Model
from .natural import Natural, profile as natural_profile


class LimitViolation(Exception):
    """Levée quand un script force un axe hors de sa course URDF."""


class Robot:
    """Robot simulé, piloté par un script.

    >>> robot = Robot(rate=50)
    >>> robot.set_gait("trot")
    >>> robot.walk(vx=0.15, seconds=4)
    >>> robot.save("out/trot.json")
    """

    def __init__(self, rate: float = 50.0, model: Model = None, height: float = None,
                 gait: str = "trot", swing: float = gaitmod.SWING_HEIGHT,
                 strict: bool = False, style: str = "souple",
                 mode: str = "pattes", terrain: str = "plat") -> None:
        self.model = model or DEFAULT
        self.rate = float(rate)
        self.dt = 1.0 / self.rate
        self.height = gaitmod.NOMINAL_HEIGHT if height is None else height
        self.swing = swing
        self.strict = strict                       # lever au lieu de signaler

        self.gait = gaitmod.GAITS[gait]
        self.vx = self.vy = self.wz = 0.0
        self.phase = 0.0
        self.t = 0.0
        self.base = [0.0, 0.0, self.height, 0.0, 0.0, 0.0]   # x y z roll pitch yaw
        self.q: List[float] = [0.0] * 12
        self.contacts: List[bool] = [True] * 4
        self.pose_mode = "gait"                     # ou "joint" (pilotage direct)
        self.style = style                          # "souple", "felin" ou "brut"
        self.mode = mode                            # "pattes" ou "roues"
        self.terrain = terrainmod.get(terrain)
        self.foot_world: Dict[str, list] = {}
        self.natural = Natural(model=self.model, params=natural_profile(style))

        self.stunt: Dict[str, Any] = {}
        self._air_frames = 0
        self.frames: List[Dict[str, Any]] = []
        self.events: List[str] = []
        self._peak_velocity = 0.0
        self._recorded_q: List[float] = [0.0] * 12
        self._violations: Dict[str, int] = {}
        self._unreachable = 0

        if self.mode == "roues":
            self.natural.step_wheels(self, 0.0)
        elif self.style == "brut":
            self._solve_gait()
        else:
            self.natural.step(self, 0.0)      # pose initiale dans le bon style
        self._record()

    # --- consignes -------------------------------------------------------
    @property
    def joints(self) -> List[str]:
        return self.model.joint_names

    def joint(self, name: str) -> float:
        return self.q[self.joints.index(name)]

    def set_gait(self, name: str) -> "Robot":
        if name not in gaitmod.GAITS:
            raise KeyError(f"allure inconnue : {name} (parmi {sorted(gaitmod.GAITS)})")
        self.gait = gaitmod.GAITS[name]
        self.mode = "gait"
        return self

    def command(self, vx: float = None, vy: float = None, wz: float = None) -> "Robot":
        vx = self.vx if vx is None else vx
        vy = self.vy if vy is None else vy
        wz = self.wz if wz is None else wz
        cvx, cvy, cwz = gaitmod.clamp_command(vx, vy, wz, self.mode)
        if (cvx, cvy, cwz) != (vx, vy, wz):
            self._note("consigne saturée aux maxima de gait.yaml")
        self.vx, self.vy, self.wz = cvx, cvy, cwz
        return self

    def set_height(self, height: float) -> "Robot":
        self.height = height
        return self

    # --- déroulement -----------------------------------------------------
    def step(self, steps: int = 1) -> "Robot":
        for _ in range(int(steps)):
            self._advance()
        return self

    def run(self, seconds: float) -> "Robot":
        return self.step(max(1, round(seconds * self.rate)))

    def hold(self, seconds: float) -> "Robot":
        self.command(0, 0, 0)
        return self.run(seconds)

    def walk(self, vx: float = 0.0, seconds: float = 1.0, vy: float = 0.0,
             wz: float = 0.0) -> "Robot":
        self.command(vx, vy, wz)
        return self.run(seconds)

    def turn(self, wz: float, seconds: float = 1.0, vx: float = 0.0) -> "Robot":
        self.command(vx, 0.0, wz)
        return self.run(seconds)

    def stand(self, seconds: float = 1.0, height: float = None) -> "Robot":
        if height is not None:
            self.height = height
        self.set_gait("stand")
        self.command(0, 0, 0)
        return self.run(seconds)

    def squat(self, low: float, high: float, seconds: float) -> "Robot":
        """Balaye la hauteur de caisse entre deux valeurs, pieds au sol."""
        self.set_gait("stand")
        self.command(0, 0, 0)
        steps = max(2, round(seconds * self.rate))
        for i in range(steps):
            u = 0.5 - 0.5 * math.cos(2 * math.pi * i / steps)
            self.height = high + (low - high) * u
            self._advance()
        return self

    def figures(self) -> List[str]:
        """Figures disponibles pour le train de propulsion courant."""
        catalogue = stunts.WHEEL_FIGURES if self.mode == "roues" else stunts.FIGURES
        return sorted(catalogue)

    def figure(self, name: str = "backflip",
               hold_seconds: Optional[float] = None,
               charge_seconds: float = 0.0) -> Dict[str, Any]:
        """Figure du mode courant : pattes (saltos) ou roues (cabrage, saut…).

        `hold_seconds` allonge la tenue d'un cabrage ou d'une tenue latérale.
        Dans le visualiseur ces deux figures se maintiennent jusqu'au prochain
        appui sur le bouton ; en script, on dit combien de temps on la tient.

        `charge_seconds` garde l'ARMEMENT sous tension : le robot s'accroupit,
        reste ramassé le temps demandé — en roulant, l'avance ne s'arrête
        pas — puis détend. Dans le visualiseur c'est l'appui maintenu sur le
        bouton de la figure ; en script, on dit combien de temps on charge.
        Réservé aux figures qui décollent.
        """
        if charge_seconds and not getattr(
                (stunts.WHEEL_FIGURES if self.mode == "roues"
                 else stunts.FIGURES).get(name), "flight", 0.0):
            raise ValueError("charge_seconds ne vaut que pour une figure qui "
                             "décolle, pas pour %s" % name)
        if self.mode == "roues":
            if name not in stunts.WHEEL_FIGURES:
                raise KeyError("figure roues inconnue : %s (parmi %s)"
                               % (name, sorted(stunts.WHEEL_FIGURES)))
            fig = stunts.WHEEL_FIGURES[name]
            if hold_seconds is not None:
                if not getattr(fig, "sustain", False) and fig.kind != "tilt":
                    raise ValueError("hold_seconds ne vaut que pour une figure "
                                     "tenue (cabrage, sidestand, pirouette, "
                                     "salto enchaîné), pas pour %s" % name)
                if fig.kind == "tilt":
                    fig = replace(fig, hold=hold_seconds)
                elif fig.kind == "spin":
                    # une pirouette tenue : la vrille dure d'autant plus
                    fig = replace(fig, sustain_s=max(0.0, hold_seconds))
                else:
                    # un salto enchaîné : on compte des tours entiers, pas des
                    # secondes — on ne coupe pas un tour en cours
                    fig = replace(fig, cycles=max(
                        1, round((hold_seconds + fig.cycle) / fig.cycle)))
            info = stunts.perform_wheels(self, fig, charge_seconds)
            self._note("%s : %.2f s" % (info["figure"], info["duration_s"]))
            self.stunt = info
            return info
        if name not in stunts.FIGURES:
            raise KeyError("figure inconnue : %s (parmi %s)"
                           % (name, sorted(stunts.FIGURES)))
        info = stunts.perform(self, stunts.FIGURES[name], charge_seconds)
        self._note("%s : vol %.2f s, apex %.2f m, %.0f° + %.0f° de vrille"
                   % (info["figure"], info["flight_s"], info["apex_m"],
                      info["rotation_deg"], info["twist_deg"]))
        self.stunt = info
        return info

    def backflip(self) -> Dict[str, Any]:
        """Salto arrière : armement, poussée, vol balistique, réception."""
        return self.figure("backflip")

    def double_backflip(self) -> Dict[str, Any]:
        """Double salto arrière : deux tours dans le même envol."""
        return self.figure("doubleflip")

    def mctwist540(self) -> Dict[str, Any]:
        """540 McTwist : un salto arrière avec un tour et demi de vrille."""
        return self.figure("mctwist540")

    def wheelie(self) -> Dict[str, Any]:
        """Cabrage sur les roues arrière (mode roues)."""
        return self.figure("wheelie")

    def brake(self, seconds: float = 1.5) -> "Robot":
        """Arrêt franc : consigne à zéro jusqu'à vitesse nulle."""
        self.command(0.0, 0.0, 0.0)
        return self.run(seconds)

    def set_terrain(self, key: str) -> "Robot":
        """Change de terrain : escalier, gravats, rampe…"""
        self.terrain = terrainmod.get(key)
        for leg in self.model.legs:
            self.natural.plant[leg.name] = None
            self.natural.land[leg.name] = None
            self.natural.prev_foot[leg.name] = None
            self.natural.wheel_z[leg.name] = None
        self._note("terrain : %s" % self.terrain.name)
        return self

    def recenter(self) -> "Robot":
        """Replace le robot au centre du terrain, à plat, face au +X.

        Équivalent du bouton « Réinitialiser » du visualiseur : pratique pour
        réattaquer un obstacle sans relancer toute la simulation.
        """
        self.base[0] = self.base[1] = 0.0
        self.base[3] = self.base[4] = self.base[5] = 0.0
        # la garde au sol n'est pas la même sur pattes et sur roues : en roues
        # la caisse est portée par l'essieu, à un rayon au-dessus du sol
        ground = self.terrain.height_at(0.0, 0.0)
        self.base[2] = (ground + self.height * 0.92 + gaitmod.WHEEL_RADIUS
                        if self.mode == "roues" else ground + self.height)
        nat = self.natural
        nat.vx = nat.vy = nat.wz = nat.ax = 0.0
        nat.direction = 1
        nat.z_body, nat.vz, nat.air = self.base[2], 0.0, False
        nat.prev_target, nat.ff_z = None, 0.0
        for leg in self.model.legs:
            nat.plant[leg.name] = None
            nat.lift[leg.name] = None
            nat.land[leg.name] = None
            nat.prev_foot[leg.name] = None
            nat.wheel_z[leg.name] = None
            nat.wstep[leg.name] = None
            nat.clear[leg.name] = 0.0
        # on repose la pose sur place avant de reprendre la mesure : un
        # recentrage est une téléportation, pas un mouvement du robot, et
        # comptait sinon comme un pic de 41 rad/s
        if self.mode == "roues":
            nat.step_wheels(self, 0.0)
        else:
            nat.step(self, 0.0)
        self._recorded_q = list(self.q)
        self._note("robot replacé au centre")
        return self

    def set_mode(self, mode: str) -> "Robot":
        """« pattes » ou « roues » (variante Go2-W)."""
        if mode not in ("pattes", "roues"):
            raise ValueError("mode inconnu : " + mode)
        if mode == self.mode:
            return self
        self.mode = mode
        self.natural.wheel_z = {leg.name: None for leg in self.model.legs}
        for leg in self.model.legs:                 # les appuis repartent à neuf
            self.natural.plant[leg.name] = None
            self.natural.prev_foot[leg.name] = None
            self.natural.land[leg.name] = None
        if mode == "roues":
            self.natural.step_wheels(self, 0.0)
        else:
            self.natural.step(self, 0.0)
        self._recorded_q = list(self.q)             # pas de faux pic de vitesse
        self._note("train : %s" % mode)
        return self

    def set_style(self, style: str) -> "Robot":
        """« souple », « felin » (naturels) ou « brut » (générateur nu)."""
        if style not in ("souple", "felin", "brut"):
            raise ValueError("style inconnu : " + style)
        self.style = style
        self.natural.params = natural_profile(style)
        if style != "brut":
            self.natural.step(self, 0.0)      # replace les pieds sans à-coup mesuré
            self._recorded_q = list(self.q)
        return self

    # --- pilotage articulaire direct -------------------------------------
    def set_joint(self, name: str, angle: float) -> "Robot":
        """Impose un angle. Le mode « joint » gèle le générateur d'allure."""
        if name not in self.joints:
            raise KeyError(f"axe inconnu : {name}")
        if not kin.check_limits(name, angle, self.model):
            lo, hi = self.model.limits(name)
            msg = (f"{name} = {math.degrees(angle):.1f}° hors course "
                   f"[{math.degrees(lo):.0f}°, {math.degrees(hi):.0f}°]")
            self._violations[name] = self._violations.get(name, 0) + 1
            if self.strict:
                raise LimitViolation(msg)
            self._note(msg)
        self.pose_mode = "joint"
        self.q[self.joints.index(name)] = angle
        return self

    def ramp_joint(self, name: str, target: float, seconds: float = 0.5) -> "Robot":
        """Rejoint un angle en douceur, sans à-coup de vitesse."""
        start = self.joint(name)
        steps = max(1, round(seconds * self.rate))
        for i in range(1, steps + 1):
            u = 0.5 - 0.5 * math.cos(math.pi * i / steps)
            self.set_joint(name, start + (target - start) * u)
            self.step()
        return self

    def set_joints(self, values: Dict[str, float]) -> "Robot":
        for name, angle in values.items():
            self.set_joint(name, angle)
        return self

    def foot_position(self, leg_name: str) -> Tuple[float, float, float]:
        leg = self.model.leg(leg_name)
        i = [l.name for l in self.model.legs].index(leg_name) * 3
        return kin.forward(leg, self.q[i:i + 3], self.model)

    def place_foot(self, leg_name: str, x: float, y: float, z: float) -> "Robot":
        leg = self.model.leg(leg_name)
        if not kin.reachable(leg, x, y, z, self.model):
            self._unreachable += 1
            self._note(f"cible hors enveloppe pour {leg_name} : "
                       f"({x:.3f}, {y:.3f}, {z:.3f})")
        angles = kin.inverse(leg, x, y, z, self.model)
        base = [l.name for l in self.model.legs].index(leg_name) * 3
        for k, axis in enumerate(("haa", "hfe", "kfe")):
            self.set_joint(f"{leg_name}_{axis}", angles[k])
        return self

    # --- interne ---------------------------------------------------------
    def _note(self, message: str) -> None:
        stamped = f"t={self.t:6.2f}s  {message}"
        if stamped not in self.events:
            self.events.append(stamped)

    def _solve_gait(self) -> None:
        moving = self.gait.name != "stand"
        for i, leg in enumerate(self.model.legs):
            target, contact = gaitmod.foot_target(
                leg, self.gait, self.phase, self.vx, self.vy, self.wz,
                self.height, self.swing, self.model)
            if not kin.reachable(leg, *target, model=self.model):
                self._unreachable += 1
                self._note(f"cible hors enveloppe pour {leg.name}")
            angles = kin.inverse(leg, *target, model=self.model)
            for k, axis in enumerate(("haa", "hfe", "kfe")):
                name = f"{leg.name}_{axis}"
                if not kin.check_limits(name, angles[k], self.model):
                    self._violations[name] = self._violations.get(name, 0) + 1
                    self._note(f"{name} en butée ({math.degrees(angles[k]):.1f}°)")
                self.q[i * 3 + k] = angles[k]
            self.contacts[i] = contact
        if not moving:
            self.contacts = [True] * 4

    def _advance_recorded(self) -> None:
        """Avance l'horloge et enregistre l'image courante, sans recalcul."""
        self.t += self.dt
        self._check_velocity()
        self._record()

    def _advance(self) -> None:
        if self.mode == "roues" and self.pose_mode == "gait":
            self.natural.step_wheels(self, self.dt)
            self._advance_recorded()
            return

        if self.pose_mode == "gait" and self.style != "brut":
            self.natural.step(self, self.dt)
            self._advance_recorded()
            return

        if self.pose_mode == "gait":
            if self.gait.name != "stand":
                self.phase = (self.phase + self.dt / self.gait.cycle) % 1.0
                yaw = self.base[5] + self.wz * self.dt
                self.base[0] += (self.vx * math.cos(yaw) - self.vy * math.sin(yaw)) * self.dt
                self.base[1] += (self.vx * math.sin(yaw) + self.vy * math.cos(yaw)) * self.dt
                self.base[5] = yaw
                self.base[4] = math.sin(self.phase * math.pi * 4 + 1.1) * 0.018
                self.base[3] = (math.sin(self.phase * math.pi * 2) * 0.03
                                if self.gait.name in ("pace", "walk") else 0.0)
                self.base[2] = self.height + math.sin(self.phase * math.pi * 4) * 0.006
            else:
                self.base[2] = self.height
                self.base[3] = self.base[4] = 0.0
            self._solve_gait()

        self._advance_recorded()

    def _check_velocity(self) -> None:
        """Vitesse articulaire entre deux images enregistrées."""
        for i, name in enumerate(self.joints):
            speed = abs(self.q[i] - self._recorded_q[i]) / self.dt
            self._peak_velocity = max(self._peak_velocity, speed)
            if speed > self.model.velocity_max:
                self._note(f"{name} à {speed:.1f} rad/s "
                           f"(> {self.model.velocity_max:.0f} rad/s)")

    def _record(self) -> None:
        self._recorded_q = list(self.q)
        if not any(self.contacts):
            self._air_frames += 1
        self.frames.append({
            "t": round(self.t, 6),
            "q": [round(v, 6) for v in self.q],
            "base": [round(v, 6) for v in self.base],
            "contact": [1 if c else 0 for c in self.contacts],
            "phase": round(self.phase, 4),
        })

    # --- analyse ---------------------------------------------------------
    def support_margin(self) -> float:
        """Distance signée du centre de masse au bord du polygone d'appui.

        Positive = le projeté est à l'intérieur. Approximation : centre de
        masse au centre du tronc, appuis pris au sol.
        """
        pts = []
        for i, leg in enumerate(self.model.legs):
            if not self.contacts[i]:
                continue
            x, y, _ = kin.forward(leg, self.q[i * 3:i * 3 + 3], self.model)
            yaw = self.base[5]
            pts.append((
                self.base[0] + x * math.cos(yaw) - y * math.sin(yaw),
                self.base[1] + x * math.sin(yaw) + y * math.cos(yaw),
            ))
        com = (self.base[0], self.base[1])
        if len(pts) < 3:
            if len(pts) == 2:
                return -_distance_to_segment(com, pts[0], pts[1])
            return float("-inf")
        order = _convex_hull(pts)
        inside = _point_in_polygon(com, order)
        edge = min(_distance_to_segment(com, order[i], order[(i + 1) % len(order)])
                   for i in range(len(order)))
        return edge if inside else -edge

    def report(self) -> Dict[str, Any]:
        return {
            "duration_s": round(self.t, 3),
            "frames": len(self.frames),
            "rate_hz": self.rate,
            "style": self.style,
            "mode": self.mode,
            "terrain": self.terrain.key,
            "gait": self.gait.name if self.mode == "pattes" else "roues",
            "speed_ms": round(math.hypot(self.natural.vx, self.natural.vy), 3),
            "flight_ratio": round(self._air_frames / max(len(self.frames), 1), 3),
            "distance_m": round(math.hypot(self.base[0], self.base[1]), 3),
            "heading_deg": round(math.degrees(self.base[5]), 1),
            "peak_joint_velocity_rad_s": round(self._peak_velocity, 2),
            "limit_violations": dict(self._violations),
            "unreachable_targets": self._unreachable,
            "support_margin_m": round(self.support_margin(), 4),
            "events": self.events[:20],
        }

    def can_report(self) -> str:
        return moteus.format_report(self.rate)

    def motor_commands(self) -> Dict[str, float]:
        """Consignes position telles qu'envoyées aux moteus (tours rotor)."""
        return {name: moteus.to_revolutions(name, self.q[i])
                for i, name in enumerate(self.joints)}

    def save(self, path: str, source: str = "") -> str:
        return trajectory.dump(
            path, self.dt, self.joints, self.frames, source=source,
            meta={"report": self.report(), "model": {
                "l1": self.model.l1, "l2": self.model.l2, "abad": self.model.abad,
                "mass_total": round(self.model.mass_total, 3)}})


# --- petits utilitaires géométriques -------------------------------------
def _distance_to_segment(p, a, b) -> float:
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _point_in_polygon(p, poly) -> bool:
    px, py = p
    inside = False
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > py) != (y2 > py):
            xin = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < xin:
                inside = not inside
    return inside


def _convex_hull(points):
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]
