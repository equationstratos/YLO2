"""Marche féline : voie étroite, triple appui, balancement du tronc."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.set_style("felin")
    robot.stand(0.8, height=0.25)
    robot.walk(vx=0.06, seconds=6.0)          # approche lente, trois appuis au sol
    robot.turn(wz=0.35, vx=0.05, seconds=4.0)  # virage : la caisse s'incline
    robot.walk(vx=0.16, seconds=5.0)          # accélération : bascule en trot
    robot.hold(1.5)

    n = len(robot.model.legs)
    spread = max(abs(robot.foot_position(leg.name)[1]) for leg in robot.model.legs)
    print("voie mesurée : %.0f mm de part et d'autre de l'axe (%d pattes)"
          % (spread * 1000, n))


if __name__ == "__main__":
    main(build, "Marche féline")
