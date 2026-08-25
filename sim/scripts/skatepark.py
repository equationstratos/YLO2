"""Mini-plaza de skatepark : kicker, funbox, ledge et quarter pipes."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.set_terrain("skatepark")

    robot.walk(vx=0.6, seconds=10.0)
    print("en pattes  : x = %.2f m, sol sous le robot %.0f mm"
          % (robot.base[0], robot.terrain.height_at(robot.base[0], robot.base[1]) * 1000))

    robot.set_mode("roues")
    robot.recenter()
    robot.walk(vx=1.0, seconds=10.0)
    print("en roues   : x = %.2f m, sol sous le robot %.0f mm"
          % (robot.base[0], robot.terrain.height_at(robot.base[0], robot.base[1]) * 1000))

    robot.brake(1.5)
    # une tenue veut un sol de niveau sous les quatre roues : sur la transition
    # du quarter pipe elle est refusée, on redescend d'abord au centre
    try:
        robot.figure("wheelie", hold_seconds=3.0)
    except ValueError as refus:
        print("refusé sur la transition — %s" % refus)
        robot.recenter()
        robot.figure("wheelie", hold_seconds=3.0)
    print("cabrage tenu 3 s, assiette finale %.3f rad" % robot.base[4])


if __name__ == "__main__":
    main(build, "Skatepark")
