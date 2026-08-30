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

  const S = {
    on: false, targets: [], group: null, gun: null, turret: null, barrel: null,
    flash: null, tracers: [], yaw: 0, pitch: 0, lock: null, ready: false,
    ammo: MAG, reload: 0, burst: 0, next: 0, rest: 0,
    live: 0, hits: 0, shots: 0, t: 0, running: false, best: null, say: ""
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
    // les matières sont réglées après la scène : on les relit ici
    if (S.gun) S.gun.traverse(function (c) {
      if (c.userData.mat) c.material = Y.Mat.get(c.userData.mat);
    });
    while (S.group.children.length) S.group.remove(S.group.children[0]);
    S.targets = cfg.targets.map(function (t) {
      const o = silhouette();
      o.position.set(t[0], t[1], 0);
      o.traverse(function (c) { if (c.userData.mat) c.material = Y.Mat.get(c.userData.mat); });
      S.group.add(o);
      return { x: t[0], y: t[1], up: 0, state: "down", obj: o };
    });
    reset();
  }

  function reset() {
    S.targets.forEach(function (t) { t.up = 0; t.state = "down"; });
    S.hits = 0; S.shots = 0; S.t = 0; S.running = false; S.live = 0;
    S.ammo = MAG; S.reload = 0; S.burst = 0; S.next = 0; S.rest = 0;
    S.say = "Entrez sur la ligne de tir";
  }

  function raise() {
    S.targets.forEach(function (t) { t.state = "rising"; });
    S.hits = 0; S.shots = 0; S.t = 0; S.running = true;
    S.say = "Feu !";
  }

  /* --- tir ----------------------------------------------------------- */

  /** Demander une rafale. Rendue vraie si le coup part. */
  function fire() {
    if (!S.on || !S.running || S.reload > 0 || S.burst > 0 || S.rest > 0) return false;
    if (S.ammo <= 0) { S.reload = RELOAD; S.say = "Rechargement"; return false; }
    S.burst = BURST; S.next = 0;
    return true;
  }

  function muzzle(out) {
    S.flash.getWorldPosition(out);
    return out;
  }

  const v0 = new T.Vector3(), v1 = new T.Vector3();

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
    if (t && t.state === "up" && S.ready) {
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
    if (hit) {
      t.state = "falling";
      S.hits++;
      if (S.hits >= S.targets.length) {
        S.running = false;
        if (S.best === null || S.t < S.best) S.best = S.t;
        S.say = "Tout au sol en " + S.t.toFixed(2) + " s";
      }
    }
    // traceur : du canon au point d'impact, ou droit devant si on a manqué
    if (t) v1.set(t.x, t.y, TARGET_H * 0.62 + 0.28);
    else {
      const d = new T.Vector3(1, 0, 0).applyQuaternion(S.barrel.getWorldQuaternion(new T.Quaternion()));
      v1.copy(v0).addScaledVector(d, REACH);
    }
    if (!hit && t) {                                // on tire à côté
      v1.x += (Math.random() - 0.5) * 1.2;
      v1.y += (Math.random() - 0.5) * 1.2;
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
    if (inZone && !S.running && S.hits >= S.targets.length) reset();
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
    S.targets.forEach(function (t) {
      if (t.state !== "up" && t.state !== "rising") return;
      const dx = t.x - gunW.x, dy = t.y - gunW.y;
      const d = Math.hypot(dx, dy);
      if (d > REACH) return;
      let a = Math.atan2(dy, dx) - st.yaw;
      a = ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(a) > CONE) return;
      if (d < bd) { bd = d; best = t; }
    });
    S.lock = best;
    let wantYaw = 0, wantPitch = 0;
    if (best) {
      const dx = best.x - gunW.x, dy = best.y - gunW.y;
      wantYaw = ((Math.atan2(dy, dx) - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const dz = TARGET_H * 0.62 + 0.28 - (gunW.z + 0.04);
      wantPitch = Math.atan2(dz, Math.hypot(dx, dy));
    }
    const step2 = SLEW * dt;
    S.yaw += clamp(wantYaw - S.yaw, -step2, step2);
    S.pitch += clamp(wantPitch - S.pitch, -step2, step2);
    S.ready = !!best && Math.abs(wantYaw - S.yaw) < TOL && Math.abs(wantPitch - S.pitch) < TOL;
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
    if (S.ammo <= 0 && S.reload <= 0) { S.reload = RELOAD; S.say = "Rechargement"; }

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
    active: function () { return S.on; },
    /** Ligne d'état : munitions, cibles, chrono. */
    hud: function () {
      if (!S.on) return "";
      return "Cibles " + S.hits + "/" + S.targets.length
        + " · " + (S.reload > 0 ? "rechargement" : S.ammo + " coups")
        + (S.running ? " · " + S.t.toFixed(1) + " s" : "")
        + (S.best !== null ? " · record " + S.best.toFixed(2) + " s" : "")
        + (S.ready ? " · VERROUILLÉ" : "");
    }
  };
})(window.YLO);
