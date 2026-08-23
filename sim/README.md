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
| `set_gait("trot")` | allure : `stand`, `walk`, `trot`, `pace`, `bound` |
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
