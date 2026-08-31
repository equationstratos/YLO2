/* =====================================================================
   YLO-2 — champ de tir

   Un fusil d'assaut monté sur le pont, une tourelle qui vise toute seule,
   et huit cibles qui se relèvent quand le robot se présente sur la ligne
   de tir. On roule, on se place, on tire — et le chronomètre s'arrête
   quand la dernière cible tombe.

   Le tir est un LANCER DE RAYON, pas un projectile : à trente mètres et
   à la vitesse d'une balle, un projectile simulé arriverait dans la même
   image que son départ, et il coûterait un objet de plus à suivre. Ce
   qu'on voit — le traceur — est le dessin du rayon, pas l'inverse.

   La visée est automatique parce que le robot n'a pas de main : c'est la
   tourelle qui cherche la cible la plus proche encore debout, et elle met
   le temps qu'il faut à s'y amener. Tirer avant qu'elle soit alignée,
   c'est manquer — d'où l'intérêt de s'arrêter pour tirer.
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;
  const K = Y.K;

  /* Portée utile. Volontairement courte devant un couloir de trente mètres :
     de la ligne de tir on n'atteint que les deux ou trois premières cibles,
     et il faut AVANCER pour les suivantes. Une portée qui couvre tout le
     stand se vide depuis la ligne sans bouger, et il n'y a plus de parcours. */
  const REACH = 13;
  const TARGET_H = 0.72;             // hauteur de la silhouette
  const TARGET_W = 0.34;

  /* --- débattement de la tourelle ---
     Un affût qui ne balaie que l'avant oblige le robot à se retourner pour
     une cible qui le déborde, et une cible qui le déborde est justement
     celle qu'il faut prendre en premier. Le pointage a donc son propre
     débattement, large en site comme en gisement : ±150° de PAN — tout sauf
     la crosse —, et de −18° à +58° de TILT, de quoi aller chercher une
     silhouette sur une passerelle sans avancer. */
  const PAN_MAX = 150 * Math.PI / 180;
  const TILT_MIN = -18 * Math.PI / 180;
  const TILT_MAX = 58 * Math.PI / 180;
  const SLEW = 3.4;                  // vitesse de rotation de la tourelle, rad/s
  const TOL = 0.045;                 // écart d'alignement toléré au coup

  /* --- stabilisateur ---
     Un affût stabilisé n'annule pas le mouvement de la caisse, il le
     RATTRAPE : une constante de temps, et une butée mécanique au-delà de
     laquelle la plateforme est au bout de sa course. Sans butée, l'arme
     resterait horizontale même le robot sur le flanc, ce qu'aucun cardan ne
     fait. */
  const GIMBAL_TAU = 0.075;          // s — le temps que met la plateforme
  const GIMBAL_MAX = 26 * Math.PI / 180;

  /* --- les armes ---
     Deux, et deux logiques. Le fusil est un LANCER DE RAYON : à trente mètres
     et à la vitesse d'une balle, un projectile simulé arriverait dans l'image
     de son départ. Le lance-grenades est un vrai PROJECTILE : une grenade de
     40 mm part à vingt-cinq mètres par seconde, on la voit monter et
     retomber, et c'est cette parabole qui fait tout son intérêt — elle passe
     par-dessus ce que la balle ne traverse pas. */
  const WEAPONS = [
    { id: "fusil", name: "Fusil d'assaut", short: "FUSIL",
      burst: 3, rate: 0.085, rest: 0.30, mag: 30, reload: 1.7,
      spread0: 0.70, spreadV: 1.30, recoil: 0.55, reach: REACH },
    { id: "lg", name: "Lance-grenades 40 mm", short: "LG 40",
      burst: 1, rate: 0.10, rest: 0.85, mag: 6, reload: 2.6,
      spread0: 0.55, spreadV: 0.90, recoil: 0.0, reach: 26,
      muzzleV: 25.0, blast: 3.4 }
  ];
  const G = 9.81;

  /* --- modes de tir ---
     Le même fusil, trois façons de s'en servir. L'automatique arrose : on
     tient la détente et ça part, au prix du chargeur et de la précision. La
     rafale de trois est le compromis, c'est elle qui groupe le mieux à
     l'arrêt. Le coup par coup ne part qu'une fois par appui — c'est le seul
     mode où tenir la détente ne sert à rien, et c'est ce qui le rend précis :
     on reprend sa visée entre deux coups.

     Le lance-grenades ne connaît pas ces modes : une grenade part seule, et
     un lance-grenades automatique de six coups se vide en une demi-seconde. */
  const MODES = [
    { id: "auto",  name: "Tir automatique", short: "AUTO", n: 5, rest: 0.05 },
    { id: "trois", name: "Rafale de 3",     short: "3 CPS", n: 3, rest: 0.30 },
    { id: "coup",  name: "Coup par coup",   short: "1 CP",  n: 1, rest: 0.18,
      once: true }
  ];
  /* Le lidar tourne : ce que le robot REPÈRE ne dépend pas de l'endroit où
     pointe l'arme, seulement de ce qu'il a devant lui à découvert. La portée
     de détection est donc plus longue que la portée utile de l'arme — on voit
     plus loin qu'on ne tire, c'est le principe même d'une reconnaissance. */
  const DETECT = 22;
  const MUZZLE_SKIP = 0.35;          // on ignore le robot lui-même
  /* Nettoyage automatique : 85 % de la vitesse maxi du mode PLAY. Pas 100 % —
     un robot qui fonce à fond n'arrive jamais à l'arrêt là où il faut tirer,
     et le temps gagné en translation est reperdu au freinage. */
  const AUTO_V = 2.2 * 0.85;
  const AUTO_STOP = 0.9;             // on s'arrête à cette distance d'un but
  const AUTO_SCAN = [0, 0.10, -0.10, 0.20, -0.20, 0.32, -0.32, 0.46, -0.46,
                     0.62, -0.62, 0.80, -0.80, 1.00, -1.00, 1.25, -1.25,
                     1.55, -1.55, 1.90, -1.90];
  const AUTO_HALF = 0.26;            // demi-gabarit sondé de part et d'autre
  const AUTO_JAM = 1.1;              // s d'immobilité avant de se dégager
  const AUTO_BACK = 0.9;             // s de marche arrière pour se dégager
  /* Détente tirée trop tôt : on garde l'intention une seconde. Refuser sans
     mémoire donne une détente MORTE — on appuie pile pendant que la tourelle
     tourne, rien ne part, et on croit le bouton cassé. Un poste de tir réel
     fait la même chose : l'ordre est donné, le coup part à l'alignement. */
  const WANT = 1.0;

  /** L'arme en main. */
  function W() { return WEAPONS[S.wpn]; }

  /** Le mode de tir effectif : celui choisi, sauf pour le lance-grenades. */
  function MO() {
    if (W().id === "lg") return { id: "coup", name: "Coup par coup",
                                  short: "1 CP", n: 1, rest: W().rest, once: true };
    return MODES[S.mode];
  }

  const S = {
    on: false, targets: [], group: null, gun: null, turret: null, barrel: null,
    flash: null, fpv: null, tracers: [], yaw: 0, pitch: 0, lock: null,
    hold: null, ready: false, wasReady: false, seen: 0, auto: false, autoSay: "",
    autoJam: 0, autoBack: 0, autoTurn: 0, autoSide: 1, far: 30, mode: 1, want: 0,
    ammo: 30, reload: 0, burst: 0, next: 0, rest: 0, wpn: 0, gimbal: null,
    gimbalErr: 0, gimbalUse: 0, gimbalNeed: 0, models: null,
    shells: [], booms: [], scars: null, wrecked: false, breach: 0,
    live: 0, hits: 0, shots: 0, total: 0, t: 0, running: false, best: null, say: ""
  };

  /* --- construction ------------------------------------------------- */

  function silhouette() {
    const g = new T.Group();
    const post = new T.Mesh(new T.CylinderGeometry(0.022, 0.026, 0.30, 10),
      Y.Mat.get("frame"));
    post.userData.mat = "frame";
    post.rotation.x = Math.PI / 2; post.position.z = 0.15;
    g.add(post);
    const pivot = new T.Group();
    pivot.position.z = 0.28;
    const plate = new T.Mesh(new T.BoxGeometry(0.05, TARGET_W, TARGET_H),
      Y.Mat.get("targetFace"));
    plate.position.z = TARGET_H / 2;
    plate.castShadow = true; plate.userData.mat = "targetFace";
    pivot.add(plate);
    g.userData.plate = plate;
    // un disque central : là où l'on compte les points
    const bull = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 0.012, 20),
      Y.Mat.get("targetRing"));
    bull.rotation.z = Math.PI / 2;
    bull.position.set(-0.03, 0, TARGET_H * 0.62);
    bull.userData.mat = "targetRing";
    pivot.add(bull);
    g.add(pivot);
    g.userData.pivot = pivot;
    return g;
  }

  function buildGun() {
    /* Fusil d'assaut sur tourelle : un bâti qui tourne en lacet, un canon
       qui pointe en site. Le modèle reste sommaire — corps, garde-main,
       chargeur, bouche — parce qu'à l'échelle où on le voit, c'est la
       SILHOUETTE qui doit se lire, pas le détail. */
    const turret = new T.Group();
    const base = new T.Mesh(new T.CylinderGeometry(0.045, 0.052, 0.022, 16),
      Y.Mat.get("frame"));
    base.rotation.x = Math.PI / 2; base.position.z = 0.011;
    turret.add(base);
    const barrel = new T.Group();
    barrel.position.z = 0.035;
    const bodyG = new T.Mesh(new T.BoxGeometry(0.20, 0.038, 0.052), Y.Mat.get("gun"));
    bodyG.position.x = 0.02;
    const hand = new T.Mesh(new T.BoxGeometry(0.13, 0.030, 0.034), Y.Mat.get("gun"));
    hand.position.set(0.17, 0, -0.002);
    const tube = new T.Mesh(new T.CylinderGeometry(0.0085, 0.0085, 0.16, 10),
      Y.Mat.get("gunSteel"));
    tube.rotation.z = Math.PI / 2; tube.position.set(0.27, 0, 0.004);
    const brake = new T.Mesh(new T.CylinderGeometry(0.015, 0.013, 0.038, 10),
      Y.Mat.get("gunSteel"));
    brake.rotation.z = Math.PI / 2; brake.position.set(0.36, 0, 0.004);
    const mag = new T.Mesh(new T.BoxGeometry(0.030, 0.026, 0.10), Y.Mat.get("gun"));
    mag.position.set(0.03, 0, -0.062); mag.rotation.y = 0.22;
    const optic = new T.Mesh(new T.BoxGeometry(0.075, 0.024, 0.026), Y.Mat.get("gunSteel"));
    optic.position.set(0.04, 0, 0.040);
    const stock = new T.Mesh(new T.BoxGeometry(0.10, 0.030, 0.044), Y.Mat.get("gun"));
    stock.position.set(-0.12, 0, -0.004);
    [[bodyG, "gun"], [hand, "gun"], [tube, "gunSteel"], [brake, "gunSteel"],
     [mag, "gun"], [optic, "gunSteel"], [stock, "gun"], [base, "frame"]]
      .forEach(function (pr) { pr[0].userData.mat = pr[1]; });
    const rifle = new T.Group();
    rifle.add(bodyG, hand, tube, brake, mag, optic, stock);
    barrel.add(rifle);

    /* Le lance-grenades : même affût, autre tube. Court, gros, avec son
       barillet — la silhouette doit dire au premier coup d'œil qu'on n'a
       plus la même arme en main, parce que c'est la seule chose qui change
       visiblement quand on bascule. */
    const gl = new T.Group();
    const glBody = new T.Mesh(new T.BoxGeometry(0.15, 0.044, 0.056), Y.Mat.get("gun"));
    glBody.position.x = 0.0;
    const drum = new T.Mesh(new T.CylinderGeometry(0.052, 0.052, 0.085, 14),
      Y.Mat.get("gun"));
    drum.rotation.z = Math.PI / 2; drum.position.set(0.075, 0, -0.004);
    const glTube = new T.Mesh(new T.CylinderGeometry(0.024, 0.026, 0.20, 12),
      Y.Mat.get("gunSteel"));
    glTube.rotation.z = Math.PI / 2; glTube.position.set(0.22, 0, -0.004);
    const glRing = new T.Mesh(new T.CylinderGeometry(0.030, 0.030, 0.016, 12),
      Y.Mat.get("gunSteel"));
    glRing.rotation.z = Math.PI / 2; glRing.position.set(0.315, 0, -0.004);
    const glSight = new T.Mesh(new T.BoxGeometry(0.055, 0.020, 0.030), Y.Mat.get("gunSteel"));
    glSight.position.set(-0.02, 0, 0.042);
    const glStock = new T.Mesh(new T.BoxGeometry(0.11, 0.032, 0.048), Y.Mat.get("gun"));
    glStock.position.set(-0.12, 0, -0.006);
    [[glBody, "gun"], [drum, "gun"], [glTube, "gunSteel"], [glRing, "gunSteel"],
     [glSight, "gunSteel"], [glStock, "gun"]]
      .forEach(function (pr) { pr[0].userData.mat = pr[1]; });
    gl.add(glBody, drum, glTube, glRing, glSight, glStock);
    gl.visible = false;
    barrel.add(gl);
    S.models = [rifle, gl];

    // éclair de bouche : une pastille lumineuse, allumée trois centièmes
    const flash = new T.Mesh(new T.ConeGeometry(0.045, 0.10, 8),
      new T.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0 }));
    flash.rotation.z = -Math.PI / 2;
    flash.position.set(0.44, 0, 0.004);
    barrel.add(flash);
    turret.add(barrel);

    /* La caméra de l'arme. Elle est fille du CANON et non de la caisse :
       ce qu'on veut voir dans le petit écran, c'est ce que l'arme vise,
       pas ce que le robot regarde — la tourelle bouge toute seule, et
       c'est justement son mouvement qu'on suit.

       Une caméra three.js regarde son propre -Z, le canon tire vers son
       +X. On lui donne donc une base explicite : son -Z sur le +X du
       canon, son haut sur le +Z. Un `lookAt` par image ferait le même
       calcul, en moins lisible et à chaque image. */
    const fpv = new T.PerspectiveCamera(38, 1, 0.05, 200);
    fpv.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(
      new T.Vector3(0, -1, 0), new T.Vector3(0, 0, 1), new T.Vector3(-1, 0, 0)));
    fpv.position.set(0.06, 0, 0.055);       // sur la lunette, pas dans le canon
    barrel.add(fpv);
    S.fpv = fpv;

    S.turret = turret; S.barrel = barrel; S.flash = flash;
    return turret;
  }

  function build(scene) {
    if (S.group) return;
    const g = new T.Group();
    g.visible = false;
    scene.add(g);
    S.group = g;
    /* Les cratères vivent dans leur propre groupe : ils survivent au
       redressement des cibles et ne s'effacent qu'avec la série. */
    S.scars = new T.Group();
    g.add(S.scars);
  }

  /* =====================================================================
     Le stabilisateur

     Un affût stabilisé garde son horizon quand la caisse ne le garde plus.
     Ce n'est pas un effet : sans lui, le pointage calculé dans un repère
     horizontal est appliqué à un repère penché, et l'arme rate d'autant que
     le robot gîte — un degré de roulis à vingt mètres, c'est trente-cinq
     centimètres à côté.

     La plateforme est un groupe INTERMÉDIAIRE entre la caisse et la
     tourelle. On lui demande, à chaque image, la rotation qui annule celle
     de la caisse sauf le lacet : q = q_caisse⁻¹ · q_lacet. Le lacet reste,
     parce que c'est lui qui donne son origine au gisement — un affût qui
     annulerait aussi le lacet ne tournerait plus jamais avec le robot.

     Deux choses la rendent crédible plutôt que parfaite : elle MET du temps
     (une constante de 75 ms, donc elle traîne dans les à-coups) et elle a
     une BUTÉE à 26° — au-delà, la plateforme est au bout de sa course et
     l'écart résiduel repart dans la dispersion.
     ===================================================================== */
  const qBody = new T.Quaternion(), qYaw = new T.Quaternion();
  const qWant = new T.Quaternion(), eAxis = new T.Euler();
  const qNone = new T.Quaternion();

  function stabilise(dt) {
    if (!S.gimbal) return;
    const st = Y.Motion.state;
    S.gun.parent.getWorldQuaternion(qBody);
    eAxis.set(0, 0, st.yaw, "ZYX");
    qYaw.setFromEuler(eAxis);
    qWant.copy(qBody).invert().multiply(qYaw);

    /* Butée : on borne l'ANGLE de la correction, pas ses composantes. Borner
       chaque axe séparément tordrait la plateforme en diagonale au lieu de
       l'arrêter proprement. */
    const need = 2 * Math.acos(Math.min(1, Math.abs(qWant.w)));
    let over = 0;
    if (need > GIMBAL_MAX) {
      qWant.slerp(qNone, 1 - GIMBAL_MAX / need);   // on garde la direction
      over = need - GIMBAL_MAX;                    // et ce qui dépasse est perdu
    }
    const k = 1 - Math.exp(-dt / GIMBAL_TAU);
    S.gimbal.quaternion.slerp(qWant, k);

    /* L'écart qui compte pour le tir, c'est celui qui RESTE : ce que la butée
       n'a pas pu prendre, plus le retard de la plateforme sur sa consigne. */
    const q = S.gimbal.quaternion;
    const dot = Math.abs(qWant.w * q.w + qWant.x * q.x + qWant.y * q.y + qWant.z * q.z);
    S.gimbalErr = over + 2 * Math.acos(Math.min(1, dot));
    S.gimbalUse = Math.min(need, GIMBAL_MAX);
    S.gimbalNeed = need;
  }

  /* L'arme se monte sur le robot, pas dans la scène : elle doit suivre la
     caisse. On l'accroche à la première mise en place et non à la
     construction — le robot n'existe pas encore à ce moment-là. */
  function mountGun() {
    if (S.gun || !Y.Robot || !Y.Robot.body) return;
    /* Trois étages, et un rôle chacun : la PLATEFORME rattrape l'assiette de
       la caisse, la TOURELLE donne le gisement, le CANON donne le site. Les
       empiler dans cet ordre est ce qui rend le pointage indépendant de ce
       que fait le robot sous l'affût. */
    const gimbal = new T.Group();
    gimbal.add(buildGun());
    gimbal.position.set(-0.09, 0, K.trunkTop);
    Y.Robot.body.add(gimbal);
    S.gun = gimbal; S.gimbal = gimbal;
  }

  /* --- mise en place ------------------------------------------------ */

  function set(cfg) {
    S.on = !!cfg;
    if (S.on) mountGun();
    if (S.group) S.group.visible = S.on;
    if (S.gun) S.gun.visible = S.on;
    if (!S.on) { S.running = false; return; }
    S.cfg = cfg;
    /* Le bout du stand : là où va la reconnaissance quand elle n'a plus rien
       à se mettre sous la dent. C'est une donnée de TERRAIN, pas une position
       de cible — le robot a le droit de savoir où finit le couloir. */
    S.far = 0;
    (Y.Terrain.current.boxes || []).forEach(function (b) {
      if (b.x1 > S.far) S.far = b.x1;
    });
    S.far -= 3.0;
    // les matières sont réglées après la scène : on les relit ici
    if (S.gun) S.gun.traverse(function (c) {
      if (c.userData.mat) c.material = Y.Mat.get(c.userData.mat);
    });
    for (let i = S.group.children.length - 1; i >= 0; i--) {
      if (S.group.children[i] !== S.scars) S.group.remove(S.group.children[i]);
    }
    S.targets = cfg.targets.map(function (t) {
      const o = silhouette();
      /* Troisième valeur : la hauteur du PIED. Une cible sur le toit d'une
         voiture ou sur une passerelle n'est pas une autre sorte de cible,
         c'est la même, posée plus haut — et c'est à la tourelle de lever
         le canon pour aller la chercher. */
      const z = t[2] || 0;
      o.position.set(t[0], t[1], z);
      o.traverse(function (c) { if (c.userData.mat) c.material = Y.Mat.get(c.userData.mat); });
      S.group.add(o);
      /* Une cible mobile a besoin de son RAIL : sans lui, elle glisse en
         travers du couloir sans rien pour expliquer comment, et le joueur
         croit à un défaut plutôt qu'à un chariot. */
      const mv = t[3] || null;
      if (mv) {
        const rail = new T.Mesh(new T.BoxGeometry(0.10, mv[1] - mv[0] + 0.4, 0.05),
          Y.Mat.get("rail"));
        rail.position.set(t[0], (mv[0] + mv[1]) / 2, z + 0.025);
        rail.receiveShadow = true; rail.userData.mat = "rail";
        rail.material = Y.Mat.get("rail");
        S.group.add(rail);
      }
      return { x: t[0], y: t[1], z: z, up: 0, state: "down", friend: false,
               seen: false, obj: o, mv: mv, dir: 1, home: t[1] };
    });
    reset();
  }

  /** Hauteur du point visé sur une cible : le haut de la silhouette. */
  function aimZ(t) { return t.z + 0.28 + TARGET_H * 0.62; }

  /** Combien de cibles restent à abattre : les amies ne comptent pas. */
  function hostiles() {
    return S.targets.filter(function (t) { return !t.friend; }).length;
  }

  /** Repeindre une silhouette selon son camp. */
  function paint(t) {
    const pl = t.obj.userData.plate;
    pl.userData.mat = t.friend ? "targetSafe" : "targetFace";
    pl.material = Y.Mat.get(pl.userData.mat);
  }

  function reset() {
    S.targets.forEach(function (t) {
      t.up = 0; t.state = "down"; t.friend = false; t.seen = false;
      if (t.mv) { t.y = t.home; t.dir = 1; t.obj.position.y = t.y; }
      paint(t);
    });
    S.shells.length = 0;
    S.booms.forEach(function (b) { S.group.remove(b.obj); });
    S.booms.length = 0;
    S.seen = 0; S.auto = false; S.autoSay = "";
    S.autoJam = 0; S.autoBack = 0; S.autoTurn = 0; S.autoSide = 1;
    S.hits = 0; S.shots = 0; S.t = 0; S.running = false; S.live = 0;
    S.hold = null; S.lock = null; S.ready = false; S.wasReady = false;
    S.ammo = W().mag; S.reload = 0; S.burst = 0; S.next = 0; S.rest = 0; S.want = 0;
    S.total = S.targets.length;
    S.say = "Entrez sur la ligne de tir";
  }

  function raise() {
    /* Nouvelle série, terrain neuf. La réparation se fait ICI et non à la
       remise à zéro : remettre le terrain d'aplomb le fait reconstruire, ce
       qui relance la mise en place du stand — et la mise en place remet à
       zéro. Réparer depuis la remise à zéro se mordrait la queue.

       La reconstruction REMPLACE `S.targets` par des silhouettes neuves : on
       relève donc APRÈS elle, sur la nouvelle liste. Rendre la main ici, en
       comptant sur la reconstruction pour relever, laissait la série à
       l'arrêt — plus rien ne se levait, plus rien ne se tirait, et le
       nettoyage automatique refusait de partir faute de série en cours. */
    if (S.wrecked || S.breach) {
      S.wrecked = false; S.breach = 0;
      if (S.scars) { while (S.scars.children.length) S.scars.remove(S.scars.children[0]); }
      Y.Terrain.restore();
    }
    S.targets.forEach(function (t) { t.state = "rising"; });
    S.hits = 0; S.shots = 0; S.t = 0; S.running = true;
    S.total = hostiles();
    S.say = "Feu !";
    Y.Audio.raise();
  }

  /**
   * OPTIONS : la cible tenue en joue n'en est plus une.
   *
   * Un stand de tir où tout ce qui se lève est à abattre ne demande qu'un
   * doigt. Pouvoir DÉCLARER une silhouette amie change la nature de
   * l'exercice : la tourelle vise toute seule, mais c'est au pilote de dire
   * ce qui est une cible. Une amie sort du cycle de visée — on ne peut donc
   * plus lui tirer dessus, même en le voulant — et le compteur baisse
   * d'autant : la série se termine sans elle.
   */
  function spare() {
    const t = S.lock;
    if (!S.on || !t || t.friend) return false;
    t.friend = true; paint(t);
    S.hold = null; S.lock = null; S.ready = false;
    S.total = hostiles();
    S.say = "Cible amie — tir interdit";
    Y.Audio.friend();
    if (S.running && S.hits >= S.total) finish();
    return true;
  }

  /**
   * PARTAGE : figer le viseur sur la cible tenue, ou le relâcher.
   *
   * La visée automatique prend toujours la plus proche. C'est le bon choix
   * neuf fois sur dix, et le mauvais la dixième : celle qu'on veut est
   * derrière une autre, ou plus haut, et la tourelle repart vers l'autre à
   * chaque image. Figer rend la décision au pilote sans lui rendre le
   * pointage — l'arme continue de suivre toute seule, mais elle suit CELLE-LÀ.
   */
  function toggleHold() {
    if (!S.on) return false;
    if (S.hold) { S.hold = null; S.say = "Viseur libre"; Y.Audio.lock(); return true; }
    if (!S.lock) return false;
    S.hold = S.lock;
    S.say = "Viseur figé";
    Y.Audio.hold();
    return true;
  }

  /* =====================================================================
     NETTOYAGE AUTOMATIQUE — la touche PS

     Le robot fait tout seul ce que le pilote faisait à la main : il prend
     les cibles qu'il a REPÉRÉES, une par une, en se déplaçant quand il le
     faut. Il ne triche pas — il ne connaît que ce qui est sur sa carte, il
     doit voir une cible pour la tirer, et il roule à 85 % de la vitesse
     maximale, pas plus.

     La navigation est réactive et non planifiée : on vise le but, et si la
     route est barrée à hauteur de caisse on balaie l'angle de part et
     d'autre jusqu'à trouver un cap libre. C'est ce qui lui fait trouver la
     porte du mur sans qu'on lui ait dessiné de chemin — un plan de route
     serait à refaire à chaque terrain, alors qu'un cap libre se cherche
     partout de la même façon.
     ===================================================================== */

  /** Prochaine cible : la plus proche encore debout et déjà repérée. */
  function autoTarget() {
    const st = Y.Motion.state;
    let best = null, bd = Infinity;
    S.targets.forEach(function (t) {
      if (t.friend || !t.seen) return;
      if (t.state !== "up" && t.state !== "rising") return;
      const d = Math.hypot(t.x - st.px, t.y - st.py);
      if (d < bd) { bd = d; best = t; }
    });
    return best;
  }

  /**
   * Un cap qui passe.
   *
   * On essaie d'abord le cap direct, puis des écarts de plus en plus grands
   * de part et d'autre — le premier qui laisse quatre mètres libres à hauteur
   * de caisse est retenu. L'écart le plus faible gagne toujours : le robot
   * ne contourne qu'autant qu'il le faut, et revient au cap direct dès que
   * l'obstacle est passé.
   */
  /**
   * Une voie libre, pas un rayon libre.
   *
   * Un seul rayon parti du centre passe dans une porte de dix centimètres :
   * le robot en fait quarante-cinq de large et s'y coince. On sonde donc
   * TROIS rayons parallèles, écartés d'un demi-gabarit — c'est ce qui le fait
   * se centrer dans l'ouverture au lieu de venir taper le jambage.
   */
  function laneClear(px, py, z, a, d) {
    const nx = -Math.sin(a) * AUTO_HALF, ny = Math.cos(a) * AUTO_HALF;
    for (let s = -1; s <= 1; s++) {
      const ax = px + nx * s, ay = py + ny * s;
      if (Y.Terrain.blocked(ax, ay, z, ax + Math.cos(a) * d, ay + Math.sin(a) * d,
                            z, 0.05)) return false;
    }
    return true;
  }

  function autoHeading(want, dist) {
    const st = Y.Motion.state;
    const z = Y.Terrain.heightAt(st.px, st.py) + 0.25;
    const d = Math.min(4.0, Math.max(1.2, dist));
    for (let i = 0; i < AUTO_SCAN.length; i++) {
      const a = want + AUTO_SCAN[i];
      if (laneClear(st.px, st.py, z, a, d)) return a;
    }
    /* Rien ne passe à quatre mètres : on se contente d'un mètre et demi, le
       temps de se dégager. Un robot qui refuse de bouger tant qu'il n'a pas
       la voie entièrement libre ne sort jamais d'un angle. */
    for (let i = 0; i < AUTO_SCAN.length; i++) {
      const a = want + AUTO_SCAN[i];
      if (laneClear(st.px, st.py, z, a, 1.5)) return a;
    }
    return want + Math.PI;                          // demi-tour, en désespoir
  }

  function autoStep(dt) {
    const st = Y.Motion.state;
    let t = autoTarget();
    if (!t) {
      const left = S.targets.filter(function (x) {
        return !x.friend && x.state !== "down" && !x.seen;
      }).length;
      if (!left) {
        st.vx = 0; st.wz = 0; Y.Natural.setBrake(true);
        S.auto = false; S.autoSay = ""; S.say = "Terrain dégagé";
        Y.Audio.done();
        return;
      }
      /* Plus rien de repéré, mais il en reste : on RECONNAÎT. Le robot
         descend le couloir jusqu'à ce que quelque chose entre dans sa vue —
         il ne sait pas où sont les autres, il sait seulement qu'il n'a pas
         fini, et avancer est la seule façon de l'apprendre. */
      t = { x: S.far, y: 0, z: 0, recon: true };
      S.autoSay = "Reconnaissance — " + left + " cible(s) hors de vue";
    }
    const gunW = S.gun.getWorldPosition(v0.clone());
    const d = Math.hypot(t.x - st.px, t.y - st.py);
    const see = t.recon ? true : clear(gunW, t);
    /* On s'arrête pour tirer : la dispersion s'ouvre avec la vitesse, et un
       robot qui tire en roulant vide son chargeur pour rien. */
    const shootNow = !t.recon && see && d < W().reach - 0.6;
    if (shootNow) {
      st.vx = 0;
      st.wz = 0;
      /* Le frein, et pas seulement la consigne à zéro : sur une pente, lâcher
         les gaz ne suffit pas à tenir un robot sur roues, et un poste de tir
         qui dérive de dix centimètres pendant la rafale rate tout. */
      Y.Natural.setBrake(true);
      S.autoSay = "Tir sur la cible à " + d.toFixed(1) + " m";
      /* On attend d'être VRAIMENT arrêté : la consigne tombe à zéro d'un
         coup, la vitesse réelle non, et c'est la vitesse réelle qui ouvre
         la dispersion. */
      if (Math.abs(Y.Natural.state.vx) < 0.12 && S.ready) fire();
      return;
    }
    /* Coincé ? On recule.
       La navigation réactive n'a pas de mémoire : elle reproposera le même
       cap tant que la situation ne change pas, et la seule façon de la
       changer est de se déplacer. Un mètre en arrière suffit à rouvrir des
       angles que le nez contre l'obstacle ne voyait plus. */
    if (S.autoBack > 0) {
      S.autoBack -= dt;
      st.vx = -AUTO_V * 0.45;
      st.wz = S.autoTurn;
      Y.Natural.setBrake(false);
      S.autoSay = "Dégagement";
      return;
    }
    if (Math.abs(Y.Natural.state.vx) < 0.15) S.autoJam += dt; else S.autoJam = 0;
    if (S.autoJam > AUTO_JAM) {
      S.autoJam = 0; S.autoBack = AUTO_BACK;
      S.autoTurn = (S.autoSide = -S.autoSide) * 1.1;
      return;
    }
    const want = Math.atan2(t.y - st.py, t.x - st.px);
    const go = autoHeading(want, d);
    let e = ((go - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    st.wz = Math.max(-1.6, Math.min(1.6, e * 2.4));
    /* On ralentit dans les virages serrés : un robot qui tourne à pleine
       vitesse décrit une courbe plus large que le couloir. */
    const turnCut = 1 - Math.min(1, Math.abs(e) / 1.2) * 0.75;
    st.vx = d > AUTO_STOP ? AUTO_V * turnCut : 0;
    Y.Natural.setBrake(st.vx === 0);
    if (!t.recon) {
      S.autoSay = (see ? "Approche" : "Contournement") + " — cible à " + d.toFixed(1) + " m";
    }
  }

  /** Lancer ou arrêter le nettoyage automatique. */
  function toggleAuto() {
    if (!S.on) return false;
    /* Refuser en silence est le pire des deux mondes : on appuie, rien ne
       bouge, et on croit la touche cassée. Le refus se dit. */
    if (!S.running) {
      S.say = S.hits >= S.total && S.total
        ? "Série finie — repassez sur la ligne de tir"
        : "Aucune série en cours — entrez sur la ligne de tir";
      return false;
    }
    S.auto = !S.auto;
    if (!S.auto) {
      Y.Motion.state.vx = 0; Y.Motion.state.wz = 0;
      Y.Natural.setBrake(true);
      S.autoSay = ""; S.say = "Nettoyage interrompu";
      Y.Audio.lock();
    } else {
      S.hold = null;                      // le pilote automatique choisit seul
      S.autoJam = 0; S.autoBack = 0;
      S.say = "Nettoyage automatique";
      Y.Audio.hold();
    }
    return true;
  }

  /* =====================================================================
     Changer d'arme

     Le pavé tactile, parce qu'il est le seul bouton que rien ne réclamait :
     un CLIC BREF passe à l'arme suivante, un APPUI LONG revient à l'arme
     principale. Un cycle seul suffit tant qu'il n'y a que deux armes ; à
     trois, il faudrait déjà deux clics pour revenir au fusil au moment où
     l'on en a le plus besoin. Le retour direct coûte une ligne et se garde.

     (Autres pistes envisagées et écartées : une roue d'armes au pavé tenu —
     elle demande de LIRE l'écran au moment où l'on tire ; la croix
     directionnelle — déjà prise par les saltos ; un choix automatique selon
     la cible — il décide à la place du joueur, ce qui est exactement ce
     qu'on ne veut pas d'une arme.)
     ===================================================================== */

  function useWeapon(i) {
    if (!S.on) return false;
    const n = ((i % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (n === S.wpn) return false;
    S.wpn = n;
    if (S.models) S.models.forEach(function (m, k) { m.visible = k === n; });
    /* Chaque arme a son chargeur : on ne reprend pas un tir de fusil avec
       six grenades. Changer d'arme remet la cadence à zéro — c'est aussi ce
       qui empêche d'enchaîner deux rafales en basculant. */
    S.ammo = W().mag; S.reload = 0; S.burst = 0; S.next = 0; S.rest = 0.25; S.want = 0;
    S.say = W().name;
    Y.Audio.swap();
    return true;
  }

  function nextWeapon() { return useWeapon(S.wpn + 1); }
  function primaryWeapon() { return useWeapon(0); }

  function finish() {
    S.running = false;
    if (S.best === null || S.t < S.best) S.best = S.t;
    S.say = "Tout au sol en " + S.t.toFixed(2) + " s";
    Y.Audio.done();
  }

  /* --- tir ----------------------------------------------------------- */

  /** Demander une rafale. Rendue vraie si le coup part. */
  /**
   * Demander à tirer. `hold` dit que la détente était DÉJÀ enfoncée.
   *
   * C'est la seule chose qui sépare le coup par coup du reste : le coup part
   * à l'appui et pas tant qu'on tient. Sans ce drapeau, tenir la détente en
   * coup par coup viderait le chargeur au rythme de la reprise, ce qui est
   * exactement ce qu'on cherchait à éviter en le choisissant.
   */
  function fire(hold) {
    if (!S.on || !S.running || S.reload > 0 || S.burst > 0 || S.rest > 0) return false;
    if (hold && MO().once) return false;
    /* On ne PART pas sur une cible qu'on ne tient pas encore.
       La rafale durait 170 ms, la tourelle mettait plus longtemps que ça à
       s'aligner, et les deux premiers coups de chaque rafale partaient donc
       toujours à côté : la cible restait debout et l'on croyait à un défaut
       de collision. Le réticule dit déjà tout — rouge, on tire —, il fallait
       que la détente le respecte aussi. */
    if (S.lock && !S.ready) { S.want = WANT; return false; }
    S.want = 0;
    /* Et SANS cible, le fusil ne part pas du tout.
       Toute la conduite de tir est automatique : un coup sans verrou ne peut
       pas toucher, il ne fait que vider le chargeur. Détente tenue depuis la
       ligne de tir, avant : deux cibles couchées puis dix-sept coups dans le
       vide — de quoi croire que les cibles ne tombent plus. Le lance-grenades
       fait exception : tirer sur un mur ou sur une voiture est une intention
       en soi, et aucune de ces deux choses ne se verrouille. */
    if (!S.lock && W().id !== "lg") {
      S.say = "Aucune cible à portée";
      return false;
    }
    if (S.ammo <= 0) { S.reload = W().reload; S.say = "Rechargement"; Y.Audio.reload(); return false; }
    S.burst = Math.min(MO().n, S.ammo); S.next = 0;
    return true;
  }

  /** Passer au mode de tir suivant. */
  function nextMode() {
    if (!S.on) return false;
    S.mode = (S.mode + 1) % MODES.length;
    S.burst = 0; S.rest = 0.2;
    S.say = W().id === "lg" ? MODES[S.mode].name + " (sans effet au lance-grenades)"
                            : MODES[S.mode].name;
    Y.Audio.swap();
    return true;
  }

  function muzzle(out) {
    S.flash.getWorldPosition(out);
    return out;
  }

  const v0 = new T.Vector3(), v1 = new T.Vector3();

  /**
   * Une balle ne traverse pas un mur.
   *
   * Le même volume qui arrête une roue arrête un tir : c'est la description
   * analytique du terrain qui tranche, pas une géométrie de collision à part.
   * On ignore les trente-cinq premiers centimètres — sans quoi le robot se
   * masquerait lui-même dès qu'il roule sur une plateforme.
   */
  function clear(from, t) {
    return !Y.Terrain.blocked(from.x, from.y, from.z,
                              t.x, t.y, aimZ(t), MUZZLE_SKIP);
  }

  /** Où le tir se plante, s'il se plante avant la cible. */
  function stopAt(from, t) {
    return Y.Terrain.hitDist(from.x, from.y, from.z,
                             t.x, t.y, aimZ(t), MUZZLE_SKIP);
  }

  /* Loi normale approchée : douze tirages uniformes, moins six. C'est la
     dispersion d'une arme — la plupart des coups près de l'axe, quelques-uns
     loin, et jamais deux fois le même écart. */
  function randn() {
    let x = 0;
    for (let i = 0; i < 6; i++) x += Math.random();
    return (x - 3) / 1.2;
  }

  function shoot() {
    S.ammo--; S.shots++;
    S.flash.material.opacity = 0.95;
    muzzle(v0);
    const t = S.lock;

    /* Le lance-grenades ne tire pas un rayon : il LÂCHE un objet. La solution
       de tir lui donne son angle, la dispersion son écart de départ — et
       ensuite plus personne ne décide de rien, c'est la parabole qui dit où
       ça tombe. Un coup court, c'est un coup court : la grenade explose là où
       elle arrive, pas là où on visait. */
    if (W().id === "lg") {
      Y.Audio.thump();
      const yaw0 = Math.atan2(t ? t.y - v0.y : Math.sin(Y.Motion.state.yaw + S.yaw),
                              t ? t.x - v0.x : Math.cos(Y.Motion.state.yaw + S.yaw));
      const d = t ? Math.hypot(t.x - v0.x, t.y - v0.y) : W().reach;
      const h = t ? aimZ(t) - v0.z : 0;
      const speed = Math.abs(Y.Natural.state.vx);
      const err = (W().spread0 + speed * W().spreadV
                   + S.gimbalErr * 180 / Math.PI * 0.20) * Math.PI / 180;
      launch(v0, yaw0 + randn() * err, lobAngle(d, h, W().muzzleV) + randn() * err,
             W().muzzleV);
      return;
    }

    let hit = false;
    /* Le mur passe avant la dispersion : inutile de tirer aux dés si la balle
       se plante à mi-chemin. La cible a pu s'abriter entre le verrouillage et
       le coup — le robot roule, la géométrie bouge avec lui. */
    const wall = t ? stopAt(v0, t) : -1;
    if (t && t.state === "up" && S.ready && wall < 0) {
      /* Toucher n'est pas donné. La dispersion s'ouvre avec la VITESSE — on
         tire mieux à l'arrêt qu'en roulant, c'est la première chose qu'on
         apprend — et avec la place du coup dans la rafale, le recul écartant
         les suivants. Face à cela, la cible n'offre que sa largeur vue de
         loin : 1,6° à six mètres, 0,35° à vingt-huit. C'est ce rapport-là qui
         fait qu'on s'arrête pour les cibles lointaines. */
      const d = Math.hypot(t.x - v0.x, t.y - v0.y);
      const speed = Math.abs(Y.Natural.state.vx);
      const recoil = (W().burst - S.burst) * W().recoil;
      /* Ce que le stabilisateur ne rattrape pas s'ajoute à la dispersion :
         c'est l'écart RÉSIDUEL entre l'assiette de la caisse et la plateforme
         qui compte, pas l'assiette elle-même. Bien stabilisé, on tire d'un
         terrain cassé presque comme du plat ; au bout de la course, on paie. */
      const resid = S.gimbalErr * 180 / Math.PI * 0.20;
      const spread = (W().spread0 + speed * W().spreadV + recoil + resid)
                     * Math.PI / 180;
      const half = Math.atan(TARGET_W * 0.5 / Math.max(d, 0.5));
      hit = Math.abs(randn() * spread) < half;
    }
    Y.Audio.shot();
    if (hit) {
      t.state = "falling";
      S.hits++;
      if (S.hold === t) S.hold = null;      // elle est tombée : le viseur repart
      Y.Audio.hit();
      if (S.hits >= S.total) finish();
    } else Y.Audio.miss();
    // traceur : du canon au point d'impact, ou droit devant si on a manqué
    if (t) v1.set(t.x, t.y, aimZ(t));
    else {
      const d = new T.Vector3(1, 0, 0).applyQuaternion(S.barrel.getWorldQuaternion(new T.Quaternion()));
      v1.copy(v0).addScaledVector(d, W().reach);
    }
    if (!hit && t && wall < 0) {                    // on tire à côté
      v1.x += (Math.random() - 0.5) * 1.2;
      v1.y += (Math.random() - 0.5) * 1.2;
    }
    if (wall >= 0) {
      // le traceur s'arrête net dans le mur : c'est ce qui se voit
      v1.sub(v0).setLength(wall).add(v0);
    }
    S.tracers.push({ a: v0.clone(), b: v1.clone(), t: 0 });
  }

  /* =====================================================================
     Le lance-grenades : une parabole, un souffle, et des dégâts

     La grenade est le seul objet de ce visualiseur qui vole vraiment. Elle
     part à vingt-cinq mètres par seconde et retombe : à trente mètres, la
     hausse dépasse le mètre, ce qui la fait passer PAR-DESSUS un mur que la
     balle ne traverse pas. C'est toute la raison d'avoir deux armes.

     La solution de tir est celle du canonnier : pour une portée d et une
     dénivelée h, l'angle bas de la parabole vaut

         θ = atan( (v² − √(v⁴ − g·(g·d² + 2·h·v²)) ) / (g·d) )

     Le radical négatif dit que la cible est hors de portée — on tire alors
     à quarante-cinq degrés, l'angle qui porte le plus loin, et on tombe
     court sans se mentir.
     ===================================================================== */

  function lobAngle(d, h, v) {
    const disc = v * v * v * v - G * (G * d * d + 2 * h * v * v);
    if (disc < 0) return Math.PI / 4;
    return Math.atan((v * v - Math.sqrt(disc)) / (G * d));
  }

  function launch(from, dirYaw, pitch, v) {
    const geo = new T.SphereGeometry(0.032, 10, 8);
    const obj = new T.Mesh(geo, Y.Mat.get("gunSteel"));
    obj.userData.mat = "gunSteel";
    obj.material = Y.Mat.get("gunSteel");
    obj.position.copy(from);
    S.group.add(obj);
    S.shells.push({
      obj: obj,
      p: from.clone(),
      v: new T.Vector3(Math.cos(pitch) * Math.cos(dirYaw) * v,
                       Math.cos(pitch) * Math.sin(dirYaw) * v,
                       Math.sin(pitch) * v),
      t: 0
    });
  }

  /**
   * La grenade rencontre-t-elle une silhouette ?
   *
   * Le terrain sait s'arrêter une balle, il ne sait rien des cibles — ce ne
   * sont pas des volumes de terrain. Sans ce test, la grenade traversait la
   * silhouette qu'elle visait et allait tomber dix-sept mètres plus loin :
   * la solution de tir était bonne, il ne manquait qu'à quoi s'arrêter.
   *
   * On échantillonne le déplacement de l'image : à vingt-cinq mètres par
   * seconde, il fait quarante centimètres, et six points suffisent à ne pas
   * enjamber une cible large de trente-quatre.
   */
  function shellHit(p0, p1) {
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      const x = p0.x + (p1.x - p0.x) * k;
      const y = p0.y + (p1.y - p0.y) * k;
      const z = p0.z + (p1.z - p0.z) * k;
      for (let j = 0; j < S.targets.length; j++) {
        const t = S.targets[j];
        if (t.state !== "up" && t.state !== "rising") continue;
        if (z < t.z + 0.10 || z > t.z + 1.05) continue;
        if (Math.hypot(t.x - x, t.y - y) > 0.28) continue;
        return new T.Vector3(x, y, z);
      }
    }
    return null;
  }

  function stepShells(dt) {
    for (let i = S.shells.length - 1; i >= 0; i--) {
      const sh = S.shells[i];
      const p0 = sh.p.clone();
      sh.v.z -= G * dt;
      sh.p.addScaledVector(sh.v, dt);
      sh.t += dt;
      /* On teste le SEGMENT parcouru et non le point d'arrivée : à vingt-cinq
         mètres par seconde et soixante images, la grenade avance de quarante
         centimètres par image et traverserait un mur de cinquante sans
         jamais s'y trouver. */
      const d = Y.Terrain.hitDist(p0.x, p0.y, p0.z, sh.p.x, sh.p.y, sh.p.z, 0);
      const ground = Y.Terrain.heightAt(sh.p.x, sh.p.y);
      let boom = shellHit(p0, sh.p);
      if (boom) { /* une silhouette d'abord : c'est elle qu'on visait */ }
      else if (d >= 0) {
        boom = p0.clone().add(sh.p.clone().sub(p0).setLength(Math.max(0.01, d - 0.02)));
      } else if (sh.p.z <= ground + 0.03) {
        boom = sh.p.clone(); boom.z = ground + 0.02;
      } else if (sh.t > 6) {
        boom = sh.p.clone();
      }
      if (boom) {
        explode(boom);
        S.group.remove(sh.obj); sh.obj.geometry.dispose();
        S.shells.splice(i, 1);
      } else {
        sh.obj.position.copy(sh.p);
      }
    }
  }

  /* --- le souffle, et ce qu'il abîme -------------------------------- */

  function explode(p) {
    Y.Audio.blast();
    const R = WEAPONS[1].blast;

    // la boule de feu : deux sphères qui grossissent et s'effacent
    const ball = new T.Mesh(new T.SphereGeometry(1, 14, 10),
      new T.MeshBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.95 }));
    ball.position.copy(p); ball.scale.setScalar(0.25);
    S.group.add(ball);
    S.booms.push({ obj: ball, t: 0, R: R });

    // le cratère : une pastille sombre au sol, qui reste
    if (S.scars) {
      const scar = new T.Mesh(new T.CircleGeometry(0.55 + Math.random() * 0.25, 16),
        new T.MeshStandardMaterial({ color: 0x14100d, roughness: 0.98,
          transparent: true, opacity: 0.85, depthWrite: false }));
      scar.position.set(p.x, p.y, Y.Terrain.heightAt(p.x, p.y) + 0.012);
      S.scars.add(scar);
      // et quelques éclats projetés autour
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * Math.PI * 2, r = 0.5 + Math.random() * 1.1;
        const chip = new T.Mesh(new T.CircleGeometry(0.10 + Math.random() * 0.14, 8),
          new T.MeshStandardMaterial({ color: 0x1c1712, roughness: 1,
            transparent: true, opacity: 0.55, depthWrite: false }));
        chip.position.set(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r,
          Y.Terrain.heightAt(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r) + 0.011);
        S.scars.add(chip);
      }
    }

    // les cibles dans le souffle tombent — une grenade ne vise pas, elle couvre
    S.targets.forEach(function (t) {
      if (t.friend || t.state !== "up") return;
      if (Math.hypot(t.x - p.x, t.y - p.y, aimZ(t) - p.z) > R) return;
      t.state = "falling"; S.hits++;
      if (S.hold === t) S.hold = null;
    });
    if (S.hits >= S.total && S.running) finish();

    damage(p, R);
  }

  /**
   * Ce que le souffle emporte du TERRAIN.
   *
   * Les blocs destructibles portent un nom : `auto` pour la carcasse, `mur`
   * pour les panneaux du mur. Une explosion assez proche les retire de la
   * description — et comme c'est cette même description qui donne la hauteur
   * du sol, la ligne de vue et les collisions, le trou est immédiatement
   * réel : on voit à travers, on tire à travers, on passe à travers. Rien à
   * synchroniser, il n'y a qu'une seule vérité.
   */
  function damage(p, R) {
    const boxes = Y.Terrain.current.boxes;
    const keep = [], add = [];
    let hitCar = false; const panels = {};
    boxes.forEach(function (b) {
      if (!b.part) { keep.push(b); return; }
      /* Distance au BLOC et non à son centre : un panneau de mur fait huit
         mètres de long, et le mesurer depuis son milieu le rendrait
         indestructible par les bouts. La distance à une boîte alignée est la
         norme de l'écart aux bornes, composante par composante — deux
         maximums et une racine. */
      const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
      const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
      const dz = Math.max((b.z0 || 0) - p.z, 0, p.z - b.h);
      /* Le béton armé résiste mieux que de la tôle : le rayon STRUCTUREL
         d'un panneau de mur vaut six dixièmes du souffle, celui d'une
         carrosserie le souffle entier. Une grenade ouvre donc une brèche de
         deux mètres et souffle une voiture à trois. */
      const near = Math.hypot(dx, dy, dz) < R * (b.part === "mur" ? 0.30 : 1);
      if (!near) { keep.push(b); return; }
      if (b.part === "auto") { hitCar = true; return; }
      if (b.part === "mur") { panels[b.panel] = true; return; }
      keep.push(b);
    });
    if (!hitCar && !Object.keys(panels).length) return;

    /* Un panneau touché emporte TOUT le panneau, linteau compris : un mur ne
       s'ouvre pas en rond, il tombe entre deux trumeaux. */
    const out = keep.filter(function (b) {
      return !(b.part === "mur" && panels[b.panel]);
    });

    if (hitCar) {
      /* La carcasse ne disparaît pas : elle s'écrase. Une épave reste un
         abri, plus bas et franchissable — le terrain change de forme, il ne
         se vide pas. */
      const cx = 20.60, cy = -1.30;
      out.push({ x0: cx - 2.10, x1: cx + 2.10, y0: cy - 0.86, y1: cy + 0.86,
                 h: 0.42, z0: 0, mat: "wreck", part: "epave" });
      S.wrecked = true;
      S.say = "Véhicule détruit";
    }
    Object.keys(panels).forEach(function (id) {
      // le pan tombé laisse ses décombres : un tas de 35 cm, qui se franchit
      const b = boxes.find(function (x) { return x.part === "mur" && String(x.panel) === id && !x.z0; });
      if (b) {
        out.push({ x0: b.x0 - 0.15, x1: b.x1 + 0.15, y0: b.y0, y1: b.y1,
                   h: 0.35, z0: 0, mat: "debris", part: "gravats" });
      } else {
        // un panneau de porte n'a que son linteau : il ne laisse rien au sol
        const l = boxes.find(function (x) { return x.part === "mur" && String(x.panel) === id; });
        if (l) out.push({ x0: l.x0 - 0.10, x1: l.x1 + 0.10, y0: l.y0, y1: l.y1,
                          h: 0.14, z0: 0, mat: "debris", part: "gravats" });
      }
      S.breach++;
    });
    if (S.breach) S.say = "Brèche dans le mur";
    Y.Terrain.mutate(out);
  }

  function stepBooms(dt) {
    for (let i = S.booms.length - 1; i >= 0; i--) {
      const b = S.booms[i];
      b.t += dt;
      const k = b.t / 0.45;
      if (k >= 1) { S.group.remove(b.obj); b.obj.geometry.dispose(); S.booms.splice(i, 1); continue; }
      b.obj.scale.setScalar(0.25 + k * b.R);
      b.obj.material.opacity = 0.95 * (1 - k) * (1 - k);
      b.obj.material.color.setHSL(0.08 - 0.08 * k, 1, 0.5 - 0.25 * k);
    }
  }

  /* --- pas de temps --------------------------------------------------- */

  function step(dt) {
    if (!S.on || !S.group) return;
    const st = Y.Motion.state;
    stabilise(dt);
    stepShells(dt);
    stepBooms(dt);

    // entrée sur la ligne de tir : les cibles se relèvent
    const z = S.cfg.zone;
    const inZone = st.px > z[0] && st.px < z[1] && st.py > z[2] && st.py < z[3];
    if (inZone && !S.running && S.hits === 0) raise();
    if (inZone && !S.running && S.hits >= S.total) reset();
    if (S.running) S.t += dt;

    // montée, chute et pose des silhouettes
    S.live = 0;
    S.targets.forEach(function (t) {
      if (t.state === "rising") { t.up = Math.min(1, t.up + dt * 2.6); if (t.up >= 1) t.state = "up"; }
      else if (t.state === "falling") { t.up = Math.max(0, t.up - dt * 4.5); if (t.up <= 0) t.state = "down"; }
      if (t.state === "up" || t.state === "rising") S.live++;
      /* Le chariot ne roule que quand la silhouette est levée : une cible
         couchée qui continue de glisser sur son rail se verrait, et n'aurait
         aucun sens — le chariot rentre avec elle. */
      if (t.mv && (t.state === "up" || t.state === "rising")) {
        t.y += t.dir * t.mv[2] * dt;
        if (t.y > t.mv[1]) { t.y = t.mv[1]; t.dir = -1; }
        if (t.y < t.mv[0]) { t.y = t.mv[0]; t.dir = 1; }
        t.obj.position.y = t.y;
      }
      // 0 = couchée vers l'arrière, 1 = debout
      t.obj.userData.pivot.rotation.y = (1 - t.up) * Math.PI / 2;
    });

    /* --- visée automatique ---
       La plus proche encore debout, dans le cône avant. On tourne vers elle
       à vitesse bornée : une tourelle a une inertie, et c'est elle qui fait
       qu'on ne peut pas balayer huit cibles en une rafale. */
    let best = null, bd = Infinity;
    const gunW = S.gun.getWorldPosition(v0.clone());

    /* --- ce que le robot REPÈRE, et garde ---
       Une cible aperçue une fois reste connue : elle passe sur la carte et
       n'en sort plus, même quand un mur se remet entre elle et le robot.
       C'est ce qui distingue une carte d'une vue — la vue oublie, la carte
       non, et c'est la carte qui permet de décider où aller. Le lidar tourne,
       donc on repère tout autour et pas seulement devant : la seule condition
       est d'avoir vu, c'est-à-dire d'être à découvert et à portée. */
    S.targets.forEach(function (t) {
      if (t.seen || t.state === "down") return;
      if (Math.hypot(t.x - gunW.x, t.y - gunW.y) > DETECT) return;
      if (!clear(gunW, t)) return;
      t.seen = true; S.seen++;
      Y.Audio.ping();
    });

    /* Une cible figée à la main garde la tourelle tant qu'elle est debout ;
       une cible déclarée amie n'entre jamais dans le cycle — c'est ce qui
       rend le tir sur elle impossible plutôt que seulement déconseillé ; et
       une cible derrière un mur n'est pas une cible, puisque la balle
       n'arriverait pas. La tourelle ne se braque donc que sur ce qu'elle
       peut réellement toucher. */
    if (S.hold && (S.hold.state !== "up" && S.hold.state !== "rising")) S.hold = null;
    if (S.hold && !clear(gunW, S.hold)) S.hold = null;
    if (S.hold) best = S.hold;
    else S.targets.forEach(function (t) {
      if (t.friend) return;
      if (t.state !== "up" && t.state !== "rising") return;
      const dx = t.x - gunW.x, dy = t.y - gunW.y;
      const d = Math.hypot(dx, dy);
      if (d > W().reach) return;
      let a = Math.atan2(dy, dx) - st.yaw;
      a = ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(a) > PAN_MAX) return;
      if (d >= bd) return;
      if (!clear(gunW, t)) return;
      bd = d; best = t;
    });
    S.lock = best;
    let wantYaw = 0, wantPitch = 0;
    if (best) {
      const dx = best.x - gunW.x, dy = best.y - gunW.y;
      wantYaw = ((Math.atan2(dy, dx) - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const dz = aimZ(best) - (gunW.z + 0.04);
      wantPitch = Math.atan2(dz, Math.hypot(dx, dy));
    }
    const step2 = SLEW * dt;
    /* Le pointage est BORNÉ, comme celui d'un vrai affût : ±150° en gisement,
       −18° à +58° en site. La consigne est bornée avant d'être suivie, et non
       après : sinon la tourelle passerait son temps à courir après un angle
       qu'elle n'atteindra jamais et ne se déclarerait jamais alignée. */
    wantYaw = clamp(wantYaw, -PAN_MAX, PAN_MAX);
    wantPitch = clamp(wantPitch, TILT_MIN, TILT_MAX);
    S.yaw += clamp(wantYaw - S.yaw, -step2, step2);
    S.pitch += clamp(wantPitch - S.pitch, -step2, step2);
    S.ready = !!best && Math.abs(wantYaw - S.yaw) < TOL && Math.abs(wantPitch - S.pitch) < TOL;
    // le bip ne sonne qu'au passage : verrouillé n'est pas un état, c'est un instant
    if (S.ready && !S.wasReady) Y.Audio.lock();
    S.wasReady = S.ready;
    S.turret.rotation.z = S.yaw;
    S.barrel.rotation.y = -S.pitch;

    /* --- cadence --- */
    // l'intention gardée : elle part dès que la tourelle tient enfin la cible
    if (S.want > 0) {
      S.want -= dt;
      if (S.ready) { S.want = 0; fire(false); }
    }
    if (S.reload > 0) {
      S.reload -= dt;
      if (S.reload <= 0) { S.ammo = W().mag; S.say = S.running ? "Feu !" : S.say; }
    } else if (S.burst > 0) {
      S.next -= dt;
      /* Une cible qui bouge peut sortir de l'axe au milieu de la rafale : on
         suspend la cadence le temps que la tourelle la retrouve, au lieu de
         vider le chargeur dans le vide. */
      if (S.next <= 0 && (!S.lock || S.ready)) {
        shoot(); S.burst--; S.next = W().rate;
        if (S.burst === 0) S.rest = W().id === "lg" ? W().rest : MO().rest;
      }
    } else if (S.rest > 0) S.rest -= dt;
    if (S.ammo <= 0 && S.reload <= 0) { S.reload = W().reload; S.say = "Rechargement"; Y.Audio.reload(); }

    if (S.auto) autoStep(dt);

    // éclair et traceurs s'éteignent vite : c'est ce qui les rend lisibles
    S.flash.material.opacity = Math.max(0, S.flash.material.opacity - dt * 24);
    for (let i = S.tracers.length - 1; i >= 0; i--) {
      const tr = S.tracers[i];
      tr.t += dt;
      if (tr.t > 0.09) { if (tr.line) { S.group.remove(tr.line); tr.line.geometry.dispose(); } S.tracers.splice(i, 1); continue; }
      if (!tr.line) {
        const geo = new T.BufferGeometry().setFromPoints([tr.a, tr.b]);
        tr.line = new T.Line(geo, new T.LineBasicMaterial({
          color: 0xffd08a, transparent: true, opacity: 0.9 }));
        S.group.add(tr.line);
      }
      tr.line.material.opacity = 0.9 * (1 - tr.t / 0.09);
    }
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  Y.Range = {
    state: S,
    build: build,
    set: set,
    reset: reset,
    fire: fire,
    step: step,
    spare: spare,
    hold: toggleHold,
    sweep: toggleAuto,
    nextWeapon: nextWeapon,
    primaryWeapon: primaryWeapon,
    nextMode: nextMode,
    weapon: function () { return W(); },
    mode: function () { return MO(); },
    /** Le pilote automatique tient-il les commandes ? */
    autopilot: function () { return S.on && S.auto; },
    /** Ce que la carte doit montrer : tout ce qui a été repéré, et rien d'autre. */
    map: function () {
      if (!S.on) return null;
      return {
        zone: S.cfg.zone,
        seen: S.targets.filter(function (t) { return t.seen; }).map(function (t) {
          return { x: t.x, y: t.y, z: t.z, friend: t.friend,
                   down: t.state === "down" || t.state === "falling",
                   lock: t === S.lock };
        }),
        auto: S.auto, say: S.autoSay
      };
    },
    active: function () { return S.on; },
    /** La caméra de l'arme, pour le quart d'écran en bas à droite. */
    camera: function () { return S.on ? S.fpv : null; },
    /**
     * État du réticule, lu par l'application pour dessiner le viseur :
     * `aim` = une cible est prise en compte, `ready` = l'axe est bon —
     * c'est ce qui le fait passer au rouge —, `held` = viseur figé.
     */
    reticle: function () {
      return { aim: !!S.lock, ready: S.ready, held: !!S.hold,
               wpn: W().short, mode: MO().short, lob: W().id === "lg",
               stab: S.gimbalUse * 180 / Math.PI, err: S.gimbalErr * 180 / Math.PI,
               dist: S.lock ? Math.hypot(S.lock.x - Y.Motion.state.px,
                                         S.lock.y - Y.Motion.state.py) : 0,
               reload: S.reload > 0, ammo: S.ammo };
    },
    /** Ligne d'état : munitions, cibles, chrono. */
    hud: function () {
      if (!S.on) return "";
      const friends = S.targets.length - S.total;
      return W().short + " " + MO().short + " · Cibles " + S.hits + "/" + S.total
        + (friends ? " · " + friends + " amie" + (friends > 1 ? "s" : "") : "")
        + " · " + (S.reload > 0 ? "rechargement" : S.ammo + " coups")
        + (S.running ? " · " + S.t.toFixed(1) + " s" : "")
        + (S.best !== null ? " · record " + S.best.toFixed(2) + " s" : "")
        + " · repérées " + S.seen + "/" + S.targets.length
        + (S.auto ? " · NETTOYAGE AUTO" : "")
        + (S.hold ? " · FIGÉ" : "")
        + (S.ready ? " · VERROUILLÉ" : "");
    }
  };
})(window.YLO);
