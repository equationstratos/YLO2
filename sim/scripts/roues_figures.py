"""Figures sur roues : cabrage, tenue sur deux roues, saltos, McTwist."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.set_mode("roues")
    robot.walk(vx=1.2, seconds=2.0)

    for name in ("wheelie", "sidestand", "pirouette", "wheeljump", "wheelflip",
                 "wheeldoubleflip", "wheeltwist540"):
        info = robot.figure(name)
        robot.walk(vx=1.2, seconds=1.2)
        print("%-20s %.2f s" % (info["figure"], info["duration_s"])
              + (" · vol %.2f s · apex +%.2f m" % (info["flight_s"], info["apex_m"])
                 if info["flight_s"] else "")
              + (" · %.0f° de tangage" % info["rotation_deg"] if info["rotation_deg"] else "")
              + (" · %.0f° de vrille" % info["twist_deg"] if info["twist_deg"] else "")
              + (" · %.0f° de bascule" % info["tilt_deg"] if info["tilt_deg"] else ""))

    # le dernier 540 a laissé le robot en fakie : il roule en arrière
    print("sens de marche après le McTwist : %+d (vitesse %+.2f m/s)"
          % (robot.natural.direction, robot.natural.vx))
    robot.walk(vx=1.2, seconds=2.0)
    print("2 s plus tard, toujours en arrière : %+.2f m/s" % robot.natural.vx)

    robot.walk(vx=2.5, seconds=3.0)
    robot.brake(2.0)
    print("arrêt : %.3f m/s après freinage" % robot.natural.vx)


if __name__ == "__main__":
    main(build, "Figures sur roues")
