"""Tests du simulateur : cinématique, allures, adressage CAN, format de sortie.

    python3 -m unittest discover -s sim/tests
"""
import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from ylo2_sim import gait, kinematics as kin, moteus, trajectory  # noqa: E402
from ylo2_sim import natural, stunts, terrain                      # noqa: E402
from ylo2_sim.model import DEFAULT, Model                          # noqa: E402
from ylo2_sim.sim import LimitViolation, Robot                     # noqa: E402


class TestKinematics(unittest.TestCase):
    def test_round_trip(self):
        """L'aller-retour cinématique doit être exact au flottant près."""
        worst = 0.0
        for leg in DEFAULT.legs:
            for dx in (-0.09, 0.0, 0.09):
                for dy in (-0.03, 0.0, 0.03):
                    for z in (-0.32, -0.25, -0.18):
                        target = (leg.x + dx, leg.y + leg.mirror * DEFAULT.abad + dy, z)
                        q = kin.inverse(leg, *target)
                        back = kin.forward(leg, q)
                        worst = max(worst, math.dist(back, target))
        self.assertLess(worst, 1e-9)

    def test_neutral_pose_matches_urdf_geometry(self):
        """Pied sous la hanche à 250 mm : angles connus de la pose nominale."""
        leg = DEFAULT.leg("lf")
        q = kin.inverse(leg, *kin.neutral_foot(leg, 0.25))
        self.assertAlmostEqual(math.degrees(q[0]), 0.0, places=6)
        self.assertAlmostEqual(math.degrees(q[1]), 54.61, places=1)
        self.assertAlmostEqual(math.degrees(q[2]), -104.44, places=1)

    def test_limits(self):
        self.assertTrue(kin.check_limits("lf_kfe", math.radians(-100)))
        self.assertFalse(kin.check_limits("lf_kfe", math.radians(-10)))
        self.assertFalse(kin.check_limits("lf_haa", math.radians(85)))
        self.assertTrue(kin.check_limits("lf_hfe", math.radians(400)))   # axe continu

    def test_workspace(self):
        leg = DEFAULT.leg("rf")
        self.assertTrue(kin.reachable(leg, leg.x, leg.y - DEFAULT.abad, -0.25))
        self.assertFalse(kin.reachable(leg, leg.x, leg.y - DEFAULT.abad, -0.60))


class TestGait(unittest.TestCase):
    def test_duty_cycles(self):
        self.assertAlmostEqual(gait.GAITS["trot"].cycle, 0.5)
        self.assertAlmostEqual(gait.GAITS["walk"].duty, 0.75)

    def test_trot_pairs_are_opposite(self):
        """En trot, les diagonales sont en opposition de phase."""
        g = gait.GAITS["trot"]
        self.assertEqual(g.offsets["lf"], g.offsets["rh"])
        self.assertEqual(g.offsets["rf"], g.offsets["lh"])
        self.assertNotEqual(g.offsets["lf"], g.offsets["rf"])

    def test_stance_sweep_matches_speed(self):
        """L'amplitude d'appui vaut la vitesse multipliée par la durée d'appui."""
        leg = DEFAULT.leg("lf")
        g = gait.GAITS["trot"]
        start, _ = gait.foot_target(leg, g, 0.0, 0.2, 0, 0, 0.25)
        end, _ = gait.foot_target(leg, g, g.duty - 1e-6, 0.2, 0, 0, 0.25)
        self.assertAlmostEqual(start[0] - end[0], 0.2 * g.stance, places=4)

    def test_command_clamped(self):
        self.assertEqual(gait.clamp_command(5.0, 0, 0)[0], gait.MAX_VX)


class TestMoteus(unittest.TestCase):
    def test_four_ports_three_ids(self):
        ports = {}
        for addr in moteus.MAP.values():
            ports.setdefault(addr.port, []).append(addr.can_id)
        self.assertEqual(sorted(ports), [1, 2, 3, 4])
        for ids in ports.values():
            self.assertEqual(sorted(ids), [1, 2, 3])

    def test_knee_reduction(self):
        """Genou : 6:1 moteur × 3:1 courroie."""
        self.assertAlmostEqual(moteus.MAP["lf_kfe"].reduction, 18.0)
        self.assertAlmostEqual(moteus.MAP["lf_hfe"].reduction, 6.0)

    def test_revolutions(self):
        rev = moteus.to_revolutions("lf_hfe", 2 * math.pi)
        self.assertAlmostEqual(abs(rev), 6.0)


class TestRobot(unittest.TestCase):
    def test_walk_distance(self):
        robot = Robot(rate=100, style="brut")
        robot.set_gait("trot")
        robot.walk(vx=0.15, seconds=4.0)
        self.assertAlmostEqual(robot.base[0], 0.6, places=2)
        self.assertEqual(robot.report()["limit_violations"], {})

    def test_turn_heading(self):
        robot = Robot(rate=100, style="brut")
        robot.set_gait("walk")
        robot.turn(wz=0.5, seconds=2.0)
        self.assertAlmostEqual(math.degrees(robot.base[5]), math.degrees(1.0), places=1)

    def test_trot_has_two_contacts(self):
        robot = Robot(rate=100, style="brut")
        robot.set_gait("trot")
        robot.walk(vx=0.1, seconds=1.0)
        self.assertEqual(sum(robot.contacts), 2)

    def test_stand_is_statically_stable(self):
        robot = Robot(rate=50, style="brut")
        robot.stand(0.5)
        self.assertGreater(robot.support_margin(), 0.05)

    def test_strict_mode_raises(self):
        robot = Robot(rate=50, strict=True, style="brut")
        with self.assertRaises(LimitViolation):
            robot.set_joint("lf_kfe", math.radians(-10))

    def test_velocity_watchdog(self):
        robot = Robot(rate=50, style="brut")
        robot.set_joint("lf_kfe", math.radians(-150))   # saut brutal
        robot.step()
        self.assertTrue(any("rad/s" in e for e in robot.events))

    def test_trajectory_round_trip(self):
        robot = Robot(rate=50, style="brut")
        robot.set_gait("trot")
        robot.walk(vx=0.1, seconds=0.5)
        with tempfile.TemporaryDirectory() as tmp:
            path = robot.save(os.path.join(tmp, "t.json"), source="test")
            data = trajectory.load(path)
        self.assertEqual(data["format"], trajectory.FORMAT)
        self.assertEqual(len(data["joints"]), 12)
        self.assertEqual(len(data["frames"][0]["q"]), 12)
        self.assertEqual(len(data["frames"][0]["base"]), 6)
        self.assertEqual(len(data["frames"][0]["contact"]), 4)


