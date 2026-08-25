"""Session de skatepark : le run complet, figures placées sur le relief.

Même enchaînement que le bouton « Session AUTO » du visualiseur. Les cotes
renvoient au terrain `skatepark` : kicker 1,40 → 2,10, funbox 3,60 → 6,00,
quarter pipes à 7,80 et -2,60.

Une figure décolle 0,54 s après le déclenchement (armement + poussée) : à
1,8 m/s d'élan, ça fait 0,97 m. Les déclenchements sont donc placés presque
un mètre avant la lèvre visée, pour que la POUSSÉE tombe dessus et que ce
soit la rampe qui lance le robot — comme en skate.
"""
import math

from ylo2_sim import Robot, main

# (abscisse d'approche, vitesse d'approche, figure) — None = simple relance
RUN = [
    (0.40, 1.4, None), (None, None, "STOP"), (None, None, "wheelie"),
    (1.34, 1.4, "wheeljump"),          # lèvre du kicker à 2,10
    (3.95, 1.4, "wheelfrontflip"),     # lèvre du funbox à 4,30
    (6.90, 1.8, None), (None, None, "STOP"), (None, None, "pirouette"),
    (5.72, 1.4, "wheelsideflipR"),     # descente du funbox, lèvre à 5,30
    (2.72, 1.4, "wheeltwist540"),      # kicker à 2,10, en sens inverse
    (-0.40, 2.2, "powerslide"),
]


def roll_to(robot: Robot, target: float, speed: float) -> None:
    """Roule jusqu'à l'abscisse visée, dans le monde.

    La vitesse monde vaut `vx · direction · cos(cap)` : après une pirouette
    le nez a fait demi-tour, après un 540 le sens de marche est inversé.
    On recalcule le signe à chaque pas plutôt que de tenir les comptes.
    """
    for _ in range(200):
        gap = target - robot.base[0]
        if abs(gap) <= 0.06:
            return
        heading = 1 if math.cos(robot.base[5]) >= 0 else -1
        need = 1 if gap >= 0 else -1
        robot.walk(vx=abs(speed) * need * heading * robot.natural.direction,
                   seconds=0.05)


def build(robot: Robot) -> None:
    robot.set_terrain("skatepark")
    robot.set_mode("roues")
    robot.recenter()

    for target, speed, figure in RUN:
        if figure == "STOP":               # une tenue se pose à l'arrêt
            robot.brake(1.2)
            continue
        if target is not None:
            roll_to(robot, target, speed)
        if figure is None:
            continue
        start = robot.base[0]
        kwargs = {"hold_seconds": 1.1} if figure == "wheelie" else {}
        try:
            info = robot.figure(figure, **kwargs)
        except ValueError as refus:            # tenue sur sol non plat
            print("%-20s sautée : %s" % (figure, refus))
            continue
        print("%-20s  x %5.2f -> %5.2f  (%.2f s)"
              % (info["figure"], start, robot.base[0], info["duration_s"]))

    # le slide s'arrête tout seul, mais la consigne date de la relance :
    # sans la remettre à zéro, la tenue finale relance le robot
    robot.command(vx=0.0, vy=0.0, wz=0.0)
    robot.brake(1.0)
    robot.hold(1.2)
    report = robot.report()
    print("run : %.1f s, pic %.1f rad/s, butées %s, cibles hors de portée %d"
          % (report["duration_s"], report["peak_joint_velocity_rad_s"],
             report["limit_violations"] or "aucune", report["unreachable_targets"]))


if __name__ == "__main__":
    main(build, "Session de skatepark")
