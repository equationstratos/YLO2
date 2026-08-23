"""Rotation sur place à 0,6 rad/s, puis dans l'autre sens."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(0.5, height=0.25)
    robot.set_gait("walk")
    robot.turn(wz=0.6, seconds=5.0)
    robot.turn(wz=-0.6, seconds=5.0)
    robot.stand(0.5)


if __name__ == "__main__":
    main(build, "Rotation sur place")
