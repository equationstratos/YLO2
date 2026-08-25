"""Session de skatepark : le run complet, figures lancées par les rampes.

Même enchaînement que le bouton « Session AUTO » du visualiseur. Le run part
du point le plus haut du parc — la plateforme du quarter arrière, à 450 mm —
descend la transition et enchaîne jusqu'au quarter avant.

Une figure décolle 0,76 s après le déclenchement (armement + poussée) : à
1,4 m/s d'élan, ça fait 0,76 m. Les déclenchements sont donc placés trois
quarts de mètre avant la lèvre visée, pour que la POUSSÉE tombe dessus.

Cotes : quarter arrière -2,60 (transition) / -3,05 à -3,95 (plateforme) ·
kicker 1,40 → 2,10 · funbox 3,60 → 6,00 · ledge y 1,70 → 2,10, x 3,40 → 6,20 ·
quarter avant 7,80 (transition) / 8,25 à 9,15 (plateforme).
"""
import math

from ylo2_sim import Robot, main
from ylo2_sim import gait as gaitmod


def place(robot: Robot, x: float, y: float = 0.0, yaw: float = 0.0) -> None:
    """Pose le robot d'aplomb sur le relief, à l'endroit voulu."""
    robot.recenter()
    robot.base[0], robot.base[1], robot.base[5] = x, y, yaw
    robot.base[2] = (robot.terrain.height_at(x, y)
                     + robot.height * 0.92 + gaitmod.WHEEL_RADIUS)
    robot.natural.step_wheels(robot, 0.0)
    robot._recorded_q = list(robot.q)


def roll_to(robot: Robot, target: float, speed: float) -> None:
    """Roule jusqu'à l'abscisse visée, dans le monde.

    La vitesse monde vaut `vx · direction · cos(cap)` : après une pirouette le
    nez a fait demi-tour, après un 540 le sens de marche est inversé. On
    recalcule le signe à chaque pas plutôt que de tenir les comptes.
    """
    side = 1 if target - robot.base[0] >= 0 else -1
    for _ in range(300):
        # On s'arrête au DÉPASSEMENT, pas dans une fenêtre de 60 mm : un pas
        # assez long enjambe la fenêtre, et l'acte repart alors en va-et-vient
        # autour de la cible au lieu de s'y arrêter.
        if (target - robot.base[0]) * side <= 0.06:
            return
        heading = 1 if math.cos(robot.base[5]) >= 0 else -1
        robot.walk(vx=abs(speed) * side * heading * robot.natural.direction,
                   seconds=0.02)


def goto(robot: Robot, x: float, y: float, speed: float) -> None:
    """Rejoint un point en braquant : sert à changer de voie."""
    for _ in range(500):
        dx, dy = x - robot.base[0], y - robot.base[1]
        if math.hypot(dx, dy) <= 0.10:
            robot.command(vx=0.0, wz=0.0)
            return
        direction = robot.natural.direction
        err = math.atan2(dy, dx) - robot.base[5]
        if direction < 0:
            err += math.pi
        err = (err + math.pi * 3) % (math.pi * 2) - math.pi
        robot.walk(vx=abs(speed) * direction * max(0.25, math.cos(err)),
                   wz=min(max(err * 2.2, -1.4), 1.4), seconds=0.02)


def face(robot: Robot, yaw: float, speed: float = 1.0) -> None:
    """Pivote sur place jusqu'au cap voulu.

    Un `goto` arrive au point mais pas dans l'axe : il finit en visant sa
    cible. Sans ce recalage, « avancer » le long du ledge partait de travers,
    voire à reculons quand le cap avait dépassé 90°.
    """
    for _ in range(400):
        err = (yaw - robot.base[5] + math.pi * 3) % (math.pi * 2) - math.pi
        if abs(err) < 0.02:
            robot.command(wz=0.0)
            return
        robot.walk(vx=0.0, wz=min(max(err * 2.0, -speed), speed), seconds=0.02)


def build(robot: Robot) -> None:
    robot.set_terrain("skatepark")
    robot.set_mode("roues")

    place(robot, -3.50)
    print("départ : x %.2f, sol %.0f mm (la rampe la plus haute)"
          % (robot.base[0], robot.terrain.height_at(robot.base[0], 0) * 1000))

    def figure(name, **kw):
        start, ground = robot.base[0], robot.terrain.height_at(robot.base[0], robot.base[1])
        info = robot.figure(name, **kw)
        print("%-22s x %5.2f (sol %3.0f mm) -> %5.2f (sol %3.0f mm)"
              % (info["figure"], start, ground * 1000, robot.base[0],
                 robot.terrain.height_at(robot.base[0], robot.base[1]) * 1000))

    roll_to(robot, -2.95, 1.0)
    figure("wheelfrontflip")

    roll_to(robot, 1.34, 1.4)
    figure("wheeljump")

    # On longe le ledge dans le sens de la marche : revenir en arrière
    # imposerait un demi-tour, et l'arc du demi-tour mordait sur l'obstacle.
    goto(robot, 2.90, 1.35, 1.2)
    face(robot, 0.0)                           # dans l'axe du ledge
    robot.brake(1.2)
    robot.natural.vx = 0.9                     # la tenue se fait EN ROULANT
    figure("sidestand", hold_seconds=2.2)

    goto(robot, 7.05, 0.0, 1.2)
    face(robot, 0.0)
    roll_to(robot, 7.30, 0.9)
    figure("wheeltwist540")

    roll_to(robot, 3.40, 2.0)
    figure("powerslide")

    robot.command(vx=0.0, vy=0.0, wz=0.0)
    robot.brake(1.0)
    robot.hold(1.2)
    report = robot.report()
    print("run : %.1f s, pic %.1f rad/s, butées %s, cibles hors de portée %d"
          % (report["duration_s"], report["peak_joint_velocity_rad_s"],
             report["limit_violations"] or "aucune", report["unreachable_targets"]))


if __name__ == "__main__":
    main(build, "Session de skatepark")
