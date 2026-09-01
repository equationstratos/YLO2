/* =====================================================================
   YLO-2 — terrains et obstacles

   Un jeu de terrains analytiques : la même description sert à calculer la
   hauteur sous un pied (`heightAt`) et à construire les volumes affichés.
   Pas de heightmap ni de collision approchée — la géométrie et le contact
   sont exactement la même chose.

   Les cotes sont calées sur ce que passent les quadrupèdes du commerce :
   Unitree Go2 monte des marches d'environ 16 cm, le B2 des marches de
   20 à 25 cm et des pentes jusqu'à 45°. YLO-2 a une patte de 445 mm
   (215 + 230), donc des marches de 12 à 18 cm sont dans son gabarit.
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;

  /* --- primitives : chaque terrain est une liste de boîtes posées au sol --- */
  function box(x0, x1, y0, y1, h) {
    return { x0: x0, x1: x1, y0: y0, y1: y1, h: h, z0: 0 };
  }

  /**
   * Volume EN L'AIR : un linteau, le dessus d'une fenêtre, une poutre à
   * enjamber par-dessous.
   *
   * Tout le reste du terrain est un champ de hauteurs — une colonne pleine
   * depuis le sol —, et un champ de hauteurs ne sait pas dire « plein en
   * haut, vide en bas ». Une fenêtre a besoin exactement de ça. Ces boîtes-là
   * ne comptent donc pas dans `heightAt` : il n'y a rien à poser une roue
   * dessous. Elles n'existent que pour ce qu'elles empêchent — passer.
   */
  function lintel(x0, x1, y0, y1, z0, h) {
    return { x0: x0, x1: x1, y0: y0, y1: y1, h: h, z0: z0 };
  }

  function stairs(startX, steps, rise, run, halfWidth, down) {
    const out = [];
    for (let i = 0; i < steps; i++) {
      const h = (i + 1) * rise;
      out.push(box(startX + i * run, startX + (i + 1) * run, -halfWidth, halfWidth, h));
    }
    const topX = startX + steps * run;
    out.push(box(topX, topX + 1.6, -halfWidth, halfWidth, steps * rise));   // palier
    if (down) {
      for (let i = 0; i < steps; i++) {
        const h = (steps - i - 1) * rise;
        out.push(box(topX + 1.6 + i * run, topX + 1.6 + (i + 1) * run, -halfWidth, halfWidth, h));
      }
    }
    return out;
  }

  function rubble(x0, x1, halfWidth, cell, maxH) {
    const out = [];
    let seed = 7;
    const rnd = function () {                       // suite déterministe
      /* `Math.imul` et non `*` : le produit dépasse 2^53 et un nombre
         JavaScript y perd des bits. La suite divergeait donc de celle du
         simulateur, qui calcule en entiers exacts — 103 blocs ici, 98 là,
         pour la même description de terrain. */
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let x = x0; x < x1; x += cell) {
      for (let y = -halfWidth; y < halfWidth; y += cell) {
        const h = Math.round(rnd() * 3) / 3 * maxH;
        if (h > 0.001) out.push(box(x, x + cell, y, y + cell, h));
      }
    }
    return out;
  }

  /**
   * Transition de quarter pipe : un quart de cercle de rayon R découpé en
   * tranches. Le profil h(u) = R - sqrt(R² - u²) part tangent au sol et
   * finit vertical, comme une vraie transition de skatepark. `dir` vaut +1
   * si le mur est du côté des x croissants.
   */
  function quarterPipe(base, R, halfWidth, dir, deck, slices) {
    const out = [];
    // Le nombre de tranches fixe la finesse de la courbe. 24 suffisent pour
    // un quarter de 450 mm ; une grande transition de 1,20 m en demande deux
    // fois plus, sinon chaque tranche fait une marche de 50 mm que la roue
    // aborde comme un trottoir.
    const n = slices || 24;
    for (let i = 0; i < n; i++) {
      const u0 = i / n * R, u1 = (i + 1) / n * R;
      const h = R - Math.sqrt(Math.max(0, R * R - u1 * u1));
      const a = dir > 0 ? base + u0 : base - u1;
      const b = dir > 0 ? base + u1 : base - u0;
      // la tranche prend la hauteur de son bord le plus haut : l'escalier
      // reste au-dessus de la courbe, jamais dedans
      out.push(box(a, b + 0.001, -halfWidth, halfWidth, h));
    }
    // plateforme derrière le coping : on y monte, on y repart
    const d = deck === undefined ? 0.9 : deck;
    if (d > 0) {
      out.push(dir > 0 ? box(base + R, base + R + d, -halfWidth, halfWidth, R)
                       : box(base - R - d, base - R, -halfWidth, halfWidth, R));
    }
    return out;
  }

  /** Plan incliné en tranches : un bank, ou le flanc d'un funbox. */
  function bank(x0, x1, y0, y1, h0, h1, slices) {
    const out = [];
    // Sur un grand tremplin, 14 tranches feraient des marches de 68 mm — à la
    // limite de ce qu'une roue de 75 mm franchit. On en met assez pour que la
    // pente reste une pente.
    const n = slices || 14;
    for (let i = 0; i < n; i++) {
      const a = x0 + (x1 - x0) * i / n, b = x0 + (x1 - x0) * (i + 1) / n;
      out.push(box(a, b + 0.001, y0, y1, h0 + (h1 - h0) * (i + 1) / n));
    }
    return out;
  }

  const PRESETS = [
    { id: "plat", name: "Sol plat", desc: "Référence, sans relief.", boxes: [] },

    { id: "escalier", name: "Escalier", maxStep: 0.13,
      desc: "8 marches de 130 mm × 300 mm, palier, puis descente. Un Go2 passe des marches de 160 mm.",
      boxes: stairs(1.2, 8, 0.13, 0.30, 1.1, true) },

    { id: "marches_hautes", name: "Marches hautes", maxStep: 0.18,
      desc: "5 marches de 180 mm : la limite du gabarit d'YLO-2, le B2 monte 200 à 250 mm.",
      boxes: stairs(1.4, 5, 0.18, 0.36, 1.0, true) },

    { id: "plateforme", name: "Plateforme", maxStep: 0.24,
      desc: "Marche unique de 240 mm à franchir, puis redescente.",
      boxes: [box(1.5, 4.0, -1.2, 1.2, 0.24)] },

    { id: "rampe", name: "Rampe 20°", maxStep: 0.05,
      desc: "Pente continue à 20°, palier, redescente. Le B2 annonce 45° au maximum.",
      boxes: (function () {
        const out = [];
        const n = 40, len = 2.2, rise = Math.tan(20 * Math.PI / 180) * len;
        for (let i = 0; i < n; i++) {
          const x0 = 1.2 + i * (len / n);
          out.push(box(x0, x0 + len / n + 0.001, -1.2, 1.2, (i + 1) / n * rise));
        }
        out.push(box(1.2 + len, 1.2 + len + 1.4, -1.2, 1.2, rise));
        for (let i = 0; i < n; i++) {
          const x0 = 1.2 + len + 1.4 + i * (len / n);
          out.push(box(x0, x0 + len / n + 0.001, -1.2, 1.2, (1 - (i + 1) / n) * rise));
        }
        return out;
      })() },

    { id: "gravats", name: "Gravats", maxStep: 0.09,
      desc: "Blocs irréguliers jusqu'à 90 mm : le pied se pose à des hauteurs différentes à chaque pas.",
      boxes: rubble(1.0, 5.0, 1.0, 0.28, 0.09) },

    // Mini-plaza dans l'esprit des skateparks en béton de Californie : un
    // funbox central bordé d'un ledge, un kicker à l'entrée, et deux quarter
    // pipes qui se font face comme les extrémités d'une mini-ramp. Les cotes
    // sont réduites au gabarit du robot — un funbox de skate fait 40 cm de
    // haut, celui-ci 180 mm, dans ce que passe une patte de 445 mm.
    { id: "skatepark", name: "Skatepark", maxStep: 0.18,
      desc: "Mini-plaza : kicker, funbox de 180 mm, ledge et deux quarter pipes de 450 mm. " +
            "Les transitions se montent en partie — le haut du quarter est vertical, hors gabarit.",
      boxes: (function () {
        const out = [];
        // Les modules sont largement espacés : il faut de l'élan avant chaque
        // obstacle et de quoi se replacer après, sinon on enchaîne sans jamais
        // rouler. Au moins 1,5 m de plat entre deux modules.
        // kicker d'entrée : un petit tremplin de 100 mm
        bank(1.40, 2.10, -0.75, 0.75, 0, 0.10).forEach(function (b) { out.push(b); });
        // funbox : bank de montée, plateau, bank de descente
        bank(3.60, 4.30, -0.95, 0.95, 0, 0.18).forEach(function (b) { out.push(b); });
        out.push(box(4.30, 5.30, -0.95, 0.95, 0.18));                    // plateau
        bank(5.30, 6.00, -0.95, 0.95, 0.18, 0).forEach(function (b) { out.push(b); });
        // ledge de grind le long du funbox, avec 750 mm de dégagement
        out.push(box(3.40, 6.20, 1.70, 2.10, 0.20));
        // quarter pipes face à face, aux deux bouts de la plaza
        quarterPipe(7.80, 0.45, 1.90, +1).forEach(function (b) { out.push(b); });
        quarterPipe(-2.60, 0.45, 1.90, -1).forEach(function (b) { out.push(b); });
        return out;
      })(),
      // Une boule à pousser, sur le plat entre le kicker et le funbox : le
      // seul module du parc qui bouge quand on le touche.
      ball: [0.60, -1.60] },

    /* Champ de tir : un couloir de 30 m bordé de merlons, une ligne de tir au
       départ et huit cibles escamotables réparties en profondeur et en
       largeur. Le sol est plat et roulant — ici on ne franchit rien, on se
       place et on tire. */
    { id: "standtir", name: "Champ de tir", maxStep: 0.12,
      desc: "Couloir de 30 m semé de gravats, d'une carcasse de voiture et " +
            "d'un mur percé de deux fenêtres. Douze cibles, dont trois en " +
            "hauteur, se relèvent quand on entre sur la ligne de tir ; " +
            "L1 tire, la visée est automatique, PARTAGE la fige, OPTIONS " +
            "déclare une cible amie.",
      boxes: (function () {
        const out = [];
        const add = function (list) { list.forEach(function (b) { out.push(b); }); };

        // merlons : deux longs bourrelets qui tiennent le couloir
        [-4.2, 4.2].forEach(function (y) {
          for (let i = 0; i < 16; i++) {
            const h = 0.30 + 0.10 * Math.sin(i * 1.7);
            out.push(box(-2 + i * 2.0, -2 + i * 2.0 + 1.95,
                         y - 0.9, y + 0.9, h));
          }
        });
        // butte de tir au fond : ce qui arrête les balles
        add(bank(30.0, 33.0, -4.5, 4.5, 0.0, 1.60, 24));
        // plate-forme de la ligne de tir, légèrement surélevée
        out.push(box(-1.60, 1.60, -1.80, 1.80, 0.06));

        /* Du terrain cassé, deux nappes. On ne traverse pas un stand de tir
           sur un parking : les gravats obligent à ralentir, et ralentir est
           justement ce qui permet de tirer juste. */
        add(rubble(4.20, 6.20, 1.60, 0.30, 0.10));
        add(rubble(15.60, 17.80, 2.20, 0.32, 0.12));

        /* Le mur percé, en travers du couloir : une porte au milieu, deux
           fenêtres à hauteur d'homme de part et d'autre.

           Les fenêtres ne se passent pas — leur allège fait 500 mm quand le
           robot en franchit 450 — mais elles se TIRENT à travers : 500 mm,
           c'est cinquante de plus que ce qu'une roue peut monter, et juste
           au-dessous de la ligne de bouche vue d'une trentaine de mètres.
           Une cible cadrée dans une fenêtre ne se prend donc que d'un
           endroit, et il faut le trouver. La porte, elle, se franchit :
           son linteau est à 800 mm, au-dessus de la caisse quelle que soit la
           hauteur de conduite. C'est le seul passage, il faut le viser. */
        (function () {
          const X0 = 9.60, X1 = 10.10, TOP = 2.20, W = 0.70;
          /* Le mur est bâti en PANNEAUX ÉTROITS de 70 cm, sur une trame
             régulière. C'est ce qui rend sa destruction locale : une grenade
             emporte les trois panneaux qu'elle atteint et ouvre une brèche de
             deux mètres, là où des pans de huit mètres faisaient tomber le
             mur entier d'un seul coup. Chaque panneau porte son numéro, et
             un panneau touché part avec son linteau — un mur ne s'ouvre pas
             en rond, il tombe entre deux montants. */
          const kind = function (y0, y1) {
            const c = (y0 + y1) / 2;
            if (c > -0.70 && c < 0.70) return "porte";
            if ((c > -2.80 && c < -1.40) || (c > 1.40 && c < 2.80)) return "fenetre";
            return "plein";
          };
          let n = 0;
          for (let y = -4.20; y < 4.19; y += W) {
            const y0 = y, y1 = y + W, k = kind(y0, y1), id = n++;
            const tag = function (b) { b.part = "mur"; b.panel = id; return b; };
            if (k === "plein") out.push(tag(box(X0, X1, y0, y1, TOP)));
            else if (k === "porte") out.push(tag(lintel(X0, X1, y0, y1, 0.80, TOP)));
            else {
              out.push(tag(box(X0, X1, y0, y1, 0.50)));            // allège
              out.push(tag(lintel(X0, X1, y0, y1, 1.60, TOP)));    // linteau
            }
          }
        })();

        /* Une carcasse de voiture en travers : un obstacle qu'on contourne,
           et un toit sur lequel se tient une cible. Elle porte ses propres
           matières — une caisse rouge et un vitrage sombre —, sans quoi elle
           serait un bloc de béton de plus. */
        (function () {
          const cx = 20.60, cy = -1.30;
          /* PLEINE, et pas seulement dessinée. La caisse était décrite comme un
             volume en l'air — la description d'un linteau — et le robot lui
             passait dessous comme sous un pont. Elle est maintenant pleine
             depuis le sol (`z0: 0`) et seulement DESSINÉE à seize centimètres
             (`base`) : le contact et l'œil ne racontent plus deux histoires. */
          out.push({ x0: cx - 2.10, x1: cx + 2.10, y0: cy - 0.86, y1: cy + 0.86,
                     h: 0.78, z0: 0, base: 0.16, mat: "carBody", part: "auto" });
          out.push({ x0: cx - 0.75, x1: cx + 0.72, y0: cy - 0.78, y1: cy + 0.78,
                     h: 1.32, z0: 0, base: 0.78, mat: "carGlass", part: "auto" });
          [-1.42, 1.38].forEach(function (dx) {
            [-0.86, 0.72].forEach(function (dy) {
              out.push({ x0: cx + dx - 0.16, x1: cx + dx + 0.16,
                         y0: cy + dy, y1: cy + dy + 0.14, h: 0.34,
                         z0: 0, mat: "wheel", part: "auto" });
            });
          });
        })();

        /* Une passerelle : c'est elle qui porte les cibles hautes. Sans un
           appui visible sous elles, une cible en l'air a l'air d'une erreur
           d'altitude plutôt que d'un tireur en surplomb. */
        out.push(box(24.60, 27.40, 2.30, 3.60, 1.85));
        add(bank(23.10, 24.60, 2.30, 3.60, 0, 1.85, 14));
        out.push(box(12.80, 14.20, -3.90, -2.60, 1.20));
        return out;
      })(),
      start: [-3.2, 0, 0],
      zones: [{ kind: "start", x0: -1.60, x1: 1.60, y0: -1.80, y1: 1.80, z: 0.06 }],
      /* Les cibles : abscisse, écart latéral, et hauteur du pied. Elles
         alternent de part et d'autre de l'axe et s'éloignent — on ne les
         prend pas toutes du même endroit, il faut avancer. Trois sont en
         surplomb : sur la voiture, sur le muret, sur la passerelle. Une
         tourelle qui ne pointerait qu'à l'horizontale ne les aurait jamais. */
      range: {
        zone: [-1.60, 1.60, -1.80, 1.80],
        /* Quatrième valeur : la course d'un chariot. Une cible qui coulisse
           en travers du couloir ne se prend pas comme une cible plantée — il
           faut la devancer, et la tourelle qui la suit ne rattrape jamais
           tout à fait. Ce sont elles qui obligent à s'arrêter vraiment. */
        targets: [[6.0, -2.4], [8.5, 1.9, 0, [-1.2, 2.8, 1.25]],
                  [11.5, -1.1], [13.5, -3.25, 1.20],
                  [14.5, 2.6], [18.0, -2.8, 0, [-3.2, 1.4, 1.7]],
                  [20.6, -1.30, 1.32],
                  [21.0, 1.0], [24.5, -2.0, 0, [-2.6, 2.2, 2.1]],
                  [26.0, 2.95, 1.85], [28.0, 2.2], [28.6, -3.1]]
      } },

    /* Arène de défense : un terrain OUVERT, et c'est tout l'enjeu.
       Le champ de tir est un couloir — on sait d'où ça vient. Ici les
       ennemis arrivent de partout, et le relief ne sert qu'à donner des
       abris et des angles morts : quatre blocs bas au centre, quatre
       merlons diagonaux, un anneau de gravats. Rien qui ferme un secteur,
       tout qui gêne un peu. */
    { id: "defense", name: "Défense de zone", maxStep: 0.14,
      desc: "Arène ouverte de 44 m. Placez la zone à protéger d'un clic — " +
            "sur la scène ou sur la carte —, puis tenez-la : les ennemis " +
            "arrivent de tous les côtés et tirent. L1 tire, R1 désigne, " +
            "PS lance le mode autonome.",
      boxes: (function () {
        const out = [];
        const add = function (list) { list.forEach(function (b) { out.push(b); }); };
        // quatre blocs bas au centre : des abris, pas des murs
        [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]].forEach(function (c) {
          out.push(box(c[0] - 1.1, c[0] + 1.1, c[1] - 1.1, c[1] + 1.1, 0.55));
        });
        // merlons diagonaux, plus loin : de quoi couper les lignes de tir
        [[9, 9, 0.8], [-9, 9, -0.8], [9, -9, -0.8], [-9, -9, 0.8]].forEach(function (m) {
          for (let i = -3; i <= 3; i++) {
            const x = m[0] + i * 0.9, y = m[1] + i * 0.9 * m[2];
            out.push(box(x - 0.55, x + 0.55, y - 0.55, y + 0.55, 0.75));
          }
        });
        // couronne de gravats : on ne fonce pas en ligne droite vers le bord
        add(rubble(-15.5, -13.0, 15.0, 0.5, 0.11));
        add(rubble(13.0, 15.5, 15.0, 0.5, 0.11));
        // et le talus de pourtour, qui ferme l'arène sans la boucher
        [-21, 21].forEach(function (y) {
          for (let i = 0; i < 22; i++) {
            const x = -22 + i * 2;
            out.push(box(x, x + 1.9, y - 1.2, y + 1.2, 0.9 + 0.2 * Math.sin(i * 1.3)));
          }
        });
        [-21, 21].forEach(function (x) {
          for (let i = 0; i < 22; i++) {
            const y = -22 + i * 2;
            out.push(box(x - 1.2, x + 1.2, y, y + 1.9, 0.9 + 0.2 * Math.sin(i * 1.7)));
          }
        });
        return out;
      })(),
      start: [0, -7.5, 0],
      /* Pas de ligne de tir ni de cibles écrites : c'est le mode défense qui
         fait apparaître les ennemis, et la zone se place au clic. */
      range: { defense: true, zone: null, targets: [] } },

    /* Terrain de RECONNAISSANCE. Il est bâti autour d'une seule idée : le
       robot ne peut pas voir ce qu'il doit détruire. Vingt-deux mètres de
       portée de détection, cinquante mètres de terrain, une crête au
       milieu et un plateau derrière — depuis la ligne de départ on ne voit
       littéralement rien de ce qu'il y a à faire.

       Le drone, lui, monte à trois mètres et le masque disparaît. C'est
       tout le mode : on repère d'en haut, puis on envoie le robot, qui
       devra franchir la crête par la rampe et grimper au plateau. */
    { id: "recon", name: "Reconnaissance drone", maxStep: 0.16,
      desc: "Vallée de 50 m barrée par une crête : depuis le départ, les " +
            "cibles du fond sont invisibles. ↑ lance le drone, ↓ le met en " +
            "reconnaissance, ← lance l'assaut du robot, → assigne au drone " +
            "la cible que tient la tourelle.",
      boxes: (function () {
        const out = [];
        const add = function (list) { list.forEach(function (b) { out.push(b); }); };
        // plateau de départ
        out.push(box(-2.4, 1.6, -2.2, 2.2, 0.06));
        // flancs de la vallée : ils ferment les côtés sans fermer le fond
        [-8.5, 8.5].forEach(function (y) {
          for (let i = 0; i < 26; i++) {
            const h = 1.5 + 0.5 * Math.sin(i * 0.9);
            out.push(box(-3 + i * 2.1, -3 + i * 2.1 + 2.05, y - 1.4, y + 1.4, h));
          }
        });
        /* La crête. Un mur de 2,6 m en travers, percé d'un seul passage
           décalé sur la gauche : c'est ce qui rend la reconnaissance utile
           — on ne voit pas au travers, et la route n'est pas droite. */
        for (let y = -7.2; y < 7.19; y += 0.8) {
          const c = y + 0.4;
          if (c > -5.4 && c < -3.4) continue;         // le passage
          out.push({ x0: 14.0, x1: 14.7, y0: y, y1: y + 0.8, h: 2.60, z0: 0,
                     part: "crete", panel: Math.round((y + 8) * 10) });
        }
        // la rampe qui mène au passage, et les gravats qui le gardent
        add(bank(11.0, 14.0, -5.6, -3.2, 0, 0.30, 10));
        add(rubble(15.2, 17.4, 2.4, 0.34, 0.13));
        // deux abris derrière la crête : des angles morts, pas des murs
        out.push(box(19.0, 21.4, -3.2, -1.0, 1.10));
        out.push(box(24.0, 26.6, 1.4, 4.0, 1.30));
        /* Le plateau du fond, à 1,9 m : deux cibles y sont postées, et on
           n'y monte que par sa rampe. C'est la « montée » du programme —
           le robot doit vraiment aller la chercher. */
        out.push(box(33.0, 40.0, -6.0, 1.0, 1.90));
        add(bank(29.6, 33.0, -5.0, -1.4, 0, 1.90, 18));
        // une passerelle latérale, plus haut encore
        out.push(box(30.0, 33.4, 4.2, 6.4, 2.40));
        add(bank(27.2, 30.0, 4.2, 6.4, 0, 2.40, 16));
        // butte de fond
        add(bank(44.0, 48.0, -8.0, 8.0, 0, 2.20, 26));
        return out;
      })(),
      start: [-1.0, 0, 0],
      zones: [{ kind: "start", x0: -2.40, x1: 1.60, y0: -2.20, y1: 2.20, z: 0.06 }],
      /* Douze cibles, et l'essentiel est DERRIÈRE la crête : depuis la
         ligne de départ, le robot n'en repère que trois. Les neuf autres
         n'existent qu'une fois que le drone est passé. */
      range: {
        recon: true,
        zone: [-2.40, 1.60, -2.20, 2.20],
        targets: [[7.5, 2.2], [10.5, -3.4], [12.5, 4.6],
                  [17.5, -1.8], [19.5, 3.4], [21.2, -2.1, 1.10],
                  [24.0, -4.6], [26.0, 2.7, 1.30],
                  [31.5, 5.3, 2.40], [35.0, -2.0, 1.90], [38.5, -4.4, 1.90],
                  [42.0, 1.6]]
      } },

    // Mini-ramp : deux grandes transitions qui se font face, un flat entre
    // les deux. C'est l'objet de skate le plus simple et le plus riche — on
    // n'y franchit rien, on y roule : la pente rend l'élan qu'on lui a donné,
    // et c'est la gravité qui fait le va-et-vient. Une transition de 1,20 m
    // ne se « passe » pas comme les rampes des autres terrains : elle se
    // remonte tant qu'on a de la vitesse, et on redescend en marche arrière.
    { id: "bigramp", name: "Big ramp", maxStep: 0.30,
      desc: "Mini-ramp de 1,20 m de transition, flat de 6,4 m entre les deux courbes. " +
            "À rouler comme du skate : élan, pompe, retour par gravité, saut à la lèvre.",
      boxes: (function () {
        const out = [];
        const R = 1.20, W = 2.40;
        quarterPipe(3.20, R, W, +1, 1.30, 48).forEach(function (b) { out.push(b); });
        quarterPipe(-3.20, R, W, -1, 1.30, 48).forEach(function (b) { out.push(b); });
        return out;
      })() },

    /* Mega ramp, dans l'esprit des grandes rampes de skate : on part de haut,
       on convertit la hauteur en vitesse, on saute un gap, on se reçoit sur
       une pente qui rend la chute supportable, et on finit dans une grande
       transition. Rien ici ne se « franchit » — tout se roule, et c'est la
       gravité qui fournit le travail.

       Les cotes sont à l'échelle du robot mais volontairement grandes : 2,60 m
       de roll-in pour un robot de 0,44 m de patte, c'est six fois sa jambe.
       La descente rend environ 6,6 m/s en bas. */
    { id: "megaramp", name: "Mega ramp", maxStep: 0.40,
      start: [-16.0, 0, 0],
      desc: "Roll-in droit de 2,60 m, tremplin de 700 mm, gap de 1,00 m, pente de réception, " +
            "puis une transition de 2,60 m. Le robot démarre sur la plateforme de départ.",
      boxes: (function () {
        const out = [];
        const W = 3.00;
        /* Le roll-in est une pente DROITE de 18°, pas un quarter pipe. C'est
           la forme des vraies grandes rampes, et ce n'est pas un détail : sur
           une transition, le haut est vertical, le robot quitte le coping en
           chute libre et perd dans l'impact la moitié de la hauteur gagnée.
           Sur une pente droite, les roues ne quittent jamais le sol et les
           2,60 m se convertissent presque entièrement en vitesse — 6,6 m/s
           en bas. */
        out.push(box(-17.00, -15.00, -W, W, 2.60));              // plateforme
        bank(-15.00, -7.00, -W, W, 2.60, 0, 80).forEach(function (b) { out.push(b); });
        // tremplin : 700 mm sur 2,20 m, soit 18°
        bank(0.00, 2.20, -1.30, 1.30, 0, 0.70, 40).forEach(function (b) { out.push(b); });
        /* Le gap : 1,00 m de vide, de la lèvre au haut de la réception. Puis
           une pente descendante, qui absorbe la chute au lieu de la prendre à
           plat — c'est ce qui fait la différence, sur une grande rampe, entre
           se recevoir et s'écraser. Elle est longue et douce à dessein : on
           s'y reçoit du saut le plus court comme du plus long. Sa face, elle,
           fait 400 mm : rater le gap, ça reste rater le gap. */
        bank(3.20, 6.60, -1.70, 1.70, 0.40, 0, 40).forEach(function (b) { out.push(b); });
        // et pour finir, une grande transition, qu'on remonte de ce qu'on a
        quarterPipe(13.00, 2.60, W, +1, 2.20, 72).forEach(function (b) { out.push(b); });
        return out;
      })() },

    /* Méga-parcours : tout le catalogue mis bout à bout, dans l'ordre où on
       aurait envie de l'enchaîner. On part de haut, on prend de la vitesse, on
       traverse du terrain cassé, on grimpe, on PASSE PAR UNE FENÊTRE, on
       franchit, on saute, et on finit dans une transition.

       La fenêtre est le seul obstacle du jeu qui ne soit pas un champ de
       hauteurs : plein en haut, vide au milieu, un appui de 240 mm en bas. Il
       faut donc à la fois lever la patte pour passer l'appui et BAISSER LA
       CAISSE pour passer sous le linteau. Sur roues, l'essieu porte la caisse
       un rayon plus haut : il faut y descendre à 200 mm là où 250 suffisent
       sur pattes. */
    { id: "megascene", name: "Méga-parcours", maxStep: 0.24,
      start: [-16.0, 0, 0],
      zones: [
        { x0: -17.0, x1: -15.0, y0: -1.4, y1: 1.4, z: 2.60, kind: "start" },
        { x0: 27.2 - 1.5, x1: 27.2, y0: -1.8, y1: 1.8, z: 0, kind: "finish" }
      ],
      desc: "Tout le catalogue à la suite : roll-in de 2,60 m, gravats, poutres, escalier, " +
            "fenêtre à traverser, plateforme, funbox et ledge, marches hautes, tremplin et gap, " +
            "quarter pipe. La fenêtre demande de baisser la caisse : 200 mm sur roues, 250 sur pattes.",
      boxes: (function () {
        const out = [];
        const add = function (list) { list.forEach(function (b) { out.push(b); }); };

        // 1. départ en hauteur et sa pente : de quoi lancer tout le reste
        out.push(box(-17.00, -15.00, -3.0, 3.0, 2.60));
        add(bank(-15.00, -7.00, -3.0, 3.0, 2.60, 0, 60));

        // 2. terrain cassé, puis des traverses à enjamber
        add(rubble(-5.60, -3.60, 1.0, 0.28, 0.09));
        for (let i = 0; i < 4; i++) {
          out.push(box(-2.80 + i * 0.70, -2.80 + i * 0.70 + 0.25, -1.2, 1.2, 0.14));
        }

        // 3. escalier : cinq marches, palier, redescente
        add(stairs(0.60, 5, 0.13, 0.30, 1.2, true));

        // 4. la fenêtre : deux jambages, un appui, un linteau
        out.push(box(6.40, 6.80, -3.5, -0.45, 2.00));
        out.push(box(6.40, 6.80, 0.45, 3.5, 2.00));
        out.push(box(6.40, 6.80, -0.45, 0.45, 0.24));          // l'appui
        out.push(lintel(6.40, 6.80, -0.45, 0.45, 0.62, 2.00)); // le linteau

        // 5. marche unique franche
        out.push(box(7.40, 9.40, -1.2, 1.2, 0.24));

        // 6. funbox et son ledge de grind
        add(bank(10.60, 11.30, -0.95, 0.95, 0, 0.18));
        out.push(box(11.30, 12.30, -0.95, 0.95, 0.18));
        add(bank(12.30, 13.00, -0.95, 0.95, 0.18, 0));
        out.push(box(10.40, 13.20, 1.70, 2.10, 0.20));

        // 7. marches hautes : la limite du gabarit
        add(stairs(14.80, 3, 0.18, 0.36, 1.0, true));

        // 8. tremplin, gap, réception
        add(bank(19.40, 21.60, -1.30, 1.30, 0, 0.70, 30));
        add(bank(22.60, 26.00, -1.70, 1.70, 0.40, 0, 30));

        // 9. et pour finir, une transition
        add(quarterPipe(27.20, 1.20, 2.00, +1, 1.20, 48));
        return out;
      })() },

    { id: "poutres", name: "Poutres", maxStep: 0.14,
      desc: "Traverses de 140 mm espacées de 700 mm, à enjamber.",
      boxes: (function () {
        const out = [];
        for (let i = 0; i < 5; i++) out.push(box(1.4 + i * 0.7, 1.4 + i * 0.7 + 0.25, -1.2, 1.2, 0.14));
        return out;
      })() }
  ];

  const group = new T.Group();
  let current = PRESETS[0];

  /** Hauteur du sol sous un point, en mètres. */
  function heightAt(x, y) {
    let h = 0;
    const boxes = current.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      // un linteau n'est pas un sol : on ne pose rien dessous
      if (!b.z0 && x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && b.h > h) h = b.h;
    }
    return h;
  }

  /**
   * Plafond au-dessus d'un point : le dessous du linteau le plus bas qui
   * surplombe encore `z`. `Infinity` quand le ciel est libre.
   */
  function ceilingAt(x, y, z) {
    let lo = Infinity;
    const boxes = current.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.z0 || b.z0 < z) continue;
      if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && b.z0 < lo) lo = b.z0;
    }
    return lo;
  }

  /**
   * Y a-t-il quelque chose ENTRE ces deux points ?
   *
   * La méthode des tranches : une boîte alignée sur les axes est
   * l'intersection de trois bandes, une par axe. Le segment y entre au plus
   * tard des trois entrées et en sort au plus tôt des trois sorties ; s'il
   * entre après être sorti, il passe à côté. Trois divisions par boîte, pas
   * de racine carrée, pas de maillage — et c'est exactement la description
   * qui sert déjà au contact, donc rien ne peut diverger entre ce qu'on voit
   * et ce qui arrête une balle.
   *
   * `z0` compte ici, contrairement à `heightAt` : un linteau ne porte pas
   * une roue mais il arrête un regard, et c'est bien le même volume.
   */
  function hitDist(ax, ay, az, bx, by, bz, skipNear) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const near = skipNear || 0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return -1;
    const t0min = near / len;                 // on ignore ce qu'on a sur le nez
    let first = -1;
    const boxes = current.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      let lo = t0min, hi = 1;
      // X
      if (Math.abs(dx) < 1e-9) { if (ax < b.x0 || ax > b.x1) continue; }
      else {
        let t1 = (b.x0 - ax) / dx, t2 = (b.x1 - ax) / dx;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
        if (lo > hi) continue;
      }
      // Y
      if (Math.abs(dy) < 1e-9) { if (ay < b.y0 || ay > b.y1) continue; }
      else {
        let t1 = (b.y0 - ay) / dy, t2 = (b.y1 - ay) / dy;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
        if (lo > hi) continue;
      }
      // Z — le plancher de la boîte est z0, son plafond h
      const z0 = b.z0 || 0;
      if (Math.abs(dz) < 1e-9) { if (az < z0 || az > b.h) continue; }
      else {
        let t1 = (z0 - az) / dz, t2 = (b.h - az) / dz;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > lo) lo = t1; if (t2 < hi) hi = t2;
        if (lo > hi) continue;
      }
      /* On garde la PREMIÈRE rencontre et non la première trouvée : c'est
         elle qui dit où s'arrête le traceur. Un mur derrière un autre mur
         ne change rien à l'endroit où la balle se plante. */
      if (first < 0 || lo < first) first = lo;
    }
    return first < 0 ? -1 : first * len;
  }

  /** Y a-t-il quelque chose entre ces deux points ? */
  function blocked(ax, ay, az, bx, by, bz, skipNear) {
    return hitDist(ax, ay, az, bx, by, bz, skipNear) >= 0;
  }

  /** Hauteur maximale rencontrée le long d'un segment (dégagement du vol). */
  function maxHeightAlong(x0, y0, x1, y1, samples) {
    const n = samples || 6;
    let h = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      h = Math.max(h, heightAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
    }
    return h;
  }

  /**
   * Hauteur de sol EFFECTIVE sous une roue de rayon R.
   *
   * `heightAt` ne regarde qu'un point : une roue de 75 mm arrivant sur la
   * tranche d'une rampe la traversait donc jusqu'à ce que son centre passe
   * de l'autre côté. Un pneu touche pourtant dès que sa jante rencontre le
   * relief. Pour un sol h(u) et un décalage u sous l'essieu, le contact
   * impose z ≥ h(u) + √(R² − u²) : on prend le maximum sur l'empreinte, et
   * on redescend d'un rayon pour rendre une hauteur de sol comparable.
   *
   * Sur sol plat le résultat est exactement `heightAt` — rien ne change.
   */
  function support(x, y, cx, cy, R) {
    const r = R === undefined ? 0.075 : R;
    const here = heightAt(x, y);
    let best = here;
    const n = 4;
    for (let i = 1; i <= n; i++) {
      const u = r * i / n;
      const lift = Math.sqrt(Math.max(0, r * r - u * u)) - r;
      const dirs = [[cx * u, cy * u], [-cx * u, -cy * u], [-cy * u, cx * u], [cy * u, -cx * u]];
      for (let d = 0; d < 4; d++) {
        const h = heightAt(x + dirs[d][0], y + dirs[d][1]);
        // Un relief plus haut que le RAYON n'est pas un contact de roulement,
        // c'est un mur : le pneu bute contre sa face, il ne monte pas dessus.
        // Le compter ici téléporterait la roue au sommet d'une marche de
        // 130 mm dès qu'elle en approche à 75 mm. Ces obstacles-là sont
        // l'affaire du lever de patte, pas du contact de roue.
        if (h - here > r) continue;
        if (h + lift > best) best = h + lift;
      }
    }
    return best;
  }

  /**
   * Le plus gros SAUT local du relief devant, et le dénivelé total.
   *
   * Une roue ne se fait pas porter par sa patte pour monter une PENTE — elle
   * y roule, c'est son métier. Elle en a besoin pour une MARCHE. Les deux se
   * distinguent non pas par leur hauteur mais par la façon dont elle est
   * répartie : sur une marche, tout le dénivelé tient dans un pas ; sur une
   * pente, il est étalé. On rend les deux, et l'appelant compare.
   */
  function jumpAhead(x, y, cx, cy, dist) {
    const here = heightAt(x, y);
    let prev = here, jump = 0;
    const n = Math.max(2, Math.round(dist / 0.05));
    for (let i = 1; i <= n; i++) {
      const d = dist * i / n;
      const h = heightAt(x + cx * d, y + cy * d);
      if (Math.abs(h - prev) > Math.abs(jump)) jump = h - prev;
      prev = h;
    }
    return [jump, prev - here];
  }

  /** Marche la plus haute devant le robot, pour prévenir en mode roues. */
  function stepAhead(x, y, yaw, distance) {
    const here = heightAt(x, y);
    let worst = 0;
    const n = 10;
    for (let i = 1; i <= n; i++) {
      const d = (distance || 0.6) * i / n;
      const h = heightAt(x + Math.cos(yaw) * d, y + Math.sin(yaw) * d);
      worst = Math.max(worst, Math.abs(h - here));
    }
    return worst;
  }

  function build(scene) {
    scene.add(group);
    return group;
  }

  /* Marquages au sol : départ et arrivée. Ce sont des DÉCORS — ils ne
     comptent ni dans la hauteur du sol ni dans les collisions —, juste une
     plaque lumineuse qu'on reconnaît de loin. */
  let zoneMats = null;
  function zoneMat(kind) {
    if (!zoneMats) {
      zoneMats = {
        start: new T.MeshStandardMaterial({ color: 0x10281f, emissive: 0x2fbe86,
          emissiveIntensity: 0.5, roughness: 0.85, metalness: 0 }),
        finish: new T.MeshStandardMaterial({ color: 0x33180a, emissive: 0xff6a2b,
          emissiveIntensity: 0.5, roughness: 0.85, metalness: 0 })
      };
    }
    return zoneMats[kind] || zoneMats.start;
  }

  /** Zone marquée sous un point : « start », « finish », ou rien. */
  function zoneAt(x, y) {
    const zs = current.zones;
    if (!zs) return null;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      if (x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1) return z.kind;
    }
    return null;
  }

  /**
   * Encombrement du terrain courant : ce qu'il faut couvrir pour qu'il n'y
   * ait pas de vide autour. `radius` est la distance de l'origine au coin le
   * plus lointain — c'est ce qui règle la portée du brouillard et la taille
   * du sol.
   */
  function extent() {
    const bs = current.boxes || [];
    if (!bs.length) return { x0: 0, x1: 0, y0: 0, y1: 0, top: 0, radius: 0 };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, top = 0;
    bs.forEach(function (b) {
      if (b.x0 < x0) x0 = b.x0; if (b.x1 > x1) x1 = b.x1;
      if (b.y0 < y0) y0 = b.y0; if (b.y1 > y1) y1 = b.y1;
      if (b.h > top) top = b.h;
    });
    const radius = Math.max(
      Math.hypot(x0, y0), Math.hypot(x0, y1),
      Math.hypot(x1, y0), Math.hypot(x1, y1));
    return { x0: x0, x1: x1, y0: y0, y1: y1, top: top, radius: radius };
  }

  let onChange = null;

  /**
   * Reconstruire les volumes affichés.
   *
   * `silent` saute le crochet de changement. C'est ce qu'il faut quand le
   * terrain est seulement ABÎMÉ : un panneau de mur qui tombe ne change ni
   * l'étendue de la scène, ni le brouillard, ni la taille du sol — et le
   * crochet, lui, remet le stand de tir en place, c'est-à-dire remet la série
   * à zéro. Une grenade repartait donc chrono, munitions et cibles à neuf.
   */
  function rebuild(silent) {
    while (group.children.length) {
      const m = group.children.pop();
      if (m.geometry) m.geometry.dispose();
      group.remove(m);
    }
    const mat = Y.Mat.get("obstacle");
    const edge = Y.Mat.get("obstacleEdge");
    current.boxes.forEach(function (b) {
      const w = b.x1 - b.x0, d = b.y1 - b.y0;
      /* `base` décolle le DESSIN du volume sans décoller le volume : la caisse
         d'une voiture se voit à seize centimètres du sol, mais elle est pleine
         jusqu'en bas — sinon le robot lui passe dessous. Un linteau, lui,
         décolle vraiment : c'est `z0` qui le dit. */
      const z0 = b.base !== undefined ? b.base : (b.z0 || 0);
      const th = b.h - z0;
      if (th <= 0) return;
      /* Un bloc peut porter sa propre matière : une carcasse de voiture n'est
         pas du béton, et la découper en décor à part reviendrait à décrire
         deux fois la même chose — une pour l'œil, une pour le contact. */
      const mesh = new T.Mesh(new T.BoxGeometry(w, d, th),
        b.mat ? Y.Mat.get(b.mat) : mat);
      mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, z0 + th / 2);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
      if (z0 || b.mat) return;              // un linteau n'a pas de nez de marche
      // Nez de marche : une arête claire, comme la bande antidérapante d'un
      // escalier. Seulement sur une vraie marche — les rampes et les
      // transitions sont découpées en tranches fines, et les strier toutes
      // les faisait ressembler à de la tôle ondulée au lieu de béton lisse.
      if (w >= 0.10 && b.h > 0.02) {
        const nose = new T.Mesh(new T.BoxGeometry(0.03, d, 0.008), edge);
        nose.position.set(b.x0 + 0.015, (b.y0 + b.y1) / 2, b.h + 0.004);
        nose.receiveShadow = true;
        group.add(nose);
      }
    });
    (current.zones || []).forEach(function (z) {
      const w = z.x1 - z.x0, d = z.y1 - z.y0;
      const plate = new T.Mesh(new T.BoxGeometry(w, d, 0.012), zoneMat(z.kind));
      plate.position.set((z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2, z.z + 0.008);
      plate.receiveShadow = true;
      group.add(plate);
    });
    if (onChange && !silent) onChange(current, extent());
  }

  /* --- terrain abîmé ---------------------------------------------------
     Une grenade change le terrain, pas seulement son apparence : un mur
     éventré ouvre un passage, une voiture soufflée cesse d'être un abri. On
     garde donc une copie INTACTE de la description au moment où le terrain
     est choisi, et `restore()` la remet — sinon les dégâts d'une partie se
     retrouveraient dans la suivante, les presets étant partagés. */
  let pristine = null;

  function mutate(boxes) {
    current.boxes = boxes;
    rebuild(true);
  }

  function restore() {
    if (!pristine) return false;
    current.boxes = pristine.slice();
    rebuild(true);
    return true;
  }

  Y.Terrain = {
    presets: PRESETS,
    group: group,
    build: build,
    heightAt: heightAt,
    ceilingAt: ceilingAt,
    blocked: blocked,
    hitDist: hitDist,
    mutate: mutate,
    restore: restore,
    zoneAt: zoneAt,
    support: support,
    jumpAhead: jumpAhead,
    maxHeightAlong: maxHeightAlong,
    stepAhead: stepAhead,
    get current() { return current; },
    /**
     * Où poser le robot sur ce terrain. Sur la plupart, l'origine convient.
     * Sur la mega ramp, non : le départ est en haut du roll-in, et une
     * transition de 2,60 m ne se remonte pas.
     */
    start: function () { return current.start || [0, 0, 0]; },
    set: function (id) {
      const found = PRESETS.find(function (p) { return p.id === id; });
      if (!found) return false;
      current = found;
      /* Les presets sont des objets PARTAGÉS : une grenade qui abîme le
         terrain abîme la description elle-même, et le mur resterait éventré
         au retour. On garde donc l'original à la première visite, et chaque
         choix de terrain repart de lui. */
      if (!found.boxes0) found.boxes0 = found.boxes.slice();
      found.boxes = found.boxes0.slice();
      pristine = found.boxes0;
      rebuild();
      return true;
    },
    refresh: rebuild,
    extent: extent,
    /** Prévenir la scène : le décor autour doit suivre la taille du terrain. */
    watch: function (fn) { onChange = fn; rebuild(); }
  };
})(window.YLO);