class TestNatural(unittest.TestCase):
    """Couche souple : rampes, allure automatique, appuis plantés."""

    def _foot_world_z(self, robot, index):
        leg = robot.model.legs[index]
        x, y, z = kin.forward(leg, robot.q[index * 3:index * 3 + 3], robot.model)
        roll, pitch = robot.base[3], robot.base[4]
        # repère tronc -> horizon (transposée de level_to_body)
        cr, sr = math.cos(roll), math.sin(roll)
        cp, sp = math.cos(pitch), math.sin(pitch)
        return (-sp * x + cp * sr * y + cp * cr * z) + robot.base[2]

    def test_velocity_ramps_instead_of_jumping(self):
        robot = Robot(rate=200)
        robot.set_gait("trot")
        robot.command(0.2)
        robot.step(1)
        self.assertLess(abs(robot.natural.vx), 0.02)      # pas de saut de consigne
        robot.run(2.0)
        self.assertAlmostEqual(robot.natural.vx, 0.2, places=3)

    def test_gait_follows_speed(self):
        robot = Robot(rate=100)
        robot.walk(vx=0.10, seconds=3.0)
        self.assertEqual(robot.gait.name, "walk")
        robot.walk(vx=0.60, seconds=3.0)
        self.assertEqual(robot.gait.name, "trot")
        robot.hold(2.0)
        self.assertEqual(robot.gait.name, "stand")

    def test_stance_feet_stay_on_the_ground(self):
        """La compensation d'assiette empêche les appuis de s'enfoncer."""
        robot = Robot(rate=200)
        robot.set_gait("trot")
        robot.walk(vx=0.15, seconds=2.0)
        worst = 0.0
        for _ in range(400):
            robot.step()
            for i in range(4):
                if robot.contacts[i]:
                    worst = min(worst, self._foot_world_z(robot, i))
        self.assertGreater(worst, -0.001)

    def test_swing_touches_down_without_scuffing(self):
        """Hermite : la vitesse du pied au poser prolonge celle de l'appui."""
        leg = DEFAULT.legs[0]
        sweep, duty = 0.2 * 0.25, 0.5
        tangent = sweep * (1 - duty) / duty
        p0, p1 = -sweep / 2, sweep / 2
        eps = 1e-4
        v_end = (natural.hermite(p0, p1, tangent, 1.0, 1.18)
                 - natural.hermite(p0, p1, tangent, 1.0 - eps, 1.18)) / eps
        self.assertGreater(v_end, tangent * 0.5)          # bien orientée, non nulle

    def test_style_switch(self):
        robot = Robot(rate=50)
        robot.set_style("brut")
        self.assertEqual(robot.style, "brut")
        with self.assertRaises(ValueError):
            robot.set_style("mou")


