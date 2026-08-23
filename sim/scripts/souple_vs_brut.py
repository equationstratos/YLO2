"""Comparaison des deux styles de marche, à consigne identique."""
from ylo2_sim import Robot, main


def sequence(robot: Robot) -> None:
    robot.stand(0.6, height=0.25)
    robot.set_gait("trot")
    robot.walk(vx=0.05, seconds=3.0)      # allure lente : la couche souple passe en walk
    robot.walk(vx=0.18, seconds=4.0)      # montée en vitesse, placement à la Raibert
    robot.turn(wz=0.7, vx=0.10, seconds=3.0)   # virage : la caisse s'incline
    robot.hold(1.0)


def build(robot: Robot) -> None:
    sequence(robot)
    souple = robot.report()

    brut = Robot(rate=robot.rate, style="brut")
    sequence(brut)
    ref = brut.report()

    print("%-22s %10s %10s" % ("", "souple", "brut"))
    for key in ("distance_m", "peak_joint_velocity_rad_s", "support_margin_m"):
        print("%-22s %10s %10s" % (key, souple[key], ref[key]))
    print("allure retenue         %10s %10s" % (souple["gait"], ref["gait"]))


if __name__ == "__main__":
    main(build, "Souple contre brut")
