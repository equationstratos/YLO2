"""Modèle YLO-2 : cotes, butées et implantation des articulations.

Les valeurs viennent de champ_for_ylo2/ylo2_description/urdfs/const.xacro et
robots/ylo2.urdf.xacro. Si un clone du dépôt est disponible, `from_xacro()`
relit les constantes à la source plutôt que d'utiliser les valeurs figées.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass(frozen=True)
class Leg:
    name: str          # lf, rf, lh, rh
    mirror: int        # +1 à gauche, -1 à droite
    front: int         # +1 à l'avant, -1 à l'arrière
    x: float           # position de l'axe HAA dans le repère tronc
    y: float


@dataclass
class Model:
    """Paramètres géométriques et limites du robot."""

    trunk_length: float = 0.569125
    trunk_width: float = 0.350
    trunk_height: float = 0.148521

    leg_offset_x: float = 0.387 / 2 - 0.019     # entraxe HAA avant/arrière
    leg_offset_y: float = 0.1144 / 2 + 0.006    # entraxe HAA gauche/droite
    leg_offset_z: float = 0.023                 # tronc -> axe HAA
    abad: float = 0.092                         # HAA -> HFE (latéral)
    knee_y_offset: float = -0.001               # décalage y du joint KFE (xacro)
    l1: float = 0.215427                        # cuisse
    l2: float = 0.229819                        # jambe (axe KFE -> contact)
    foot_radius: float = 0.0265

    haa_min: float = math.radians(-70.0)
    haa_max: float = math.radians(70.0)
    kfe_min: float = math.radians(-159.0)
    kfe_max: float = math.radians(-37.0)
    velocity_max: float = 20.0                  # rad/s (URDF)
    torque_max: float = 15.0                    # N·m (URDF)

    mass_trunk: float = 3.128
    mass_hip: float = 0.599
    mass_upper: float = 1.080
    mass_lower: float = 0.175
    mass_foot: float = 0.078

    gear_motor: float = 6.0                     # réducteur qdd100
    gear_knee: float = 3.0                      # poulies + courroie GT3

    legs: List[Leg] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.legs:
            self.legs = [
                Leg("lf", +1, +1, +self.leg_offset_x, +self.leg_offset_y),
                Leg("rf", -1, +1, +self.leg_offset_x, -self.leg_offset_y),
                Leg("lh", +1, -1, -self.leg_offset_x, +self.leg_offset_y),
                Leg("rh", -1, -1, -self.leg_offset_x, -self.leg_offset_y),
            ]

    # --- dérivés ---------------------------------------------------------
    @property
    def abad_plane(self) -> float:
        """Décalage latéral du plan sagittal de la patte (abad + joint KFE)."""
        return self.abad + self.knee_y_offset

    @property
    def mass_total(self) -> float:
        return self.mass_trunk + 4 * (
            self.mass_hip + self.mass_upper + self.mass_lower + self.mass_foot
        )

    @property
    def joint_names(self) -> List[str]:
        names: List[str] = []
        for leg in self.legs:
            names += [f"{leg.name}_haa", f"{leg.name}_hfe", f"{leg.name}_kfe"]
        return names

    def leg(self, name: str) -> Leg:
        for leg in self.legs:
            if leg.name == name:
                return leg
        raise KeyError(f"patte inconnue : {name}")

    def limits(self, joint: str) -> Optional[tuple]:
        """Butées d'un axe, ou None si l'axe est continu (HFE)."""
        if joint.endswith("_haa"):
            return (self.haa_min, self.haa_max)
        if joint.endswith("_kfe"):
            return (self.kfe_min, self.kfe_max)
        return None

    def reach(self) -> tuple:
        """Distance hanche -> pied atteignable (min, max)."""
        return (abs(self.l1 - self.l2) + 0.02, (self.l1 + self.l2) * 0.999)

    # --- lecture du xacro ------------------------------------------------
    @classmethod
    def from_xacro(cls, repo: str) -> "Model":
        """Relit les constantes dans un clone du dépôt elpimous/ylo-2."""
        path = os.path.join(
            repo, "champ_for_ylo2", "ylo2_description", "urdfs", "const.xacro"
        )
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        # on ignore les blocs commentés, qui contiennent d'anciennes valeurs
        text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        props: Dict[str, str] = dict(
            re.findall(r'name="([\w_]+)"\s+value="([^"]+)"', text)
        )

        def num(key: str, default: float) -> float:
            raw = props.get(key)
            if raw is None:
                return default
            expr = raw.replace("${", "").replace("}", "")
            try:
                return float(eval(expr, {"__builtins__": {}}, {"PI": math.pi}))
            except Exception:
                return default

        model = cls(
            trunk_length=num("trunk_length", 0.569125),
            trunk_width=num("trunk_width", 0.350),
            trunk_height=num("trunk_height", 0.148521),
            abad=num("upperleg_offset", 0.092),
            l1=num("upperleg_length", 0.215427),
            l2=num("lowerleg_length", 0.229819),
            foot_radius=num("foot_radius", 0.0265),
            haa_min=num("hip_position_min", math.radians(-70)),
            haa_max=num("hip_position_max", math.radians(70)),
            kfe_min=num("lowerleg_position_min", math.radians(-159)),
            kfe_max=num("lowerleg_position_max", math.radians(-37)),
            velocity_max=num("hip_velocity_max", 20.0),
            torque_max=num("hip_torque_max", 15.0),
            mass_trunk=num("trunk_mass", 3.128),
            mass_hip=num("hip_mass", 0.599),
            mass_upper=num("upperleg_mass", 1.080),
            mass_lower=num("lowerleg_mass", 0.175),
            mass_foot=num("foot_mass", 0.078),
        )
        model.leg_offset_x = num("leg_offset_x", 0.387 / 2) - 0.019
        model.leg_offset_y = num("leg_offset_y", 0.1144 / 2) + 0.006
        model.leg_offset_z = -num("leg_offset_z", -0.023)
        model.legs = []
        model.__post_init__()
        return model


DEFAULT = Model()