class TestFeline(unittest.TestCase):
    """Profil félin : voie étroite, appui prolongé, tronc qui balance."""

    def _track_width(self, style):
        robot = Robot(rate=200, style=style)
        robot.walk(vx=0.08, seconds=4.0)
        return max(abs(robot.foot_position(leg.name)[1]) for leg in robot.model.legs)

    def test_narrower_track_than_souple(self):
        self.assertLess(self._track_width("felin"), self._track_width("souple") * 0.7)

    def test_more_feet_on_the_ground(self):
        counts = {}
        for style in ("souple", "felin"):
            robot = Robot(rate=200, style=style)
            robot.walk(vx=0.06, seconds=4.0)
            total = 0
            for _ in range(400):
                robot.step()
                total += sum(robot.contacts)
            counts[style] = total / 400.0
        self.assertGreater(counts["felin"], counts["souple"])
        self.assertGreater(counts["felin"], 3.0)          # triple appui dominant

    def test_trunk_sways_and_wags(self):
        robot = Robot(rate=200, style="felin")
        robot.walk(vx=0.08, seconds=3.0)
        wags, rolls = [], []
        for _ in range(300):
            robot.step()
            wags.append(abs(robot.natural.yaw_wag))
            rolls.append(abs(robot.base[3]))
        self.assertGreater(max(wags), 0.008)              # le tronc oscille
        self.assertGreater(max(rolls), 0.005)

    def test_stays_within_actuator_limits(self):
        for speed in (0.05, 0.12, 0.2):
            robot = Robot(rate=200, style="felin")
            robot.walk(vx=speed, seconds=6.0)
            report = robot.report()
            self.assertEqual(report["limit_violations"], {})
            self.assertLess(report["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_crouched_posture(self):
        robot = Robot(rate=100, style="felin")
        robot.walk(vx=0.08, seconds=2.0)
        self.assertLess(robot.base[2], robot.height)       # se tient plus bas


class TestSpeed(unittest.TestCase):
    """Échelle d'allures : la vitesse commande l'allure et la cadence."""

    def _run(self, speed, seconds=6.0, style="souple"):
        robot = Robot(rate=200, style=style)
        robot.walk(vx=speed, seconds=seconds)
        return robot

    def test_gait_ladder(self):
        self.assertEqual(self._run(0.15).gait.name, "walk")
        self.assertEqual(self._run(0.5).gait.name, "trot")
        self.assertIn(self._run(1.7).gait.name, ("canter", "gallop"))

    def test_cadence_shortens_with_speed(self):
        slow = self._run(0.3).natural.stance
        fast = self._run(1.5).natural.stance
        self.assertLess(fast, slow)

    def test_suspension_appears_at_speed(self):
        """Au galop, il y a des instants sans aucun appui."""
        robot = self._run(1.7, seconds=8.0)
        window = robot.frames[-800:]
        air = sum(1 for f in window if not any(f["contact"])) / len(window)
        self.assertGreater(air, 0.05)

    def test_walk_has_no_flight_phase(self):
        robot = self._run(0.15, seconds=6.0)
        window = robot.frames[-600:]
        self.assertTrue(all(any(f["contact"]) for f in window))

    def test_declared_envelope(self):
        """Sous la vitesse déclarée, on reste dans les 20 rad/s de l'URDF."""
        robot = self._run(gait.DECLARED_SPEED * 0.75, seconds=8.0)
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_speed_actually_reached(self):
        robot = self._run(1.2, seconds=8.0)
        self.assertAlmostEqual(robot.natural.vx, 1.2, places=2)


class TestTerrain(unittest.TestCase):
    def test_height_sampling(self):
        stairs = terrain.get("escalier")
        self.assertAlmostEqual(stairs.height_at(0.5, 0), 0.0)
        self.assertAlmostEqual(stairs.height_at(1.25, 0), 0.13, places=3)
        self.assertGreater(stairs.height_at(2.0, 0), 0.3)
        self.assertAlmostEqual(stairs.height_at(2.0, 5.0), 0.0)     # hors emprise

    def test_step_ahead(self):
        stairs = terrain.get("escalier")
        self.assertGreater(stairs.step_ahead(1.0, 0, 0.0), 0.1)
        self.assertAlmostEqual(stairs.step_ahead(-2.0, 0, 0.0), 0.0)

    def test_robot_climbs_stairs(self):
        robot = Robot(rate=200, terrain="escalier")
        robot.walk(vx=0.45, seconds=26.0)
        ground = robot.terrain.height_at(robot.base[0], robot.base[1])
        self.assertGreater(ground, 0.3)                    # a gravi des marches
        self.assertGreater(robot.base[2], ground + 0.15)   # la caisse suit
        self.assertEqual(robot.report()["limit_violations"], {})

    def test_feet_stay_on_the_surface(self):
        robot = Robot(rate=200, terrain="gravats")
        robot.walk(vx=0.4, seconds=8.0)
        worst = 0.0
        for _ in range(600):
            robot.step()
            for i, leg in enumerate(robot.model.legs):
                if not robot.contacts[i]:
                    continue
                f = robot.foot_world[leg.name]
                worst = min(worst, f[2] - robot.terrain.height_at(f[0], f[1]))
        self.assertGreater(worst, -0.005)

    def test_governor_slows_down_on_obstacles(self):
        flat = Robot(rate=200)
        flat.walk(vx=0.6, seconds=6.0)
        rough = Robot(rate=200, terrain="marches_hautes")
        rough.walk(vx=0.6, seconds=6.0)
        self.assertLess(rough.natural.vx, flat.natural.vx * 0.8)


class TestWheels(unittest.TestCase):
    def test_rolls_faster_than_it_walks(self):
        legs = Robot(rate=200)
        legs.walk(vx=2.0, seconds=6.0)
        wheels = Robot(rate=200, mode="roues")
        wheels.walk(vx=2.5, seconds=6.0)
        self.assertGreater(wheels.base[0], legs.base[0])

    def test_wheels_barely_move_the_joints(self):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=2.0, seconds=6.0)
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], 5.0)

    def test_wheel_spins_at_v_over_r(self):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=1.0, seconds=2.0)
        before = robot.natural.spin["lf"]
        robot.step(100)                                   # 0,5 s
        turned = (robot.natural.spin["lf"] - before) % math.tau
        expected = (1.0 / gait.WHEEL_RADIUS * 0.5) % math.tau
        self.assertAlmostEqual(turned, expected, delta=0.6)

    def test_ride_height_includes_the_wheel(self):
        robot = Robot(rate=200, mode="roues")
        robot.hold(1.5)
        self.assertGreater(robot.base[2], gait.WHEEL_RADIUS + 0.15)

    def test_warns_on_steps_too_high(self):
        robot = Robot(rate=200, mode="roues", terrain="escalier")
        robot.walk(vx=1.0, seconds=4.0)
        self.assertGreater(robot.natural.wheel_warn_max, gait.WHEEL_RADIUS)

    def test_brake_stops_the_robot(self):
        """Arrêt franc : le frein ramène vraiment la vitesse à zéro."""
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=2.5, seconds=5.0)
        self.assertGreater(robot.natural.vx, 1.5)
        robot.brake(2.0)
        self.assertEqual(robot.natural.vx, 0.0)
        x = robot.base[0]
        robot.hold(1.0)
        self.assertAlmostEqual(robot.base[0], x, places=6)   # ne dérive plus

    def test_brakes_harder_than_it_accelerates(self):
        robot = Robot(rate=400, mode="roues")
        robot.walk(vx=2.0, seconds=4.0)
        v0 = robot.natural.vx
        robot.command(0.0)
        robot.step(1)
        decel = (v0 - robot.natural.vx) * 400
        self.assertGreater(decel, 3.0)

    def test_steps_over_stairs_with_its_legs(self):
        """La roue ne monte pas la marche : la patte la soulève."""
        robot = Robot(rate=200, mode="roues", terrain="escalier")
        lifted = 0
        for _ in range(int(24 * 200)):
            robot.step()
            lifted += sum(1 for leg in robot.model.legs if robot.natural.wstep.get(leg.name))
            robot.command(1.0)
        self.assertGreater(lifted, 100)                     # des franchissements ont eu lieu
        self.assertGreater(robot.base[0], 6.0)              # l'escalier est passé
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_a_wheel_never_sinks_into_a_transition(self):
        """Le pneu touche la tranche, il ne la traverse pas.

        `height_at` n'interroge qu'un point : une roue de 75 mm abordant une
        transition la traversait donc jusqu'à ce que son centre passe de
        l'autre côté — on voyait la roue dans le béton.
        """
        for key in ("bigramp", "skatepark"):
            robot = Robot(rate=200, mode="roues", terrain=key)
            robot.base[0] = -1.0
            worst = 0.0
            for _ in range(int(5 * 200)):
                robot.command(2.0)
                robot.step()
                for leg in robot.model.legs:
                    foot = robot.foot_world[leg.name]
                    if robot.natural.wstep.get(leg.name):
                        continue                   # une patte levée n'est pas un contact
                    worst = max(worst, robot.terrain.height_at(foot[0], foot[1]) - foot[2])
            self.assertLess(worst, 0.005, key)     # 5 mm, l'épaisseur du trait

    def test_the_big_ramp_is_ridden_not_crossed(self):
        """Une transition de 1,20 m se remonte tant qu'on a de la vitesse.

        Les autres rampes du jeu se franchissent — c'est voulu. Celle-ci est
        un objet de skate : la roue n'y grimpe que ce que son élan lui paye.
        """
        ramp = terrain.get("bigramp")
        self.assertAlmostEqual(ramp.height_at(4.45, 0.0), 1.20, places=2)   # le coping
        self.assertEqual(ramp.height_at(0.0, 0.0), 0.0)                     # le flat
        # la courbe est assez fine pour qu'une roue de 75 mm la suive :
        # aucune tranche ne fait une marche plus haute que son rayon
        xs = [3.20 + i * 0.005 for i in range(int(1.20 / 0.005))]
        rises = [ramp.height_at(b, 0.0) - ramp.height_at(a, 0.0)
                 for a, b in zip(xs, xs[1:])]
        # sauf tout en haut, où la transition est verticale : c'est un mur
        self.assertLess(max(rises[:200]), gait.WHEEL_RADIUS)
        robot = Robot(rate=200, mode="roues", terrain="bigramp")
        robot.base[0] = 1.0
        for _ in range(int(3 * 200)):
            robot.command(2.0)
            robot.step()
        # il est engagé dans la courbe, pas passé par-dessus le deck
        self.assertGreater(robot.base[0], 3.20)
        self.assertLess(robot.base[0], 4.45)
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_a_wall_is_not_a_ramp(self):
        """Le robot bute contre une paroi au lieu de la traverser.

        Le contact de roue fait monter les roues sur ce qu'elles peuvent
        franchir ; au-delà, rien ne s'opposait à ce que le robot entre DANS
        l'obstacle. Le bord de la réception d'une mega ramp fait 900 mm de
        haut : c'est un mur, pas une rampe.
        """
        robot = Robot(rate=200, mode="roues", terrain="megaramp")
        robot.base[0] = 2.5                            # dans le gap, face au mur
        robot.base[2] = robot.height * 0.92 + gait.WHEEL_RADIUS
        for _ in range(int(4 * 200)):
            robot.command(2.0)
            robot.step()
        self.assertLess(robot.base[0], 3.20)           # il n'est pas entré dedans
        self.assertGreater(robot.base[0], 2.5)         # mais il a bien roulé jusque-là
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_a_lintel_is_not_ground(self):
        """Un linteau est plein en haut et vide en dessous.

        Tout le reste du terrain est un champ de hauteurs — une colonne pleine
        depuis le sol —, et un champ de hauteurs ne sait pas décrire une
        fenêtre. Le linteau ne compte donc pas dans `height_at` : il n'y a
        rien à poser une roue dessous.
        """
        scene = terrain.get("megascene")
        # sous la fenêtre : l'appui de 180 mm, et un plafond à 600 mm
        self.assertAlmostEqual(scene.height_at(6.60, 0.0), 0.24, places=2)
        self.assertAlmostEqual(scene.ceiling_at(6.60, 0.0, 0.30), 0.62, places=2)
        # à côté de l'ouverture, c'est un jambage plein : pas de plafond, un mur
        self.assertAlmostEqual(scene.height_at(6.60, 1.0), 2.00, places=2)
        self.assertEqual(scene.ceiling_at(6.60, 1.0, 0.30), float("inf"))
        # et loin de la fenêtre, le ciel est libre
        self.assertEqual(scene.ceiling_at(5.00, 0.0, 0.30), float("inf"))

    def test_the_window_needs_a_low_chassis(self):
        """La fenêtre ne se franchit pas en levant la patte mais en baissant
        le tronc. C'est un passage de mode ROUES.

        Sur pattes, enjamber un appui de 240 mm fait monter la caisse bien
        au-dessus de sa consigne — le générateur d'allure lève le tronc avec
        les pieds — et le linteau est alors trop bas quelle que soit la garde
        demandée. C'est vrai plutôt que contourné : un robot qui marche
        par-dessus un seuil se redresse, et il faudrait qu'il s'accroupisse
        PENDANT l'enjambée pour passer.
        """
        def run(height, mode):
            robot = Robot(rate=200, mode=mode, terrain="megascene")
            robot.height = height
            nat = robot.natural
            robot.base[0] = 5.60
            robot.base[2] = (height * 0.92 + gait.WHEEL_RADIUS
                             if mode == "roues" else height)
            # Déplacer la caisse ne déplace pas les appuis : sans ce nettoyage,
            # les pieds restent plantés là où on était et les pattes tirent la
            # caisse en l'air. C'est un piège de banc d'essai, pas du modèle.
            for leg in robot.model.legs:
                for table in (nat.plant, nat.lift, nat.land, nat.prev_foot,
                              nat.wheel_z, nat.wstep):
                    table[leg.name] = None
            nat.z_body, nat.vz, nat.prev_target, nat.ff_z = robot.base[2], 0.0, None, 0.0
            for _ in range(int(6 * 200)):
                robot.command(0.8)
                robot.step()
            return robot

        blocked, passes = run(0.25, "roues"), run(0.20, "roues")
        self.assertLess(blocked.base[0], 6.80, "à 250 mm, le tronc touche")
        self.assertGreater(passes.base[0], 7.00, "à 200 mm, ça passe")
        self.assertLess(passes.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)
        # sur pattes, enjamber le seuil relève la caisse : à 300 mm elle bute
        self.assertLess(run(0.30, "pattes").base[0], 6.80)

    def test_the_mega_scene_chains_the_whole_catalogue(self):
        """Tout y est, et dans l'ordre."""
        scene = terrain.get("megascene")
        self.assertEqual(scene.start, (-16.0, 0.0, 0.0))
        for x, h, what in [(-16.0, 2.60, "plateforme de départ"),
                           (-11.0, 1.30, "roll-in"),
                           (-2.70, 0.14, "poutre"),
                           (2.50, 0.65, "palier d'escalier"),
                           (6.60, 0.24, "appui de fenêtre"),
                           (8.00, 0.24, "plateforme"),
                           (11.80, 0.18, "plateau de funbox"),
                           (15.50, 0.36, "marches hautes"),
                           (20.50, 0.37, "tremplin"),
                           (23.00, 0.35, "réception"),
                           (28.50, 1.20, "deck du quarter pipe")]:
            self.assertAlmostEqual(scene.height_at(x, 0.0), h, delta=0.02, msg=what)
        self.assertAlmostEqual(scene.height_at(11.90, 1.90), 0.20, places=2)  # le ledge
        # les gravats sont tirés d'une suite déterministe : les deux moteurs
        # doivent en poser exactement le même nombre
        self.assertEqual(len(terrain.get("gravats").boxes), 98)

    def test_the_mega_ramp_is_a_run_from_top_to_bottom(self):
        """Roll-in, tremplin, gap, réception, transition — dans cet ordre."""
        ramp = terrain.get("megaramp")
        self.assertEqual(ramp.start, (-16.0, 0.0, 0.0))          # départ en haut
        self.assertAlmostEqual(ramp.height_at(-16.0, 0.0), 2.60, places=2)
        self.assertAlmostEqual(ramp.height_at(-7.5, 0.0), 0.16, delta=0.05)
        self.assertAlmostEqual(ramp.height_at(-5.0, 0.0), 0.0, places=2)   # le flat
        self.assertAlmostEqual(ramp.height_at(2.19, 0.0), 0.70, places=2)  # la lèvre
        self.assertAlmostEqual(ramp.height_at(3.00, 0.0), 0.0, places=2)   # le gap
        self.assertAlmostEqual(ramp.height_at(3.25, 0.0), 0.39, delta=0.03)
        self.assertAlmostEqual(ramp.height_at(6.59, 0.0), 0.0, delta=0.03)
        self.assertAlmostEqual(ramp.height_at(15.55, 0.0), 2.0, delta=0.65)
        # Le roll-in est une PENTE, pas une transition : aucune tranche ne
        # dépasse ce qu'une roue franchit, donc les roues ne le quittent
        # jamais et les 2,60 m se convertissent en vitesse.
        xs = [-15.0 + i * 0.01 for i in range(800)]
        rises = [ramp.height_at(a, 0.0) - ramp.height_at(b, 0.0)
                 for a, b in zip(xs, xs[1:])]
        self.assertLess(max(rises), gait.WHEEL_RADIUS)
        self.assertGreater(math.sqrt(2 * 9.81 * 2.60 * 0.85), 6.0)   # ≈ 6,6 m/s

    def test_switch_back_to_legs(self):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=1.5, seconds=3.0)
        robot.set_mode("pattes")
        robot.walk(vx=0.4, seconds=4.0)
        self.assertEqual(robot.report()["limit_violations"], {})
        self.assertIn(robot.gait.name, ("walk", "trot"))


