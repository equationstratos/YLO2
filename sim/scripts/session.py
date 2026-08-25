"""Session de skatepark : le run complet, figures placées sur le relief.

Même enchaînement que le bouton « Session AUTO » du visualiseur. Les cotes
renvoient au terrain `skatepark` : kicker 1,40 → 2,10, funbox 3,60 → 6,00,
quarter pipes à 7,80 et -2,60.

Une figure emporte le robot pendant toute sa durée : à 0,8 m/s un salto en
déplace 1,5 m. Les approches sont donc lentes et les figures déclenchées
avant le module, pour que le vol passe dessus et non devant.
"""
import math

from ylo2_sim import Robot, main

# (abscisse d'approche, vitesse d'approche, figure) — None = simple relance
RUN = [
    (0.55, 1.6, None), (None, None, "STOP"), (None, None, "wheelie"),
    (1.15, 0.8, "wheeljump"),
    (2.60, 2.2, None),
    (3.20, 0.8, "wheelfrontflip"),
    (5.10, 0.8, "wheelsideflipL"),
    (6.90, 1.8, None), (None, None, "STOP"), (None, None, "pirouette"),
    (6.30, 0.8, "wheelsideflipR"),
    (4.60, 2.2, None),
    (3.40, 0.8, "wheeltwist540"),
    (1.70, 1.4, None),
    (1.40, 0.8, "wheeldoubleflip"),
    (-0.80, 2.4, "powerslide"),
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
        kwargs = {"hold_seconds": 1.2} if figure == "wheelie" else {}
        try:
            info = robot.figure(figure, **kwargs)
        except ValueError as refus:            # tenue sur sol non plat
            print("%-20s sautée : %s" % (figure, refus))
            continue
        print("%-20s  x %5.2f -> %5.2f  (%.2f s)"
              % (info["figure"], start, robot.base[0], info["duration_s"]))

    robot.brake(1.0)
    robot.hold(1.2)
    report = robot.report()
    print("run : %.1f s, pic %.1f rad/s, butées %s, cibles hors de portée %d"
          % (report["duration_s"], report["peak_joint_velocity_rad_s"],
             report["limit_violations"] or "aucune", report["unreachable_targets"]))


if __name__ == "__main__":
    main(build, "Session de skatepark")
