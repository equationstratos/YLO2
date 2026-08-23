"""Balayage articulaire : chaque axe parcourt sa course URDF, un par un."""
import math

from ylo2_sim import Robot, main
from ylo2_sim.model import DEFAULT


def sweep(robot: Robot, joint: str, lo: float, hi: float, seconds: float = 1.6) -> None:
    """Parcourt lo -> hi -> lo, en partant et revenant à la pose de repos."""
    rest = robot.joint(joint)
    robot.ramp_joint(joint, lo, 0.4)
    steps = max(2, round(seconds * robot.rate))
    for i in range(steps + 1):
        u = 0.5 - 0.5 * math.cos(2 * math.pi * i / steps)
        robot.set_joint(joint, lo + (hi - lo) * u)
        robot.step()
    robot.ramp_joint(joint, rest, 0.4)


def build(robot: Robot) -> None:
    robot.stand(0.4, height=0.25)          # pose de départ par cinématique inverse
    for leg in DEFAULT.legs:
        sweep(robot, f"{leg.name}_haa", DEFAULT.haa_min * 0.6, DEFAULT.haa_max * 0.6)
        sweep(robot, f"{leg.name}_hfe", math.radians(20), math.radians(80))
        sweep(robot, f"{leg.name}_kfe", DEFAULT.kfe_min * 0.9, DEFAULT.kfe_max)


if __name__ == "__main__":
    main(build, "Balayage articulaire")
