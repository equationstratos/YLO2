"""Montée en vitesse : pas, trot, canter, galop, avec temps de suspension."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(0.8, height=0.25)
    print("%-8s %-8s %-9s %-9s %s" % ("v (m/s)", "allure", "cycle", "suspension", "pic rad/s"))
    for v in (0.15, 0.5, 0.9, 1.3, 1.7):
        before = len(robot.frames)
        robot.walk(vx=v, seconds=6.0)
        window = robot.frames[before:]
        air = sum(1 for f in window if not any(f["contact"])) / len(window)
        print("%-8.2f %-8s %-9.2f %-9.1f%% %.1f"
              % (v, robot.gait.name, robot.natural.stance / max(robot.natural.duty, 0.05),
                 air * 100, robot.report()["peak_joint_velocity_rad_s"]))
    robot.hold(1.0)


if __name__ == "__main__":
    main(build, "Montée en vitesse")
