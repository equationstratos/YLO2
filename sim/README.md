# ylo2-sim — simulateur cinématique YLO-2

Reproduit, hors ROS et hors matériel, la chaîne embarquée du robot :

```
consigne de marche  ->  trajectoires de pieds  ->  cinématique inverse  ->  consignes position moteus
     (gait.yaml)            (générateur CHAMP)          (URDF)                 (4 ports CAN-FD)
```

Ce n'est **pas** un simulateur dynamique : ni masse en mouvement, ni contact, ni
couple. Il vérifie ce qui se vérifie à ce niveau — butées articulaires, vitesses,
enveloppe de travail, stabilité statique, plan d'adressage CAN — et produit une
trajectoire que le visualiseur 3D rejoue.

## Installation

```sh
pip install -e sim/          # expose la commande ylo2-sim
```

Aucune dépendance : bibliothèque standard Python ≥ 3.8.

## Commandes

```sh
ylo2-sim list                                   # scripts fournis
ylo2-sim run sim/scripts/trot_forward.py -o out/trot.json
ylo2-sim check --repo /chemin/vers/ylo-2        # relit const.xacro et teste la cinématique
ylo2-sim can --rate 200                         # adressage CAN et charge de bus
ylo2-sim serve --port 8770 --page index.html    # pilotage en direct depuis la page 3D
```

`out/*.json` se charge dans le visualiseur : onglet **Simulation → Charger une
trajectoire**.

## Écrire un script

```python
"""Trot en ligne droite à 0,15 m/s."""
from ylo2_sim import Robot, main


def build(robot: Robot) -> None:
    robot.stand(1.0, height=0.25)
    robot.set_gait("trot")
    robot.walk(vx=0.15, seconds=8.0)
    robot.stand(1.0)


if __name__ == "__main__":
    main(build)
```

Exécutable directement (`python3 sim/scripts/trot_forward.py -o out/trot.json`)
ou via `ylo2-sim run`.

### API du robot

| Appel | Effet |
| --- | --- |
| `set_style("souple"\|"felin"\|"brut")` | style de locomotion |
| `set_gait("trot")` | allure : `stand`, `walk`, `trot`, `pace`, `bound`, `canter`, `gallop` |
| `set_terrain("escalier")` | terrain : `plat`, `escalier`, `marches_hautes`, `plateforme`, `rampe`, `gravats`, `skatepark`, `poutres` |
| `set_mode("roues")` | train de propulsion : `pattes` ou `roues` |
| `figure(nom)` | pattes : `backflip`, `frontflip`, `doubleflip`, `mctwist540` · roues : `wheelie`, `sidestand`, `pirouette`, `wheeljump`, `wheelflip`, `wheelfrontflip`, `wheelsideflipL`, `wheelsideflipR`, `wheeldoubleflip`, `wheeltwist540`, `powerslide` |
| `recenter()` | replace le robot au centre, à plat, face au +X — le bouton « Réinitialiser » du visualiseur |
| `figure(nom, hold_seconds=…)` | allonge la tenue d'un `wheelie` ou d'un `sidestand`, qui se maintiennent dans le visualiseur |
| `natural.direction` | sens de marche des roues, `+1` ou `-1`. Un `wheeltwist540` le bascule : le robot repart en fakie, roues en arrière |
| `figures()` | catalogue du train de propulsion courant |
| `brake(secondes)` | arrêt franc, consignes à zéro |
| `backflip()` · `double_backflip()` · `mctwist540()` | raccourcis |
| `command(vx, vy, wz)` | consigne, saturée aux maxima de `gait.yaml` |
| `walk(vx, seconds)` / `turn(wz, seconds)` | marche ou rotation pendant une durée |
| `stand(seconds, height)` / `squat(low, high, seconds)` | station et accroupissement |
| `set_joint(name, rad)` / `ramp_joint(name, rad, s)` | pilotage articulaire direct |
| `place_foot("lf", x, y, z)` | cible cartésienne d'un pied, repère tronc |
| `foot_position("lf")` | position courante du pied |
| `support_margin()` | marge de stabilité statique (m, négative = hors polygone) |
| `motor_commands()` | consignes position moteus, en tours rotor |
| `can_report()` | répartition des 12 axes sur les 4 ports PCAN |
| `report()` / `save(path)` | bilan de la course, écriture de la trajectoire |

