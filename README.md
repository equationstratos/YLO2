# YLO-2 — Banc cinématique 3D

Visualiseur 3D interactif et simulateur du quadrupède **YLO-2** de Vincent Foucault
([elpimous/ylo-2](https://github.com/elpimous/ylo-2)) : la machine est affichée avec
ses **vrais maillages**, montée sur la chaîne articulaire de son URDF, animée soit
par un générateur d'allure dans le navigateur, soit par des **scripts Python**.

![vue isométrique](docs/preview-iso.png)

![salto arrière](docs/preview-backflip.png)

![escalier](docs/preview-escalier.png)

![roues motrices](docs/preview-roues.png)

![cabrage sur roues](docs/preview-cabrage.png)

![tenue sur deux roues](docs/preview-deux-roues.png)

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

Un sélecteur, huit terrains, et un bouton **Réinitialiser** (touche `R`) qui
replace le robot au centre, à plat, face au +X — le plus court chemin pour
réattaquer un obstacle. Changer de terrain le déclenche aussi, sinon on peut se
retrouver dans un mur. La même description analytique sert à calculer la hauteur
sous chaque pied et à construire les volumes affichés : le contact et la
géométrie sont la même chose, il n'y a pas de collision approchée.

| Terrain | Relief | Ce qu'il montre |
| --- | --- | --- |
| Sol plat | — | référence |
| Escalier | 8 marches de 130 mm × 300 mm, palier, descente | montée continue |
| Marches hautes | 5 marches de 180 mm | la limite du gabarit |
| Plateforme | marche unique de 240 mm | franchissement franc |
| Rampe 20° | pente continue | assiette qui épouse la pente |
| Gravats | blocs jusqu'à 90 mm | appuis à des hauteurs différentes |
| **Skatepark** | mini-plaza : kicker, funbox, ledge, deux quarter pipes | reliefs enchaînés, en pattes comme en roues |
| Poutres | traverses de 140 mm | enjambement |

### Le skatepark

![skatepark](docs/preview-skatepark.png)

Une mini-plaza dans l'esprit des skateparks en béton de Californie, réduite au
gabarit du robot — un funbox de skate fait 40 cm de haut, celui-ci 180 mm :

| Élément | Cote | Position |
| --- | --- | --- |
| Kicker d'entrée | plan à 100 mm | x 1,40 → 2,10 |
| Funbox | bank, plateau de 180 mm, bank | x 3,60 → 6,00 |
| Ledge de grind | 200 mm, le long du funbox | x 3,40 → 6,20, y 1,70 → 2,10 |
| Quarter pipes | transition de 450 mm + plateforme | x 7,80 et x −2,60, face à face |

Les modules sont largement espacés : **au moins 1,5 m de plat entre deux**, plus
2,6 m derrière la ligne de départ et 750 mm de dégagement entre le funbox et le
ledge. Il faut de l'élan avant chaque obstacle et de quoi se replacer après,
sinon on les enchaîne sans jamais rouler.

Les transitions sont de vrais quarts de cercle : le profil part tangent au sol
et finit vertical, découpé en 24 tranches qui restent au-dessus de la courbe.
Le robot les monte en partie — en roues il atteint la plateforme haute à
450 mm — mais le haut d'un quarter est vertical, donc hors gabarit par
construction.

Mesuré à 0,6 m/s en pattes : **0,1 % des instants dépassent 20 rad/s**, contre
11,7 % sur l'escalier de 130 mm. Le parc est plus roulant que les marches,
parce que ce sont des plans inclinés et non des ressauts.

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

**Arrêt.** Le bouton **Statique** sert de frein en mode roues (touche `S`) : il
remet les consignes à zéro et le robot s'arrête franchement — la décélération
est plus vive que l'accélération (4,5 contre 2,4 m/s²), et la vitesse est
remise exactement à zéro sous 2 cm/s pour qu'il ne reste pas de dérive.

**Obstacles en roues.** Une roue de 75 mm ne monte pas une marche de 130 mm :
la patte la soulève par-dessus. Chaque patte surveille le relief 22 cm devant
sa roue et, quand la marche dépasse 45 % du rayon, elle exécute un
franchissement de 0,34 s — deux pattes au maximum en même temps, jamais deux
diagonales opposées, et seulement sous 1,5 m/s. C'est ce que fait un Go2-W
devant un escalier. Résultat mesuré : l'escalier de huit marches est franchi en
roues, montée, palier et descente, avec un pic articulaire de 14,5 rad/s.

### Figures sur roues

Boutons du bandeau en mode roues, ou touches `B`, `D`, `T`, `F`, `G`, `H` dans
l'ordre où ils s'affichent.

| | Cabrage | Sur deux roues | Pirouette | Saut | Salto roues | Double salto roues | 540 McTwist roues |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Durée | 2,95 s | 3,35 s | 1,77 s | 1,53 s | 1,82 s | 2,26 s | 1,96 s |
| Ce qui se passe | châssis dressé à **83°**, sur les deux roues arrière | couché à **80°** sur les deux roues du côté droit | 540° sur place, caisse inclinée à 11° | vol de 0,47 s, apex +0,27 m | tour complet, vol 0,60 s, apex +0,44 m | deux tours, vol 0,86 s, apex +0,90 m | un tour de tangage **et** 540° de vrille, gîte de 26°, vol 0,68 s |
| Pic articulaire | 5,2 rad/s | 3,6 rad/s | 14,5 rad/s | 11,0 rad/s | 7,9 rad/s | 7,6 rad/s | 8,0 rad/s |

**Les deux tenues se maintiennent jusqu'au prochain appui sur le bouton.** Le
chrono de la figure ne s'écoule pas pendant la tenue : le robot reste dressé
indéfiniment, le bouton affiche « Reposer », et c'est le second appui qui
déclenche la reprise. En script Python, `robot.figure("wheelie",
hold_seconds=4.0)` dit combien de temps on la tient.

Une tenue fait pivoter la caisse autour d'une ligne de contact : ça suppose que
cette ligne est horizontale. Sur une transition de quarter pipe ou en plein
escalier elle ne l'est pas — forcer la géométrie coûtait jusqu'à 132 rad/s sur
la première image. La figure **refuse** donc de démarrer quand le dénivelé sous
les quatre roues dépasse 30 mm : le bandeau le dit, et côté Python c'est une
`ValueError` qui nomme le dénivelé trouvé. Sur le plateau du funbox, qui est
plat, le cabrage part à 5,2 rad/s comme sur sol plat.

**Les deux tenues basculent la caisse autour de l'essieu resté au sol.** La
première version du cabrage pilotait la hauteur de chaque essieu séparément :
pour lever le nez il fallait allonger les jambes avant d'autant, ce qui
plafonnait vers 30° et laissait le châssis loin de la verticale. Maintenant
c'est le tronc entier qui pivote sur la ligne de contact, et les **pattes
porteuses se replient** pour amener la caisse à l'aplomb de leur essieu — sans
ce repliement le tronc partirait en arrière de l'appui et le robot tomberait.
C'est ce que fait le vrai robot : il ne se contente pas de pivoter, il se
ramasse au-dessus de ses roues.

Contrôles au milieu de la tenue :

| | Cabrage | Sur deux roues |
| --- | --- | --- |
| Roues d'appui | LH + RH, pneus à 0,0000 m | RF + RH, pneus à 0,0000 m |
| Roues levées | +494 mm | +410 mm |
| Hauteur de caisse | 0,415 m | 0,375 m |
| Écart caisse ↔ ligne d'appui | 8 mm | 9 mm |
| Glissement du tronc | 185 mm vers l'arrière | 165 mm vers la droite |
| Butées, cibles hors de portée | aucune, 0 | aucune, 0 |

L'écart de 8 et 9 mm est ce qui compte : la caisse est bien **au-dessus** de
sa ligne d'appui, pas derrière. Le tronc suit réellement la bascule au lieu de
pivoter sur place, et revient à moins d'un millimètre de sa trajectoire
nominale une fois reposé. La tenue reste une posture d'équilibre — comme sur
un Go2-W, ce sont les roues qui la rattrapent en permanence ; le simulateur
n'asservit pas cet équilibre, il place la géométrie qui le rend possible.

Les deux dernières figures reprennent sur roues celles du mode pattes. Le double
salto demande la même impulsion que sur pattes — 4,2 m/s au décollage, contre
2,95 pour un tour simple — donc un accroupissement plus franc (66 % de la garde
au lieu de 72 %) et une reprise allongée. Le McTwist superpose au salto une
vrille d'un tour et demi avec un peu de gîte, pour que l'axe de vrille soit
incliné comme sur la figure de skate d'origine ; la gîte est ramenée à plat
pendant la réception, sans quoi une roue toucherait avant les autres.

À la reprise, le générateur d'allure repart d'appuis neufs. Il raisonne en
appuis plantés dans le monde, et après un 540 — qui tourne le robot d'un
demi-tour et le déplace — ces repères dataient d'avant et n'étaient plus sous
les hanches : le premier pas visait des cibles aberrantes, la butée d'abduction
s'en mêlait et **les pattes s'entremêlaient**. Relevé après correction, deux
secondes après la figure : abduction maximale 0,02 rad, contre 1,09 rad (la
butée est à 1,22) auparavant.

**Le 540 se reçoit en fakie.** Un tour et demi de vrille, c'est un demi-tour
net : le robot retombe face à l'arrière de sa trajectoire. Deux conséquences,
toutes deux corrigées :

- Pendant la vrille, l'avance suivait le cap — qui tourne sous le robot — si
  bien que le 540 décrivait une spirale puis repartait dans l'autre sens au
  poser. C'est maintenant la **quantité de mouvement** qui porte la caisse, en
  ligne droite : écart latéral mesuré sur toute la figure, 0,0000 m.
- Au toucher des roues, les pneus sont traînés en arrière. Le sens de marche
  bascule donc à cet instant précis : la roue passe à −14,4 rad/s et le robot
  **continue sur son erre, roues à l'envers**, exactement comme un skateur qui
  repart fakie. La consigne de vitesse s'applique dans ce sens tant qu'on ne
  refait pas de demi-tour ; un second 540 le remet d'endroit (cap 1080°, soit
  un tour complet, et sens de marche à nouveau +1). Le bandeau affiche
  « fakie, roues en arrière » tant que ça dure, et repasser sur pattes remet
  le sens à l'endroit.

### Salto avant, saltos latéraux, slide

Quatre figures de plus sur roues, plus un salto avant sur pattes.

| | Salto avant | Salto latéral (gauche / droit) | Slide |
| --- | --- | --- | --- |
| Axe | tangage, sens inverse | **roulis**, un tour complet | lacet, en travers |
| Durée | 1,88 s | 1,88 s | 1,60 s |
| Vol / apex | 0,62 s · +0,47 m | 0,62 s · +0,47 m | — |
| Pic articulaire | 8,0 rad/s | 6,8 rad/s | 1,5 rad/s |

Le salto avant réutilise la mécanique du salto arrière : un seul champ,
`sense`, vaut −1 et retourne d'un coup le chargement, la poussée et le sens de
rotation. Les saltos latéraux tournent autour de l'axe de roulis — jambes
figées dans le repère de la caisse pendant le tour, comme pour un salto de
tangage — et se recalent à plat au poser, puisqu'un tour complet ramène à
l'endroit.

Le **slide** est le seul à ne pas décoller. La caisse pivote de 77° en travers
pendant que la quantité de mouvement continue tout droit, le robot s'incline
dans le dérapage, et les pneus chassent : la roue ne tourne plus qu'à la
projection de la trajectoire sur le cap. Mesuré depuis 2,0 m/s : **0,99 m de
glisse en ligne droite** (écart latéral 0,000 m) jusqu'à l'arrêt complet.

### Session AUTO

Bouton **Session AUTO** en mode roues (touche `A`) : le robot enchaîne un run
complet dans le skatepark, figures placées là où le relief les appelle, caméra
qui suit. Le script est une liste d'actes — *poser*, *rouler jusqu'à*,
*rejoindre*, *pivoter*, *freiner*, *figure*, *pause* — et chacun sait quand il
est fini : c'est ce qui donne le rythme, on n'attend pas un chrono, on attend
d'être arrivé.

Le run **part du point le plus haut du parc** — la plateforme du quarter
arrière, à 450 mm — et va jusqu'à celle du quarter avant.

| | Acte | Lancé par | Départ → arrivée |
| --- | --- | --- | --- |
| 1 | Drop-in depuis la plateforme à 450 mm | — | −3,50 → −3,01 |
| 2 | **Salto avant** | **la transition du quarter** (sol 270 mm) | −3,01 → −2,48 |
| 3 | **Saut** | **le kicker** | 1,30 → 2,99 |
| 4 | **Sur deux roues, tout le long du ledge** | — (tenue **en roulant**) | 2,93 → 6,51 |
| 5 | **540 McTwist** | **la lèvre du quarter avant** | 7,25 → 8,55, sur la plateforme |
| 6 | Slide | — | 3,44 → 2,74 |

Trois mécaniques ont dû être ajoutées pour ça :

- **la réception épouse la courbure.** Une transition est une courbe : s'y
  recevoir à plat revient à planter le nez dedans. Le relief est échantillonné
  devant et derrière, à l'empattement — exactement comme la couche roues le
  fait avec ses appuis — et la caisse rejoint cette assiette pendant la
  réception puis la stabilisation. En fin de figure, « à plat » veut dire
  l'assiette de la pente, pas l'horizontale ;
- **une tenue peut se faire en roulant.** Le cabrage et la tenue latérale
  gardaient leur vitesse : il suffisait de la commander. Le robot remonte donc
  le ledge sur ses deux roues droites, de x 2,93 à 6,51 — l'obstacle va de
  3,40 à 6,20, il est longé sur toute sa longueur ;
- **la session sait se placer et braquer.** Trois actes de plus — `place`
  (poser le robot d'aplomb en haut d'une rampe), `goto` (rejoindre un point en
  braquant, pour changer de voie) et `face` (pivoter jusqu'à un cap). Sans ce
  dernier, `goto` arrivait au point mais en visant sa cible : « avancer » le
  long du ledge partait de travers, et à plus de 90° le robot le remontait à
  reculons.

Le ledge se longe **dans le sens de la marche** : y revenir en arrière
imposait un demi-tour dont l'arc mordait sur l'obstacle — 195 rad/s.

Relevé sur le run complet : **36,8 s, pic 17,7 rad/s, aucune butée, aucune
cible hors de portée** — tout tient sous les 20 rad/s déclarés. Deux réglages
ont été nécessaires pour y arriver : le drop-in se fait à 1,0 m/s (à 1,2 le
décollage sur la courbe coûtait 20,7 rad/s), et le slide se termine sur le
plat entre le kicker et le funbox — il finissait avant sur la rampe du
kicker, et le robot restait planté de travers à 14°. Le même
enchaînement en script : `ylo2-sim run sim/scripts/session.py`.

Un acte *rouler jusqu'à* s'arrête maintenant au **dépassement** de la cible,
plus dans une fenêtre de 60 mm. La fenêtre tenait tant que le pas était court ;
à 2 m/s et 15 images par seconde le robot avance de 130 mm par image et
l'enjambe, l'acte repartait alors en va-et-vient jusqu'à sa garde de 12 s, et
le slide final se déclenchait un mètre et demi trop loin — sur la rampe du
kicker, justement.

Une réserve : le 540 se reçoit **sur la plateforme** du quarter avant, pas sur
la courbe. Le robot monte la transition, décolle près de la lèvre, et retombe
au-dessus — c'est ce que la géométrie donne à cette vitesse. La réception
épouse quand même le relief sous elle, simplement ce relief est plat à cet
endroit.

Un décompte corrigé en chemin : `clamp_command` saturait la consigne au maximum
de la **marche** (1,7 m/s) dans les deux modes, alors que la couche roues en
accepte 3,0. Les scripts étaient donc bridés là où le visualiseur ne l'était
pas ; les relances du run atteignent maintenant vraiment leurs 2,2 m/s.

En vol, le débattement des jambes est borné **relativement à la caisse** : quand
elle monte à 3 m/s en balistique, ce sont les mouvements par rapport au tronc
qui coûtent des rad/s, pas la translation. Pour le salto, les jambes sont
figées dans le repère du tronc pendant la rotation, puis ouvertes vers l'appui
par un fondu — sans quoi le passage vol → sol coûtait 190 rad/s en une image.

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
| `S` | Arrêt (frein en roues) |
| `F` | Quatrième figure du mode courant |
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
