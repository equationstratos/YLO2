"""Simulateur cinématique du quadrupède YLO-2 (github.com/elpimous/ylo-2).

Exemple minimal :

    from ylo2_sim import Robot, main

    def build(robot):
        robot.stand(1.0)
        robot.set_gait("trot")
        robot.walk(vx=0.15, seconds=6)

    if __name__ == "__main__":
        main(build)
"""
from __future__ import annotations

import argparse
import json
import os
from typing import Callable

from .model import DEFAULT, Model, Leg          # noqa: F401
from .sim import Robot, LimitViolation          # noqa: F401
from . import gait, kinematics, moteus, trajectory  # noqa: F401

__version__ = "1.0.0"
__all__ = ["Robot", "Model", "Leg", "LimitViolation", "main",
           "gait", "kinematics", "moteus", "trajectory", "DEFAULT"]


def main(build: Callable[[Robot], None], description: str = "") -> Robot:
    """Point d'entrée commun aux scripts : options, exécution, écriture."""
    parser = argparse.ArgumentParser(description=description or build.__doc__ or "")
    parser.add_argument("-o", "--out", default=os.environ.get("YLO2_OUT", ""),
                        help="fichier de trajectoire à écrire (.json)")
    parser.add_argument("--rate", type=float, default=50.0, help="cadence de commande (Hz)")
    parser.add_argument("--strict", action="store_true",
                        help="arrêter à la première butée franchie")
    parser.add_argument("--quiet", action="store_true", help="pas de rapport sur la sortie")
    args = parser.parse_args()

    robot = Robot(rate=args.rate, strict=args.strict)
    build(robot)

    if args.out:
        robot.save(args.out, source=getattr(build, "__module__", ""))
    if not args.quiet:
        print(json.dumps(robot.report(), indent=1, ensure_ascii=False))
        if args.out:
            print(f"trajectoire écrite : {args.out}")
    return robot
