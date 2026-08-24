"""Mode roues : vitesse sur le plat, puis limite face à une marche."""
from ylo2_sim import Robot, main
from ylo2_sim import gait


def build(robot: Robot) -> None:
    robot.set_mode("roues")
    robot.walk(vx=2.5, seconds=8.0)
    print("plat : %.1f m parcourus, %.2f m/s, pic articulaire %.1f rad/s"
          % (robot.base[0], robot.natural.vx, robot.report()["peak_joint_velocity_rad_s"]))

    robot.set_terrain("escalier")
    robot.base[0] = 0.0
    robot.walk(vx=1.5, seconds=6.0)
    print("devant l'escalier : marche détectée %.0f mm, roue de %.0f mm"
          % (robot.natural.wheel_warn_max * 1000, gait.WHEEL_RADIUS * 1000))

    robot.set_mode("pattes")
    robot.walk(vx=0.4, seconds=10.0)
    print("repassé sur pattes : sol %.2f m sous le robot"
          % robot.terrain.height_at(robot.base[0], robot.base[1]))


if __name__ == "__main__":
    main(build, "Roues motrices")