class TestSkatepark(unittest.TestCase):
    def test_the_plaza_is_symmetric_and_rideable(self):
        park = terrain.get("skatepark")
        self.assertAlmostEqual(park.height_at(4.8, 0.0), 0.18)      # plateau du funbox
        self.assertAlmostEqual(park.height_at(4.5, 1.9), 0.20)      # ledge de grind
        self.assertEqual(park.height_at(4.5, 1.2), 0.0)             # dégagement du ledge
        # les deux quarter pipes se font face, même profil de part et d'autre
        for u in (0.10, 0.25, 0.40):
            self.assertAlmostEqual(park.height_at(7.80 + u, 0.0),
                                   park.height_at(-2.60 - u, 0.0), places=6)
        self.assertAlmostEqual(park.height_at(8.40, 0.0), 0.45)     # plateforme haute
        self.assertEqual(park.height_at(0.0, 0.0), 0.0)             # le centre est dégagé

    def test_the_modules_are_spaced_out(self):
        """Il faut de l'élan avant chaque obstacle et de quoi se replacer après."""
        park = terrain.get("skatepark")
        flat, run = [], 0.0
        x = -2.0
        while x < 7.8:                                  # entre les deux quarters
            if park.height_at(x, 0.0) < 0.001:
                run += 0.02
            else:
                flat.append(run); run = 0.0
            x += 0.02
        flat.append(run)
        self.assertGreater(min(g for g in flat if g > 0.1), 1.4)    # 1,4 m au moins

    def test_the_park_is_gentler_than_the_stairs(self):
        def peak(key, vx):
            robot = Robot(rate=100, terrain=key)
            robot.walk(vx=vx, seconds=10.0)
            return robot.report()["peak_joint_velocity_rad_s"]
        self.assertLess(peak("skatepark", 0.6), peak("escalier", 0.6))


