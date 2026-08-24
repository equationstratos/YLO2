# YLO-2 — Banc cinématique 3D

Visualiseur 3D interactif et simulateur du quadrupède **YLO-2** de Vincent Foucault
([elpimous/ylo-2](https://github.com/elpimous/ylo-2)) : la machine est affichée avec
ses **vrais maillages**, montée sur la chaîne articulaire de son URDF, animée soit
par un générateur d'allure dans le navigateur, soit par des **scripts Python**.

![vue isométrique](docs/preview-iso.png)

![salto arrière](docs/preview-backflip.png)

![escalier](docs/preview-escalier.png)

![roues motrices](docs/preview-roues.png)

## Trois pièces

| | Où | Quoi |
| --- | --- | --- |
| **Visualiseur** | `index.html` | page autonome : géométrie réelle, allures, télémétrie, éditeur de matières |
| **Convertisseur** | `tools/convert_meshes.py` | transforme les `.dae`/`.stl` du dépôt en paquet binaire compact |
| **Simulateur** | `sim/` | paquet Python `ylo2-sim` : cinématique, allures, bus CAN, trajectoires |

## Ouvrir

```sh
./build.sh        # assemble index.html (à refaire après toute modification de src/)
```

Puis ouvrir `index.html` dans un navigateur. Aucun serveur, aucune dépendance
réseau : three.js et les maillages sont embarqués dans le fichier (le seul appel
externe est Google Fonts, et la page reste lisible sans).

## Géométrie réelle

Les visuels affichés sont ceux du dépôt d'origine, pas des primitives :

| Pièce | Fichier source | Triangles |
| --- | --- | --- |
| Tronc | `ylo2_textured_body.dae` | 18 470 |
| Carénages | `ylo2_textured_cover.dae` | 30 064 |
| Moteurs ABAD | `ylo2_textured_abad_motors.dae` | 3 360 |
| Hanche | `ylo2texturedhip.dae` | 5 534 |
| Cuisse | `ylo2_textured_upper_leg.dae` | 30 000 (décimée depuis 49 176) |
| Jambe | `lower_leg.dae` | 7 284 |
| Pied | `fl_foot.dae` | 9 020 |
| Batterie, D435, T265, accessoires, lidar | `.dae` / `.stl` | 3 × … |

`tools/convert_meshes.py` les charge, nettoie (faces dupliquées ou dégénérées,
sens des normales), calcule les normales coin par coin avec un angle de cassure
de 35°, et écrit `assets/ylo2-geometry.bin` (4,0 Mo) + son index. `build.sh`
embarque le tout gzippé en base64 : la page fait 3,2 Mo et s'ouvre en `file://`.

Trois défauts d'affichage ont été corrigés à la source plutôt que masqués :

| Symptôme | Cause | Correctif |
| --- | --- | --- |
| Éclats triangulaires sur la cuisse | la décimation repliait la coque sur elle-même | plus de décimation par défaut (`--max-tris` pour forcer) |
| Coins mal éclairés sur les tambours | `smooth_shaded` regroupe par facettes coplanaires | normales par coin, moyenne pondérée sous l'angle de cassure |
| Scintillement hanche / carter d'abduction | surfaces coïncidentes entre deux pièces de l'URDF | `polygonOffset` sur le groupe hanche |

L'acné d'ombre sur les surfaces cylindriques est traitée par un `normalBias`
adapté, pas en désactivant les ombres.

```sh
python3 tools/convert_meshes.py --repo /chemin/vers/ylo-2   # régénère les maillages
```

Les placements (rotations et miroirs des visuels de hanche, `scale="1 -1 1"` des
cuisses droites, décalage du pied) reprennent exactement les `<xacro:if>` de
`leg.xacro`. Les pièces absentes du dépôt — UP Xtreme, PCAN-M.2, myAHRS+,
ReSpeaker, SRF10 — restent des volumes simples, signalés comme tels dans les fiches.

## Couleurs et motifs

Onglet **Matières** : dix groupes de pièces (carénages, châssis, moteurs ABAD,
hanches, cuisses, jambes, pieds, capteurs, batterie, électronique). Pour chacun,
couleur, métallicité, rugosité, motif et échelle du motif.

Les motifs sont dessinés sur canvas, donc modifiables dans
`src/20-materials.js` : alu brossé, carbone, impression 3D, anodisé, nid
d'abeille, tôle perforée, bandes d'atelier. Cinq ambiances servent de point de
départ (Atelier, Carbone, Chantier, Labo, Nuit).

Les maillages du dépôt n'ont pas de coordonnées de texture exploitables : les
motifs sont donc projetés en **triplanaire** dans le repère local de chaque
pièce (`onBeforeCompile`, trois échantillons pondérés par la normale). Pas de
couture, pas d'UV à produire, et le motif reste collé à la pièce quand elle
bouge. L'échelle du curseur est en motifs par mètre.

Les réglages sont conservés dans le navigateur (`localStorage`) et s'exportent en
JSON (`ylo2.materials/1`) pour être repris ailleurs.

## Courir : l'allure suit la vitesse

Le curseur de vitesse va de −0,6 à 2,0 m/s sur pattes (3,0 m/s en roues) et
l'allure se choisit toute seule, comme chez l'animal : la durée d'appui décroît
en v^−0,55, le rapport d'appui baisse avec la vitesse, et des instants sans
aucun appui apparaissent — la suspension du galop.

| Consigne | Allure | Cycle | Suspension | Pic articulaire |
| --- | --- | --- | --- | --- |
| 0,15 m/s | Walk | 0,47 s | — | 6,1 rad/s |
| 0,50 m/s | Trot | 0,50 s | 5,8 % | 9,8 rad/s |
| 1,00 m/s | Canter | 0,43 s | 0,6 % | 12,0 rad/s |
| 1,60 m/s | Galop | 0,35 s | 18,6 % | 13,9 rad/s |
| 2,00 m/s | Galop | 0,35 s | 20,1 % | 26,2 rad/s |

Repères du commerce, pour situer : l'[Unitree Go2](https://www.unitree.com/go2)
annonce 3,7 m/s, le [B2](https://www.unitree.com/b2/) 6 m/s. YLO-2 est plus
petit, et surtout ses qdd100 sont donnés à 20 rad/s dans l'URDF : **au-delà de
1,7 m/s, la page prévient que le mouvement montré sort de la spécification**.
Jusque-là, tout ce qui est affiché reste dans l'enveloppe déclarée.

Le corps suit une vraie balistique pendant les phases de suspension (z'' = −g),
et un rappel amorti au contact — c'est ce qui donne le poids à la réception.

## Terrains et obstacles

Un sélecteur, sept terrains. La même description analytique sert à calculer la
hauteur sous chaque pied et à construire les volumes affichés : le contact et la
géométrie sont la même chose, il n'y a pas de collision approchée.

| Terrain | Relief | Ce qu'il montre |
| --- | --- | --- |
| Sol plat | — | référence |
| Escalier | 8 marches de 130 mm × 300 mm, palier, descente | montée continue |
| Marches hautes | 5 marches de 180 mm | la limite du gabarit |
| Plateforme | marche unique de 240 mm | franchissement franc |
| Rampe 20° | pente continue | assiette qui épouse la pente |
| Gravats | blocs jusqu'à 90 mm | appuis à des hauteurs différentes |
| Poutres | traverses de 140 mm | enjambement |

Quatre mécanismes s'enclenchent tout seuls, comme sur un vrai contrôleur :

- **gouverneur de vitesse** — le relief détecté à 0,75 m devant réduit la
  consigne jusqu'à 25 %, ce qui laisse le temps au vol de se faire ;
- **redressement** — la garde au sol de la caisse augmente de 18 % sur relief ;
- **dégagement adaptatif** — le vol passe au-dessus du plus haut point rencontré
  entre le décollage et le poser, plus la garde nominale ;
- **pas raccourci** — une pose hors d'atteinte est ramenée dans l'enveloppe de
  la patte avant d'être visée, plutôt que saturée à l'exécution.

Sur l'escalier de 130 mm, la médiane des vitesses articulaires reste à
6,7 rad/s ; 5 % des instants dépassent brièvement les 20 rad/s déclarés, au
moment où la patte est fouettée sur la marche suivante. Les marches de 180 mm
sont franchies mais sortent du gabarit : le robot y traîne les pieds.

## Locomotion

Trois styles, commutables dans le bandeau **Allure**. Le choix d'allure y est
soit **imposé** (un clic sur Statique, Walk, Trot, Pace ou Bound le fige), soit
rendu au style par le bouton **Auto**, qui bascule alors selon la vitesse.

**Brut** — le générateur nu, celui de `gait.yaml` : pied en sinusoïde, caisse en
sinusoïde, aucune compensation. C'est la référence, utile pour comparer.

**Souple** — la couche que les quadrupèdes modernes (Unitree Go2 et consorts)
empilent par-dessus, ici en cinématique pure :

- consignes lissées par limitation d'accélération (0,45 m/s², 2 rad/s²) ;
- choix d'allure selon la vitesse — marche sous 0,09 m/s, trot au-delà, arrêt à
  vitesse nulle — avec fondu des décalages de phase, sans à-coup ;
- vol du pied en **Hermite cubique** dont les tangentes prolongent la vitesse
  d'appui : le pied quitte et retrouve le sol à la vitesse du sol, donc plus de
  raclage ; tangente de sortie allongée, le pied recule juste avant de poser ;
- **placement à la Raibert** : demi-course d'appui plus un terme de rattrapage
  de l'erreur de vitesse — le robot « rattrape » ses pieds quand il accélère ;
- profil de garde asymétrique : montée vive, apex avancé, poser amorti ;
- enfoncement de caisse en milieu d'appui, report de masse latéral vers les
  appuis, inclinaison dans les virages, piqué proportionnel à l'accélération ;
- **compensation d'assiette** : les cibles de pied passent du repère horizon au
  repère tronc, donc les appuis restent plantés quand la caisse bouge ;
- respiration à l'arrêt.

**Félin** — même socle, réglé sur la marche d'un chat :

| Trait | Réglage | Ce que ça donne |
| --- | --- | --- |
| Voie étroite | appuis ramenés à 55 % de l'entraxe des hanches | le robot marche presque sur une ligne |
| Appui prolongé | rapport d'appui porté à 0,80, cycle allongé de 35 % | trois pattes au sol en permanence |
| Report de masse anticipé | 24 mm, avancé de 16 % de cycle | la caisse se déplace **avant** que la patte se lève |
| Balancement du tronc | ±1,1° de lacet, contre-phase du report | lecture d'une colonne qui ondule |
| Poser lent | garde réduite à 80 %, fin de vol aplatie | la patte se dépose au lieu de tomber |
| Posture basse | hauteur × 0,93, appuis arrière avancés de 22 mm | genoux plus fléchis, allure ramassée |
| Cadence irrégulière | ±1,4 % de phase par cycle | rien de métronomique |
| Seuils d'allure relevés | trot au-delà de 0,17 m/s | le félin marche longtemps avant de trotter |

Mesuré sur six secondes à consigne constante : le mode souple ne fait plus
pénétrer les pieds dans le sol (0,0 mm contre 8 mm en brut) et glisse moins en
appui (0,08 m/s contre 0,11). Les trois styles restent sous la butée de vitesse
de l'URDF (20 rad/s) : 6,8 rad/s en souple, 11 en félin, 17,5 en brut à
0,18 m/s. Le félin garde en moyenne plus de trois appuis au sol, contre deux en
trot.

### Figures

Trois boutons dans le bandeau, touches `B`, `D` et `T`, ou
`ylo2-sim run sim/scripts/figures.py`. Chacune suit six phases — armement,
bascule, poussée, vol, réception, stabilisation — et le vol est **balistique** :
hauteur et rotations viennent de la vitesse de poussée et de la gravité, pas
d'une courbe décorative.

| | Salto arrière | Double salto | 540 McTwist |
| --- | --- | --- | --- |
| Poussée | 2,95 m/s | 4,20 m/s | 3,35 m/s |
| Vol | 0,60 s | 0,86 s | 0,68 s |
| Apex de la caisse | 0,76 m | 1,23 m | 0,89 m |
| Tangage | 360° | 720° | 360° |
| Vrille | — | — | 540°, cap final à 180° |
| Inclinaison de vrille | — | — | 26° |
| Pose en l'air | groupé | groupé serré | vrille, abduction ouverte |
| Pic articulaire | 7,0 rad/s | 7,2 rad/s | 6,8 rad/s |
| Butées franchies | aucune | aucune | aucune |

Le groupé part de la pose réellement mesurée au décollage et l'ouverture se fait
par interpolation à vitesse bornée : c'est ce qui garde les figures dans les
capacités déclarées des qdd100 (20 rad/s, genou au-dessus de −159°). La caméra
recule et suit la caisse pendant la figure.

## Roues motrices

Bouton **Roues** du bandeau ou touche `W`. La variante s'inspire des
[Unitree Go2-W](https://www.unitree.com/go2) et B2-W : un moteur de roue par
patte, l'axe remplace le pied, les jambes deviennent la suspension.

| | Valeur | Référence Go2-W |
| --- | --- | --- |
| Rayon de roue | 75 mm | pneus de 7 pouces |
| Vitesse | jusqu'à 3,0 m/s | 2,5 m/s annoncés |
| Marche franchissable | ≈ 68 mm | obstacles au-delà : passage en pattes |
| Sollicitation articulaire | 1,6 rad/s en roulant | — |

Ce que fait le mode roues : suspension par patte (hauteur filtrée, vitesse de
débattement bornée), assiette qui épouse le sol, plongée au freinage et
cabrage à l'accélération, inclinaison dans les virages, roues qui tournent à
ω = v / R avec différentiel de virage. Sur le plat, il couvre 15 m en 8 s là où
les pattes en font 8 — et sans presque bouger les articulations.

Ce qu'il ne fait pas : monter une marche plus haute que la roue. Le bandeau
affiche alors un avertissement et invite à repasser sur pattes, exactement
comme un Go2-W bascule en mode marche devant un obstacle.

## Simulation Python

Le paquet `sim/` rejoue la chaîne embarquée hors ROS :

```sh
pip install -e sim/
ylo2-sim list
ylo2-sim run sim/scripts/trot_forward.py -o out/trot.json
```

Puis, dans la page : **Simulation → Charger une trajectoire**. Le générateur du
navigateur se met en retrait, les 12 angles viennent du fichier.

Pour piloter la boucle Python en direct depuis les curseurs de la page :

```sh
ylo2-sim serve --port 8770 --page index.html
```

La page sert alors de pupitre : `/api/stream` (SSE) diffuse l'état, `/api/cmd`
reçoit les consignes. Détails, API et scripts : [`sim/README.md`](sim/README.md).

## Commandes du visualiseur

| Action | Effet |
| --- | --- |
| Glisser | Orbite |
| Molette / pincement | Zoom |
| Clic sur une pièce | Fiche du sous-système |
| `1` `2` `3` `4` | Iso · profil · face · dessus |
| `Espace` | Bascule trot / statique |
| `B` · `D` · `T` | Salto arrière · double salto · 540 McTwist |
| `W` | Bascule pattes / roues |
| `Échap` | Désélectionner |

Bandeau : vue éclatée (fige la machine et étiquette les sous-ensembles), axes
articulaires, trajectoires de pieds, polygone de sustentation.

## Structure

```
src/10-data.js        cotes, allures, vitesses, sous-systèmes, groupes de matières
src/12-terrain.js     terrains analytiques : hauteur sous le pied et volumes affichés
src/20-materials.js   matières PBR et motifs procéduraux
src/30-robot.js       décodage des maillages et montage de l'arbre cinématique
src/40-motion.js      cinématique inverse, allures, lecture de trajectoire, liaison directe
src/44-locomotion.js  styles souple et félin, catalogue des figures
src/50-app.js         scène, rendu, interface
src/page.html         structure et styles
vendor/three.min.js   three.js r160 (UMD)
assets/               maillages convertis (binaire + index)
tools/                convertisseur de maillages
sim/                  simulateur Python (paquet ylo2-sim)
build.sh              assemble index.html et dist/artifact.html
```

## Sources des données

| Donnée | Fichier d'origine |
| --- | --- |
| Cotes, masses, butées | `champ_for_ylo2/ylo2_description/urdfs/const.xacro` |
| Chaîne articulaire, placements visuels | `champ_for_ylo2/ylo2_description/urdfs/leg.xacro` |
| Implantation des pattes | `champ_for_ylo2/ylo2_description/robots/ylo2.urdf.xacro` |
| Maillages | `champ_for_ylo2/ylo2_description/meshes/`, `Wolf_for_ylo2/wolf_descriptions/` |
| Paramètres d'allure | `champ_for_ylo2/ylo2_config/config/gait/gait.yaml` |
| Actionneurs et bus CAN | `Mjbots/README.md`, `Peak4can/README.md`, `moteus_driver/` |
| Capteurs | `Myahrs+/`, `Rplidar A2/`, `Respeaker4mic/`, `Realsense_cameras/`, `Devantech_SRF10/` |

La cinématique inverse du navigateur et celle du simulateur donnent les mêmes
angles au flottant près ; l'aller-retour cinématique est vérifié par les tests
(`erreur max ~1e-16 m`).
