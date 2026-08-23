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
        robot = Robot(rate=100)
        robot.set_gait("trot")
        robot.walk(vx=0.15, seconds=4.0)
        self.assertAlmostEqual(robot.base[0], 0.6, places=2)
        self.assertEqual(robot.report()["limit_violations"], {})

    def test_turn_heading(self):
        robot = Robot(rate=100)
        robot.set_gait("walk")
        robot.turn(wz=0.5, seconds=2.0)
        self.assertAlmostEqual(math.degrees(robot.base[5]), math.degrees(1.0), places=1)

    def test_trot_has_two_contacts(self):
        robot = Robot(rate=100)
        robot.set_gait("trot")
        robot.walk(vx=0.1, seconds=1.0)
        self.assertEqual(sum(robot.contacts), 2)

    def test_stand_is_statically_stable(self):
        robot = Robot(rate=50)
        robot.stand(0.5)
        self.assertGreater(robot.support_margin(), 0.05)

    def test_strict_mode_raises(self):
        robot = Robot(rate=50, strict=True)
        with self.assertRaises(LimitViolation):
            robot.set_joint("lf_kfe", math.radians(-10))

    def test_velocity_watchdog(self):
        robot = Robot(rate=50)
        robot.set_joint("lf_kfe", math.radians(-150))   # saut brutal
        robot.step()
        self.assertTrue(any("rad/s" in e for e in robot.events))

    def test_trajectory_round_trip(self):
        robot = Robot(rate=50)
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
