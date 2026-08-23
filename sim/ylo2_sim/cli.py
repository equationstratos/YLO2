"""Ligne de commande : ylo2-sim run|list|serve|check|can"""
from __future__ import annotations

import argparse
import json
import math
import os
import runpy
import sys
from typing import List

from . import __version__, moteus
from .model import DEFAULT, Model
from .sim import Robot

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")


def cmd_list(_args) -> int:
    if not os.path.isdir(SCRIPTS_DIR):
        print(f"aucun dossier de scripts : {SCRIPTS_DIR}")
        return 1
    for name in sorted(os.listdir(SCRIPTS_DIR)):
        if not name.endswith(".py"):
            continue
        path = os.path.join(SCRIPTS_DIR, name)
        doc = ""
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith('"""'):
                    doc = line.strip().strip('"').strip()
                    break
        print(f"  {name:22s} {doc}")
    return 0


def cmd_run(args) -> int:
    path = args.script
    if not os.path.exists(path):
        candidate = os.path.join(SCRIPTS_DIR, path)
        if os.path.exists(candidate):
            path = candidate
        else:
            print(f"script introuvable : {args.script}", file=sys.stderr)
            return 1
    argv = [path]
    if args.out:
        argv += ["-o", args.out]
    if args.rate:
        argv += ["--rate", str(args.rate)]
    if args.strict:
        argv += ["--strict"]
    if getattr(args, "quiet", False):
        argv += ["--quiet"]
    sys.argv = argv
    runpy.run_path(path, run_name="__main__")
    return 0


def cmd_check(args) -> int:
    """Vérifie le modèle contre un clone du dépôt et teste la cinématique."""
    model = Model.from_xacro(args.repo) if args.repo else DEFAULT
    from . import kinematics as kin

    worst = 0.0
    for leg in model.legs:
        for dx in (-0.09, 0.0, 0.09):
            for dy in (-0.03, 0.0, 0.03):
                for z in (-0.32, -0.25, -0.18):
                    target = (leg.x + dx, leg.y + leg.mirror * model.abad + dy, z)
                    q = kin.inverse(leg, *target, model=model)
                    back = kin.forward(leg, q, model=model)
                    worst = max(worst, math.dist(back, target))
    print(f"modèle       : L1={model.l1:.6f} m  L2={model.l2:.6f} m  abad={model.abad:.4f} m")
    print(f"entraxes     : x=±{model.leg_offset_x:.4f} m  y=±{model.leg_offset_y:.4f} m")
    print(f"masse totale : {model.mass_total:.3f} kg")
    print(f"butées       : HAA ±{math.degrees(model.haa_max):.0f}°  "
          f"KFE [{math.degrees(model.kfe_min):.0f}°, {math.degrees(model.kfe_max):.0f}°]")
    print(f"aller-retour cinématique : erreur max {worst:.2e} m")
    return 0 if worst < 1e-9 else 2


def cmd_can(args) -> int:
    print(moteus.format_report(args.rate))
    robot = Robot(rate=args.rate)
    print("\nExemple de consignes position (tours rotor) :")
    for name, rev in list(robot.motor_commands().items())[:6]:
        addr = moteus.MAP[name]
        print(f"  {name:8s} port {addr.port}  id {addr.can_id}  "
              f"réduction {addr.reduction:4.0f}:1  -> {rev:+8.4f} tr")
    return 0


def cmd_serve(args) -> int:
    from .server import serve
    serve(port=args.port, page=args.page, rate=args.rate)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ylo2-sim", description="Simulateur cinématique YLO-2")
    p.add_argument("--version", action="version", version=f"ylo2-sim {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="exécuter un script et écrire sa trajectoire")
    r.add_argument("script")
    r.add_argument("-o", "--out", default="")
    r.add_argument("--rate", type=float, default=0)
    r.add_argument("--strict", action="store_true")
    r.add_argument("--quiet", action="store_true", help="ne pas afficher le rapport")
    r.set_defaults(func=cmd_run)

    l = sub.add_parser("list", help="lister les scripts fournis")
    l.set_defaults(func=cmd_list)

    c = sub.add_parser("check", help="vérifier le modèle et la cinématique")
    c.add_argument("--repo", default="", help="clone de elpimous/ylo-2 pour relire const.xacro")
    c.set_defaults(func=cmd_check)

    k = sub.add_parser("can", help="plan d'adressage CAN et charge de bus")
    k.add_argument("--rate", type=float, default=50.0)
    k.set_defaults(func=cmd_can)

    s = sub.add_parser("serve", help="servir le visualiseur et piloter en direct")
    s.add_argument("--port", type=int, default=8770)
    s.add_argument("--page", default="index.html")
    s.add_argument("--rate", type=float, default=50.0)
    s.set_defaults(func=cmd_serve)
    return p


def main(argv: List[str] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
