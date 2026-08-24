"""Franchissement d'un escalier : montée, palier, descente."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.set_terrain("escalier")
    robot.stand(0.8, height=0.25)
    robot.walk(vx=0.45, seconds=26.0)      # le gouverneur ralentit tout seul

    sol = robot.terrain.height_at(robot.base[0], robot.base[1])
    print("distance %.2f m · sol sous le robot %.2f m · caisse %.2f m"
          % (robot.base[0], sol, robot.base[2]))
    print("marche du terrain : %d mm · vitesse retenue %.2f m/s"
          % (robot.terrain.max_step * 1000, robot.natural.vx))


if __name__ == "__main__":
    main(build, "Escalier")
