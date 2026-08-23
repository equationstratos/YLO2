"""Trafic CAN : trames position par port PCAN, cadence et charge de bus."""
from ylo2_sim import Robot, main, moteus


def build(robot: Robot) -> None:
    robot.set_gait("trot")
    robot.walk(vx=0.2, seconds=2.0)

    print(robot.can_report())
    print("\nConsignes position au dernier pas (tours rotor) :")
    commands = robot.motor_commands()
    for port in (1, 2, 3, 4):
        joints = [j for j, a in moteus.MAP.items() if a.port == port]
        line = "  ".join(f"{j}={commands[j]:+7.3f}" for j in sorted(joints))
        print(f"  PCAN_PCIBUS{port} : {line}")


if __name__ == "__main__":
    main(build, "Trafic CAN")
