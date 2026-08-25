"""Escalier en roues : la patte soulève la roue par-dessus chaque marche."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.set_mode("roues")
    robot.set_terrain("escalier")
    lifts = 0
    for _ in range(int(24 * robot.rate)):
        robot.command(1.0)
        robot.step()
        lifts += sum(1 for leg in robot.model.legs if robot.natural.wstep.get(leg.name))

    print("distance %.2f m · sol %.2f m · caisse %.2f m"
          % (robot.base[0], robot.terrain.height_at(robot.base[0], robot.base[1]), robot.base[2]))
    print("franchissements de roue : %d images de patte levée · vitesse retenue %.2f m/s"
          % (lifts, robot.natural.vx))


if __name__ == "__main__":
    main(build, "Escalier en roues")
