# YLO-2 — Banc cinématique 3D

Visualiseur 3D interactif du quadrupède **YLO-2** de Vincent Foucault
([elpimous/ylo-2](https://github.com/elpimous/ylo-2)) : la machine est reconstruite dans le
navigateur à partir des cotes de son URDF, animée par un générateur d'allure, et annotée
sous-système par sous-système.

![vue isométrique](docs/preview-iso.png)

## Ouvrir

Ouvrir `index.html` dans un navigateur. Aucun serveur, aucune dépendance réseau :
three.js est embarqué dans le fichier (le seul appel externe est Google Fonts, et la page
reste lisible sans).

## Ce que la page fait

- **Cinématique réelle.** Longueurs de segments, entraxes, décalage d'abduction et limites
  articulaires proviennent de `champ_for_ylo2/ylo2_description/urdfs/const.xacro` et
  `leg.xacro`. La chaîne HAA → HFE → KFE est reconstruite à l'identique (X avant, Y gauche,
  Z haut) et résolue par cinématique inverse à chaque image.
- **Allures.** Statique, walk, trot, pace, bound. Les paramètres par défaut (hauteur
  nominale 250 mm, garde au sol 40 mm, durée d'appui 0,25 s, Vx max 0,2 m/s, ωz max
  1 rad/s) sont ceux de `ylo2_config/config/gait/gait.yaml`.
- **Télémétrie.** Les douze angles articulaires sont affichés en degrés et passent en rouge
  hors des butées URDF (HAA ±70°, KFE −159°…−37°).
- **Diagramme d'appui.** Phases d'appui et de vol des quatre pattes, avec curseur de phase.
- **Polygone de sustentation.** Appuis au sol et projection du centre de masse.
- **Vue éclatée.** Les sous-ensembles s'écartent et s'étiquettent ; la machine se fige,
  c'est un mode d'inspection.
- **Fiches.** Chaque pièce cliquable renvoie sa description, ses caractéristiques et le
  chemin correspondant dans le dépôt d'origine.

## Commandes

| Action | Effet |
| --- | --- |
| Glisser | Orbite |
| Molette / pincement | Zoom |
| Clic sur une pièce | Fiche du sous-système |
| `1` `2` `3` `4` | Iso · profil · face · dessus |
| `Espace` | Bascule trot / statique |
| `Échap` | Désélectionner |

## Structure

```
src/page.html      structure et styles
src/app.js         scène, robot, cinématique, allures, interface
vendor/three.min.js three.js r160 (UMD)
build.sh           assemble index.html et dist/artifact.html
index.html         page autonome générée
```

Après toute modification de `src/`, relancer :

```sh
./build.sh
```

## Sources des données

| Donnée | Fichier d'origine |
| --- | --- |
| Cotes, masses, butées | `champ_for_ylo2/ylo2_description/urdfs/const.xacro` |
| Chaîne articulaire | `champ_for_ylo2/ylo2_description/urdfs/leg.xacro` |
| Implantation des pattes | `champ_for_ylo2/ylo2_description/robots/ylo2.urdf.xacro` |
| Paramètres d'allure | `champ_for_ylo2/ylo2_config/config/gait/gait.yaml` |
| Actionneurs et bus CAN | `Mjbots/README.md`, `Peak4can/README.md`, `moteus_driver/` |
| Capteurs | `Myahrs+/`, `Rplidar A2/`, `Respeaker4mic/`, `Realsense_cameras/`, `Devantech_SRF10/` |

Les formes 3D sont des primitives paramétrées par ces cotes, pas les maillages `.dae` du
dépôt : les proportions et les axes sont justes, la finition des pièces est une
interprétation.
