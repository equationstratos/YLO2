"""Salto arrière : armement, poussée, vol balistique, réception."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(0.6, height=0.25)
    info = robot.backflip()
    robot.hold(0.8)

    print("vol %.2f s · apex %.2f m · poussée %.2f m/s · rotation %.0f°"
          % (info["flight_s"], info["apex_m"], info["takeoff_vz_ms"], info["rotation_deg"]))


if __name__ == "__main__":
    main(build, "Salto arrière")
