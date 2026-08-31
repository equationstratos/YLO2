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
  const CONE = 2.0;                  // demi-cône de recherche, rad
  const SLEW = 3.4;                  // vitesse de rotation de la tourelle, rad/s
  const TOL = 0.045;                 // écart d'alignement toléré au coup
  const BURST = 3;                   // coups par rafale
  const RATE = 0.085;                // s entre deux coups d'une rafale
  const REST = 0.30;                 // s entre deux rafales
  const MAG = 30;                    // cartouches par chargeur
  const RELOAD = 1.7;                // s de rechargement
  const TARGET_H = 0.72;             // hauteur de la silhouette
  const TARGET_W = 0.34;
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

  const S = {
    on: false, targets: [], group: null, gun: null, turret: null, barrel: null,
    flash: null, fpv: null, tracers: [], yaw: 0, pitch: 0, lock: null,
    hold: null, ready: false, wasReady: false, seen: 0, auto: false, autoSay: "",
    autoJam: 0, autoBack: 0, autoTurn: 0, autoSide: 1, far: 30,
    ammo: MAG, reload: 0, burst: 0, next: 0, rest: 0,
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
    barrel.add(bodyG, hand, tube, brake, mag, optic, stock);
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
  }

  /* L'arme se monte sur le robot, pas dans la scène : elle doit suivre la
     caisse. On l'accroche à la première mise en place et non à la
     construction — le robot n'existe pas encore à ce moment-là. */
  function mountGun() {
    if (S.gun || !Y.Robot || !Y.Robot.body) return;
    S.gun = buildGun();
    S.gun.position.set(-0.09, 0, K.trunkTop);
    Y.Robot.body.add(S.gun);
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
    while (S.group.children.length) S.group.remove(S.group.children[0]);
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
      return { x: t[0], y: t[1], z: z, up: 0, state: "down", friend: false,
               seen: false, obj: o };
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
      t.up = 0; t.state = "down"; t.friend = false; t.seen = false; paint(t);
    });
    S.seen = 0; S.auto = false; S.autoSay = "";
    S.autoJam = 0; S.autoBack = 0; S.autoTurn = 0; S.autoSide = 1;
    S.hits = 0; S.shots = 0; S.t = 0; S.running = false; S.live = 0;
    S.hold = null; S.lock = null; S.ready = false; S.wasReady = false;
    S.ammo = MAG; S.reload = 0; S.burst = 0; S.next = 0; S.rest = 0;
    S.total = S.targets.length;
    S.say = "Entrez sur la ligne de tir";
  }

  function raise() {
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
    const shootNow = !t.recon && see && d < REACH - 0.6;
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
    if (!S.on || !S.running) return false;
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

  function finish() {
    S.running = false;
    if (S.best === null || S.t < S.best) S.best = S.t;
    S.say = "Tout au sol en " + S.t.toFixed(2) + " s";
    Y.Audio.done();
  }

  /* --- tir ----------------------------------------------------------- */

  /** Demander une rafale. Rendue vraie si le coup part. */
  function fire() {
    if (!S.on || !S.running || S.reload > 0 || S.burst > 0 || S.rest > 0) return false;
    if (S.ammo <= 0) { S.reload = RELOAD; S.say = "Rechargement"; Y.Audio.reload(); return false; }
    S.burst = BURST; S.next = 0;
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
      const recoil = (BURST - S.burst) * 0.55;
      const spread = (0.70 + speed * 1.30 + recoil) * Math.PI / 180;
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
      v1.copy(v0).addScaledVector(d, REACH);
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

  /* --- pas de temps --------------------------------------------------- */

  function step(dt) {
    if (!S.on || !S.group) return;
    const st = Y.Motion.state;

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
      if (d > REACH) return;
      let a = Math.atan2(dy, dx) - st.yaw;
      a = ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(a) > CONE) return;
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
    S.yaw += clamp(wantYaw - S.yaw, -step2, step2);
    S.pitch += clamp(wantPitch - S.pitch, -step2, step2);
    S.ready = !!best && Math.abs(wantYaw - S.yaw) < TOL && Math.abs(wantPitch - S.pitch) < TOL;
    // le bip ne sonne qu'au passage : verrouillé n'est pas un état, c'est un instant
    if (S.ready && !S.wasReady) Y.Audio.lock();
    S.wasReady = S.ready;
    S.turret.rotation.z = S.yaw;
    S.barrel.rotation.y = -S.pitch;

    /* --- cadence --- */
    if (S.reload > 0) {
      S.reload -= dt;
      if (S.reload <= 0) { S.ammo = MAG; S.say = S.running ? "Feu !" : S.say; }
    } else if (S.burst > 0) {
      S.next -= dt;
      if (S.next <= 0) { shoot(); S.burst--; S.next = RATE; if (S.burst === 0) S.rest = REST; }
    } else if (S.rest > 0) S.rest -= dt;
    if (S.ammo <= 0 && S.reload <= 0) { S.reload = RELOAD; S.say = "Rechargement"; Y.Audio.reload(); }

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
               dist: S.lock ? Math.hypot(S.lock.x - Y.Motion.state.px,
                                         S.lock.y - Y.Motion.state.py) : 0,
               reload: S.reload > 0, ammo: S.ammo };
    },
    /** Ligne d'état : munitions, cibles, chrono. */
    hud: function () {
      if (!S.on) return "";
      const friends = S.targets.length - S.total;
      return "Cibles " + S.hits + "/" + S.total
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
