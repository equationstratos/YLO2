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

    def test_switch_back_to_legs(self):
        robot = Robot(rate=200, mode="roues")
        robot.walk(vx=1.5, seconds=3.0)
        robot.set_mode("pattes")
        robot.walk(vx=0.4, seconds=4.0)
        self.assertEqual(robot.report()["limit_violations"], {})
        self.assertIn(robot.gait.name, ("walk", "trot"))


class TestFigures(unittest.TestCase):
    def test_catalogue(self):
        self.assertEqual(sorted(stunts.FIGURES), ["backflip", "doubleflip", "mctwist540"])
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
