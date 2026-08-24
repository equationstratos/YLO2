"""Les trois figures à la suite : salto, double salto, 540 McTwist."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(0.6, height=0.25)
    for name in ("backflip", "doubleflip", "mctwist540"):
        info = robot.figure(name)
        robot.hold(0.7)
        print("%-14s vol %.2f s · apex %.2f m · %.0f° de tangage · %.0f° de vrille"
              % (info["figure"], info["flight_s"], info["apex_m"],
                 info["rotation_deg"], info["twist_deg"]))


if __name__ == "__main__":
    main(build, "Enchaînement de figures")
