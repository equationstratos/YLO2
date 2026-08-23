"""Accroupissement : hauteur de caisse de 320 à 170 mm, quatre pieds au sol."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(0.5, height=0.32)
    robot.squat(low=0.17, high=0.32, seconds=6.0)
    robot.stand(0.5, height=0.25)


if __name__ == "__main__":
    main(build, "Accroupissement")