class TestSession(unittest.TestCase):
    """Le run du bouton « Session AUTO », rejoué en script."""

    def test_the_run_places_every_figure_inside_the_park(self):
        import importlib.util
        path = os.path.join(os.path.dirname(__file__), "..", "scripts", "session.py")
        spec = importlib.util.spec_from_file_location("session_script", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        robot = Robot(rate=100)
        played = []
        real_figure = robot.figure

        def spy(name, **kwargs):
            info = real_figure(name, **kwargs)
            played.append(info["figure"])
            return info

        robot.figure = spy
        module.build(robot)
        report = robot.report()

        self.assertEqual(report["limit_violations"], {})
        self.assertEqual(report["unreachable_targets"], 0)
        self.assertLess(report["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

        # le run part de la plateforme du quarter arrière et va jusqu'à celle
        # du quarter avant : il tient entre les deux extrémités du parc
        xs = [f["base"][0] for f in robot.frames]
        self.assertGreater(min(xs), -3.95)
        self.assertLess(max(xs), 9.15)
        # le robot est bien passé par le haut de la rampe la plus haute
        park = terrain.get("skatepark")
        self.assertLess(min(xs), -3.40)
        self.assertAlmostEqual(park.height_at(min(xs), 0.0), 0.45)
        # et il a longé le ledge sur deux roues, sur toute sa longueur
        beside = [f["base"][0] for f in robot.frames if f["base"][1] > 1.0]
        self.assertLess(min(beside), 3.40)
        self.assertGreater(max(beside), 6.20)
        # la ligne, dans l'ordre
        self.assertEqual(played, [
            "Salto avant roues", "Saut", "Sur deux roues",
            "540 McTwist roues", "Slide"])
        self.assertAlmostEqual(robot.natural.vx, 0.0, places=2)   # fini à l'arrêt

    def test_the_ramps_launch_the_figures(self):
        """Les figures aériennes décollent d'une rampe, pas du plat."""
        park = terrain.get("skatepark")
        for name, lip, approach in (("wheeljump", 2.10, 1.34),
                                    ("wheelfrontflip", 4.30, 3.95)):
            fig = stunts.WHEEL_FIGURES[name]
            robot = Robot(rate=200, mode="roues", terrain="skatepark")
            robot.recenter()
            while robot.base[0] < approach:
                robot.walk(vx=1.4, seconds=0.01)
            start = len(robot.frames)
            robot.figure(name)
            # image où la poussée se termine : c'est là que le robot quitte le sol
            k = start + int((fig.crouch + fig.push) / robot.dt)
            x = robot.frames[k]["base"][0]
            self.assertGreater(park.height_at(x, 0.0), 0.05, name)   # sur la rampe
            self.assertLess(abs(x - lip), 0.35, name)                # près de la lèvre
            self.assertLess(robot.report()["peak_joint_velocity_rad_s"],
                            DEFAULT.velocity_max, name)


class TestWheelFigures(unittest.TestCase):
    def _run(self, name):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=1.0, seconds=1.0)
        info = robot.figure(name)
        robot.hold(1.2)                     # le temps que l'assiette se stabilise
        return robot, info

    def test_a_charged_jump_prepares_while_rolling_then_fires(self):
        """Appui maintenu : le robot s'arme, continue de rouler, puis détend.

        C'est le geste du skate — on charge en roulant et on détend où l'on
        veut. Le vol doit donc partir plus loin, sans rien coûter aux moteurs.
        """
        charged = Robot(rate=200, mode="roues")
        charged.walk(vx=1.4, seconds=1.5)
        start = charged.base[0]
        info = charged.figure("wheeljump", charge_seconds=1.2)
        charged.hold(1.2)

        plain = Robot(rate=200, mode="roues")
        plain.walk(vx=1.4, seconds=1.5)
        plain.figure("wheeljump")
        plain.hold(1.2)

        # 1,2 s de charge à 1,4 m/s : le robot a parcouru 1,7 m de plus
        gained = (charged.base[0] - start) - (plain.base[0] - start)
        self.assertAlmostEqual(gained, 1.4 * 1.2, delta=0.15)
        self.assertAlmostEqual(info["duration_s"],
                               stunts.WHEEL_FIGURES["wheeljump"].duration + 1.2,
                               places=2)
        report = charged.report()
        self.assertEqual(report["limit_violations"], {})
        self.assertLess(report["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)
        self.assertLess(abs(charged.base[4]), 0.05)            # repose à plat

    def test_only_a_figure_that_leaves_the_ground_can_be_charged(self):
        """Une tenue ou une pirouette n'a pas d'armement à garder sous tension."""
        robot = Robot(rate=100, mode="roues")
        with self.assertRaises(ValueError):
            robot.figure("wheelie", charge_seconds=0.5)
        with self.assertRaises(ValueError):
            robot.figure("pirouette", charge_seconds=0.5)

    def test_catalogue_depends_on_the_mode(self):
        legs = Robot(rate=50)
        self.assertIn("backflip", legs.figures())
        wheels = Robot(rate=50, mode="roues")
        self.assertEqual(wheels.figures(),
                         ["pirouette", "powerslide", "sidestand",
                          "wheeldoubleflip", "wheeldoublefrontflip",
                          "wheeldoublesideflipL", "wheeldoublesideflipR",
                          "wheelflip", "wheelfrontflip", "wheelie", "wheeljump",
                          "wheelsideflipL", "wheelsideflipR", "wheeltumble",
                          "wheeltwist540"])
        with self.assertRaises(KeyError):
            wheels.figure("backflip")

    def test_all_wheel_figures_stay_in_the_envelope(self):
        for name in stunts.WHEEL_FIGURES:
            robot, _ = self._run(name)
            report = robot.report()
            self.assertEqual(report["limit_violations"], {}, name)
            self.assertLess(report["peak_joint_velocity_rad_s"], DEFAULT.velocity_max, name)
            self.assertLess(abs(robot.base[4]), 0.05, name)        # repose à plat

    def test_the_chained_backflip_lands_its_wheels_two_by_two(self):
        """Le salto enchaîné ne quitte pas vraiment le sol : arrière, vol, avant."""
        robot = Robot(rate=200, mode="roues")
        robot.figure("wheeltumble")
        fig = stunts.WHEEL_FIGURES["wheeltumble"]
        # on lit les appuis image par image sur le premier tour
        pattern = []
        for frame in robot.frames:
            on = tuple(bool(c) for c in frame["contact"])
            if not pattern or pattern[-1] != on:
                pattern.append(on)
        rear = tuple(leg.front < 0 for leg in DEFAULT.legs)
        front = tuple(leg.front > 0 for leg in DEFAULT.legs)
        self.assertIn(rear, pattern)                     # d'abord l'essieu arrière
        self.assertIn((False,) * 4, pattern)             # un vol court
        self.assertIn(front, pattern)                    # puis l'essieu avant
        self.assertLess(pattern.index(rear), pattern.index(front))
        # les quatre roues ne sont jamais en l'air plus longtemps que le vol
        air = sum(1 for f in robot.frames if not any(f["contact"])) / 200.0
        self.assertLess(air, fig.over + 0.03)
        # et la caisse a bien fait un tour complet, sans sortir de l'enveloppe
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_the_chained_backflip_moves_its_legs_like_a_gymnast(self):
        """Les pattes accompagnent le tour au lieu de rester figées.

        La première version gardait les quatre jambes immobiles dans le
        repère de la caisse : le tour se lisait comme un bloc qui bascule.
        Une gymnaste pousse sur ses appuis, se groupe, ouvre pour aller
        chercher la poutre, puis amortit — et chacun de ces gestes doit se
        voir dans les angles.
        """
        robot = Robot(rate=200, mode="roues")
        robot.figure("wheeltumble")
        cols = list(zip(*[f["q"] for f in robot.frames]))
        sweep = [max(c) - min(c) for c in cols]
        # hanches et genoux balaient plus d'un radian : ça se groupe et ça ouvre
        moving = [sweep[j] for j in range(12) if j % 3]   # HFE et KFE
        self.assertGreater(min(moving), 0.35)          # aucune n'est figée
        self.assertGreater(max(moving), 1.05)          # et le groupé est franc
        # la réception s'amortit : la caisse descend sous sa garde au poser,
        # puis la retrouve
        fig = stunts.WHEEL_FIGURES["wheeltumble"]
        plant = [f["base"][2] for f in robot.frames
                 if fig.rear + fig.over < f["t"] < fig.cycle]
        ride = robot.height * 0.92 + gait.WHEEL_RADIUS
        self.assertLess(min(plant), ride - 0.02)
        self.assertAlmostEqual(plant[-1], ride, delta=0.02)
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)
        self.assertEqual(robot.report()["limit_violations"], {})

    def test_holding_the_chained_backflip_adds_whole_turns(self):
        """Tenu, il enchaîne — et il ne coupe jamais un tour en cours."""
        fig = stunts.WHEEL_FIGURES["wheeltumble"]
        short = Robot(rate=100, mode="roues").figure("wheeltumble")
        long_ = Robot(rate=100, mode="roues").figure("wheeltumble", hold_seconds=2.2)
        self.assertEqual(short["rotation_deg"], 360.0)
        self.assertEqual(long_["rotation_deg"], 1080.0)
        self.assertAlmostEqual(long_["duration_s"] - short["duration_s"],
                               2 * fig.cycle, places=2)

    def test_a_held_pirouette_keeps_turning(self):
        """La vrille s'intègre en vitesse : elle tourne tant qu'on la tient."""
        free = Robot(rate=200, mode="roues")
        free.figure("pirouette")
        held = Robot(rate=200, mode="roues")
        held.figure("pirouette", hold_seconds=2.0)
        self.assertGreater(abs(held.base[5]), abs(free.base[5]) * 1.8)
        # tenue plus longtemps ne veut pas dire plus vite : le régime est le même
        self.assertAlmostEqual(held.report()["peak_joint_velocity_rad_s"],
                               free.report()["peak_joint_velocity_rad_s"], places=1)
        self.assertLess(held.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_wheelie_stands_the_chassis_up(self):
        robot, _ = self._run("wheelie")
        pitches = [f["base"][4] for f in robot.frames]
        self.assertLess(min(pitches), -1.4)                        # quasi vertical
        lifted = [f for f in robot.frames if sum(f["contact"]) == 2]
        self.assertGreater(len(lifted), 100)                       # deux roues au sol
        self.assertEqual(self._grounded(robot), {"lh", "rh"})      # le train arrière
        self._check_wheels_on_the_ground(robot)

    def test_sidestand_balances_on_the_right_wheels(self):
        robot, _ = self._run("sidestand")
        rolls = [f["base"][3] for f in robot.frames]
        self.assertGreater(max(rolls), 1.35)                       # sur la tranche
        self.assertEqual(self._grounded(robot), {"rf", "rh"})      # le côté droit
        self._check_wheels_on_the_ground(robot)
        self.assertLess(abs(robot.base[3]), 0.02)                  # remis à plat

    def _grounded(self, robot):
        """Roues en contact au milieu de la tenue."""
        frame = robot.frames[int(len(robot.frames) * 0.5)]
        return {leg.name for i, leg in enumerate(robot.model.legs) if frame["contact"][i]}

    def _check_wheels_on_the_ground(self, robot):
        """Le basculement est rigide : les roues d'appui touchent exactement."""
        frame = robot.frames[int(len(robot.frames) * 0.5)]
        roll, pitch = frame["base"][3], frame["base"][4]
        cr, sr = math.cos(roll), math.sin(roll)
        cp, sp = math.cos(pitch), math.sin(pitch)
        for i, leg in enumerate(robot.model.legs):
            p = kin.forward(leg, frame["q"][i * 3:i * 3 + 3], robot.model)
            z = frame["base"][2] + (-sp * p[0] + cp * (sr * p[1] + cr * p[2]))
            tyre = z - gait.WHEEL_RADIUS
            if frame["contact"][i]:
                self.assertAlmostEqual(tyre, 0.0, places=3, msg=leg.name)
            else:
                self.assertGreater(tyre, 0.25, leg.name)           # franchement en l'air

    def test_wheel_double_flip_turns_twice(self):
        robot, info = self._run("wheeldoubleflip")
        self.assertEqual(info["rotation_deg"], 720.0)
        pitches = [f["base"][4] for f in robot.frames]
        self.assertLess(min(pitches), -2 * math.tau + 0.3)         # deux tours complets
        self.assertGreater(info["apex_m"], 0.85)                   # détente à 4,2 m/s

    def test_wheel_mctwist_flips_and_twists(self):
        robot, info = self._run("wheeltwist540")
        self.assertEqual(info["rotation_deg"], 360.0)
        self.assertEqual(info["twist_deg"], 540.0)
        yaws = [f["base"][5] for f in robot.frames]
        self.assertAlmostEqual(yaws[-1] - yaws[0], 1.5 * math.tau, places=2)
        rolls = [abs(f["base"][3]) for f in robot.frames]
        self.assertGreater(max(rolls), 0.3)                        # la gîte du McTwist
        self.assertLess(abs(robot.base[3]), 0.02)                  # remis à plat

    def test_mctwist_lands_fakie_and_keeps_rolling(self):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=1.2, seconds=1.5)
        x0, y0 = robot.base[0], robot.base[1]
        robot.figure("wheeltwist540")
        self.assertEqual(robot.natural.direction, -1)              # reçu en fakie
        self.assertLess(robot.natural.vx, -1.0)                    # roues en arrière
        robot.walk(vx=1.2, seconds=2.0)
        self.assertLess(robot.natural.vx, -1.0)                    # et ça continue
        # la vrille ne fait pas dévier : c'est la quantité de mouvement qui porte
        after = [f for f in robot.frames if f["base"][0] >= x0]
        self.assertLess(max(abs(f["base"][1] - y0) for f in after), 0.01)
        self.assertGreater(robot.base[0] - x0, 3.0)                # tout droit, devant
        robot.figure("wheeltwist540")                              # un second remet d'endroit
        self.assertEqual(robot.natural.direction, 1)
        robot.walk(vx=1.2, seconds=1.0)
        self.assertGreater(robot.natural.vx, 1.0)

    def test_tilt_hold_is_as_long_as_asked(self):
        short = Robot(rate=100, mode="roues").figure("wheelie", hold_seconds=0.5)
        long_ = Robot(rate=100, mode="roues").figure("wheelie", hold_seconds=4.0)
        self.assertAlmostEqual(long_["duration_s"] - short["duration_s"], 3.5, places=2)
        with self.assertRaises(ValueError):                        # pas une tenue
            Robot(rate=50, mode="roues").figure("wheelflip", hold_seconds=2.0)

    def test_front_flip_turns_the_other_way(self):
        for mode, name in (("pattes", "frontflip"), ("roues", "wheelfrontflip")):
            robot = Robot(rate=200, mode=mode)
            robot.walk(vx=0.8, seconds=1.0)
            robot.figure(name)
            pitches = [f["base"][4] for f in robot.frames]
            self.assertGreater(max(pitches), math.tau - 0.05, name)    # un tour avant
            self.assertGreater(min(pitches), -0.6, name)               # jamais en arrière
            self.assertLess(robot.report()["peak_joint_velocity_rad_s"],
                            DEFAULT.velocity_max, name)
            self.assertLess(abs(robot.base[4]), 0.05, name)            # repose à plat

    def test_side_flips_roll_each_way(self):
        for name, way in (("wheelsideflipL", 1), ("wheelsideflipR", -1)):
            robot = Robot(rate=200, mode="roues")
            robot.walk(vx=0.8, seconds=1.0)
            robot.figure(name)
            rolls = [f["base"][3] for f in robot.frames]
            extreme = max(rolls) if way > 0 else min(rolls)
            self.assertAlmostEqual(abs(extreme), math.tau, delta=0.05, msg=name)
            self.assertEqual(way > 0, max(rolls) > 0.5, name)          # bon côté
            self.assertLess(robot.report()["peak_joint_velocity_rad_s"],
                            DEFAULT.velocity_max, name)
            self.assertLess(abs(robot.base[3]), 0.05, name)            # remis à plat

    def test_powerslide_stops_the_robot_sideways(self):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=2.4, seconds=2.0)
        x0, y0, yaw0 = robot.base[0], robot.base[1], robot.base[5]
        n0 = len(robot.frames)
        robot.figure("powerslide")
        # la caisse se met en travers…
        self.assertAlmostEqual(robot.base[5] - yaw0, 1.35, delta=0.02)
        # …mais la quantité de mouvement continue tout droit
        self.assertGreater(robot.base[0] - x0, 0.5)
        self.assertAlmostEqual(robot.base[1] - y0, 0.0, places=3)
        after = [f for f in robot.frames[n0:]]
        self.assertAlmostEqual(max(abs(f["base"][1] - y0) for f in after), 0.0, places=3)
        self.assertAlmostEqual(robot.natural.vx, 0.0, places=3)        # à l'arrêt
        self.assertAlmostEqual(robot.base[3], 0.0, places=3)           # roulis à plat

    def test_a_tilt_needs_level_ground(self):
        robot = Robot(rate=100, mode="roues", terrain="escalier")
        robot.walk(vx=1.0, seconds=6.0)
        robot.brake(1.5)
        self.assertGreater(stunts.level_under_wheels(robot), 0.03)
        with self.assertRaises(ValueError):                        # en plein escalier
            robot.figure("wheelie")
        robot.recenter()                                           # de retour à plat
        robot.figure("wheelie", hold_seconds=0.5)
        self.assertLess(robot.report()["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_recenter_puts_the_robot_back_without_a_false_spike(self):
        for mode in ("pattes", "roues"):
            robot = Robot(rate=100, mode=mode, terrain="skatepark")
            robot.walk(vx=0.6, seconds=8.0)
            before = robot.report()["peak_joint_velocity_rad_s"]
            robot.recenter()
            self.assertEqual((robot.base[0], robot.base[1], robot.base[5]), (0.0, 0.0, 0.0))
            self.assertEqual(robot.natural.direction, 1)
            robot.hold(0.5)
            # une téléportation n'est pas un mouvement : elle ne doit rien coûter
            self.assertAlmostEqual(robot.report()["peak_joint_velocity_rad_s"], before,
                                   places=2, msg=mode)
            # et la caisse est à la bonne garde pour le train en place
            ride = robot.height * 0.92 + gait.WHEEL_RADIUS if mode == "roues" else robot.height
            self.assertAlmostEqual(robot.base[2], ride, delta=0.02, msg=mode)

    def test_wheel_figures_start_cold_without_a_spike(self):
        """Une figure lancée dès l'entrée en roues ne doit pas sauter d'un rayon."""
        for name in stunts.WHEEL_FIGURES:
            robot = Robot(rate=200, mode="roues")
            robot.figure(name)
            self.assertLess(robot.report()["peak_joint_velocity_rad_s"],
                            DEFAULT.velocity_max, name)

    def test_pirouette_turns_540(self):
        robot, info = self._run("pirouette")
        self.assertAlmostEqual(math.degrees(robot.base[5]) % 360, 180.0, places=1)
        self.assertEqual(info["twist_deg"], 540.0)

    def test_jump_leaves_the_ground(self):
        robot, info = self._run("wheeljump")
        self.assertGreater(info["apex_m"], 0.2)
        airborne = [f for f in robot.frames if not any(f["contact"])]
        self.assertGreater(len(airborne), 50)

    def test_wheel_flip_turns_once(self):
        robot, info = self._run("wheelflip")
        self.assertEqual(info["rotation_deg"], 360.0)
        pitches = [f["base"][4] for f in robot.frames]
        self.assertLess(min(pitches), -6.0)


class TestFigures(unittest.TestCase):
    def test_catalogue(self):
        self.assertEqual(sorted(stunts.FIGURES),
                         ["backflip", "doubleflip", "frontflip", "mctwist540"])
        self.assertEqual(stunts.FIGURES["doubleflip"].turns, 2.0)
        self.assertEqual(stunts.FIGURES["mctwist540"].twist, 1.5)

    def test_each_figure_lands_clean(self):
        for name in stunts.FIGURES:
            robot = Robot(rate=200)
            robot.stand(0.4)
            info = robot.figure(name)
            robot.hold(0.5)
            report = robot.report()
            self.assertEqual(report["limit_violations"], {}, name)
            self.assertLess(report["peak_joint_velocity_rad_s"], DEFAULT.velocity_max, name)
            self.assertAlmostEqual(robot.base[2], robot.height, places=2)
            self.assertLess(abs(robot.base[4]), 0.05, name)
            self.assertGreater(info["apex_m"], 0.6, name)

    def test_double_turns_twice(self):
        robot = Robot(rate=200)
        robot.stand(0.3)
        robot.double_backflip()
        pitches = [f["base"][4] for f in robot.frames]
        self.assertLess(min(pitches), -2 * math.pi - 3.0)   # dépasse un tour

    def test_mctwist_ends_backwards(self):
        robot = Robot(rate=200)
        robot.stand(0.3)
        info = robot.mctwist540()
        self.assertEqual(info["twist_deg"], 540.0)
        self.assertAlmostEqual(math.degrees(robot.base[5]) % 360, 180.0, places=1)
        rolls = [abs(f["base"][3]) for f in robot.frames]
        self.assertGreater(max(rolls), 0.3)                 # la vrille est inclinée

    def test_unknown_figure(self):
        robot = Robot(rate=50)
        with self.assertRaises(KeyError):
            robot.figure("triple_lutz")


class TestBackflip(unittest.TestCase):
    def test_flight_is_ballistic(self):
        flip = stunts.DEFAULT_FLIP
        self.assertAlmostEqual(flip.flight, 2 * flip.vz / 9.81, places=6)
        self.assertAlmostEqual(flip.apex, flip.takeoff_z + flip.vz ** 2 / (2 * 9.81), places=6)
        self.assertGreater(flip.apex, 0.6)               # le robot décolle vraiment

    def test_full_rotation_and_landing(self):
        robot = Robot(rate=200)
        robot.stand(0.4)
        info = robot.backflip()
        self.assertEqual(info["rotation_deg"], 360.0)
        pitches = [f["base"][4] for f in robot.frames]
        self.assertLess(min(pitches), -6.0)              # passe par -2π
        robot.hold(0.5)
        self.assertAlmostEqual(robot.base[2], robot.height, places=2)
        self.assertLess(abs(robot.base[4]), 0.05)        # retombe à plat

    def test_stays_within_actuator_limits(self):
        robot = Robot(rate=200)
        robot.stand(0.4)
        robot.backflip()
        report = robot.report()
        self.assertEqual(report["limit_violations"], {})
        self.assertLess(report["peak_joint_velocity_rad_s"], DEFAULT.velocity_max)

    def test_apex_reached_in_frames(self):
        robot = Robot(rate=200)
        robot.stand(0.3)
        robot.backflip()
        zmax = max(f["base"][2] for f in robot.frames)
        self.assertAlmostEqual(zmax, stunts.DEFAULT_FLIP.apex, places=2)


class TestModel(unittest.TestCase):
    def test_defaults_match_urdf(self):
        self.assertAlmostEqual(DEFAULT.l1, 0.215427)
        self.assertAlmostEqual(DEFAULT.l2, 0.229819)
        self.assertAlmostEqual(DEFAULT.mass_total, 10.856, places=3)
        self.assertEqual(len(DEFAULT.joint_names), 12)

    def test_from_xacro_when_repo_present(self):
        repo = os.environ.get("YLO2_REPO", "")
        if not repo or not os.path.isdir(repo):
            self.skipTest("dépôt elpimous/ylo-2 absent (définir YLO2_REPO)")
        model = Model.from_xacro(repo)
        self.assertAlmostEqual(model.l1, DEFAULT.l1, places=6)
        self.assertAlmostEqual(model.abad, DEFAULT.abad, places=6)


if __name__ == "__main__":
    unittest.main()