Les axes portent les noms de l'URDF : `lf_haa`, `lf_hfe`, `lf_kfe`, puis `rf_`,
`lh_`, `rh_`.

## Styles de locomotion

`Robot(style="souple")` (défaut) ajoute la couche naturelle décrite dans le
README principal : rampes de consigne, choix d'allure selon la vitesse, vol du
pied en Hermite, placement à la Raibert, report de masse, compensation
d'assiette. `style="felin"` la règle sur une marche de chat — voie à 55 % de
l'entraxe, appui prolongé, cadence allongée, report de masse anticipé,
balancement du tronc, poser lent, posture basse. `style="brut"` s'en passe et
reproduit le générateur seul : c'est ce mode qui sert de référence dans les
tests de cinématique.

```python
robot = Robot(rate=200)          # souple
robot.walk(vx=0.05, seconds=3)   # bascule automatiquement en walk
robot.walk(vx=0.18, seconds=4)   # puis en trot
```

## Figures

```python
robot.stand(0.6)
info = robot.figure("mctwist540")
# {'figure': '540 McTwist', 'duration_s': 2.04, 'flight_s': 0.683,
#  'apex_m': 0.89, 'takeoff_vz_ms': 3.35, 'rotation_deg': 360.0,
#  'twist_deg': 540.0, 'travel_m': -0.06}
```

| Figure | Tangage | Vrille | Vol | Apex |
| --- | --- | --- | --- | --- |
| `backflip` | 360° | — | 0,60 s | 0,76 m |
| `doubleflip` | 720° | — | 0,86 s | 1,23 m |
| `mctwist540` | 360° | 540° | 0,68 s | 0,89 m |

Le vol est intégré sous gravité (z balistique, rotations complètes), les poses
d'armement, de groupé et de réception sont interpolées à vitesse bornée. Les
tests vérifient qu'aucune figure ne franchit de butée, qu'elles restent sous
les 20 rad/s de l'URDF et que le McTwist repose bien à 180° du cap de départ.

## Ce que le simulateur signale

- **Butées** — tout angle hors course URDF (HAA ±70°, KFE −159°…−37°) est
  consigné dans `report()["limit_violations"]` ; `--strict` lève `LimitViolation`.
- **Vitesse articulaire** — au-delà des 20 rad/s de l'URDF, l'événement est daté.
- **Enveloppe de travail** — une cible hors d'atteinte est comptée avant
  saturation de la cinématique inverse.
- **Stabilité statique** — distance du centre de masse au bord du polygone
  d'appui. En trot, deux appuis seulement : la marge est négative, ce qui est
  normal pour une allure dynamique.

## Modèle

`ylo2_sim.model.Model` porte les cotes. Par défaut ce sont les valeurs de
`const.xacro` recopiées ; `Model.from_xacro(repo)` les relit dans un clone du
dépôt (et donne exactement les mêmes).

```
L1 = 215,427 mm   L2 = 229,819 mm   abad = 92 mm
entraxes HAA : x = ±174,5 mm   y = ±63,2 mm   z = 23 mm
masse totale : 10,856 kg
```

## Format de trajectoire

`ylo2.trajectory/1`, lu par le visualiseur :

```json
{"format":"ylo2.trajectory/1","dt":0.02,
 "joints":["lf_haa","lf_hfe","lf_kfe","rf_haa", "..."],
 "frames":[{"t":0.0,"q":[12],"base":[x,y,z,roll,pitch,yaw],"contact":[4],"phase":0.0}]}
```

## Tests

```sh
python3 -m unittest discover -s sim/tests -v
YLO2_REPO=/chemin/vers/ylo-2 python3 -m unittest discover -s sim/tests   # + comparaison au xacro
```
