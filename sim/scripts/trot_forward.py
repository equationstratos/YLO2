"""Trot en ligne droite à 0,15 m/s pendant 8 s."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(1.0, height=0.25)          # mise en station
    robot.set_gait("trot")
    robot.walk(vx=0.15, seconds=8.0)       # trot en avant
    robot.stand(1.0)                       # arrêt pieds au sol


if __name__ == "__main__":
    main(build, "Trot en ligne droite")
