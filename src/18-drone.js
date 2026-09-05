/* =====================================================================
   YLO-2 — drone de reconnaissance

   Le robot voit à vingt-deux mètres, et seulement ce qui est à découvert.
   C'est peu pour un terrain de cinquante, et c'est exactement le problème
   que résout un drone : il monte, et de là-haut un merlon n'est plus un
   masque. Ce qu'il repère entre dans la MÊME carte que ce que le robot
   repère — il n'y a qu'une mémoire, sinon il faudrait choisir laquelle
   croire.

   Deux sens de marche, et c'est tout le mode :

     · le robot désigne, le drone frappe. La tourelle tient une cible, on
       l'assigne, le drone y va et lâche sa charge. C'est ce qui permet de
       traiter ce qui est HORS de portée de l'arme, ou derrière un mur que
       la balle ne traverse pas ;
     · le drone repère, le robot élimine. Le drone balaie le terrain, les
       cibles tombent sur la carte, et on lance l'assaut : le pilote
       automatique s'occupe du chemin — gravats, porte, montée — et de la
       conduite de tir.

   Le drone ne se pose JAMAIS de lui-même. Sans tâche il tient le
   stationnaire au-dessus du robot ; à court de batterie il rentre se
   poser sur le pont, se recharge, et repart. Un drone qui atterrit parce
   qu'il n'a rien à faire est un drone qu'on oublie.
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;

  const V_MAX = 6.0;                 // vitesse de translation, m/s
  const V_TAU = 0.32;                // temps de réponse en translation, s
  const AGL = 3.10;                  // hauteur de vol au-dessus du relief, m
  const AGL_MIN = 1.60;              // garde minimale au-dessus d'un obstacle
  const CLIMB = 3.0;                 // vitesse verticale, m/s
  const DETECT = 34.0;               // portée de repérage depuis le ciel, m
  const SCAN_DT = 0.12;              // on ne relit pas la scène à chaque image
  const CHARGES = 3;                 // munitions emportées par sortie
  const DROP_R = 1.10;               // il faut être à l'aplomb pour lâcher
  const DROP_WAIT = 0.55;            // temps de stabilisation avant le largage
  /* Autonomie. Elle n'est pas là pour punir : elle est là pour que « retour
     au robot » soit une manœuvre qui arrive vraiment, et pas une option de
     menu qu'on ne prend jamais. */
  const BATT_HOVER = 0.6;            // %/s en stationnaire
  const BATT_FLY = 1.2;              // %/s en déplacement
  const BATT_LOW = 15;               // en dessous, il rentre de lui-même
  const CHARGE_RATE = 9.0;           // %/s sur le pont
  const DOCK = { x: -0.02, y: 0, z: 0.20 };   // sa place sur le dos du robot
  const LANE = 2.2;                  // pas du balayage, en portées

  const S = {
    on: false, fly: false, mode: "pont", say: "Drone au pont",
    p: null, v: null, yaw: 0, spin: 0,
    tgt: null, wait: 0, charges: CHARGES, batt: 100, landing: false, recall: false,
    scan: 0, found: 0, view: true,
    route: [], leg: 0, group: null, cam: null, rotors: []
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* --- le maillage --------------------------------------------------
     Un quadrirotor lisible de loin : une poutre en croix, quatre disques
     qui tournent, une boule de caméra sous le ventre. Il fait 42 cm de
     bras à bras — assez pour se voir à vingt mètres, assez petit pour
     tenir sur le dos du robot. */
  function build(scene) {
    if (S.group) return;
    const g = new T.Group();
    g.visible = false;
    const body = new T.Mesh(new T.BoxGeometry(0.20, 0.13, 0.07),
      Y.Mat.get("drone"));
    body.castShadow = true; body.userData.mat = "drone";
    g.add(body);
    const arms = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    arms.forEach(function (a) {
      const arm = new T.Mesh(new T.BoxGeometry(0.24, 0.022, 0.016),
        Y.Mat.get("droneArm"));
      arm.position.set(a[0] * 0.11, a[1] * 0.11, 0.006);
      arm.rotation.z = a[0] * a[1] > 0 ? 0.79 : -0.79;
      arm.userData.mat = "droneArm";
      g.add(arm);
      const pod = new T.Mesh(new T.CylinderGeometry(0.022, 0.022, 0.03, 8),
        Y.Mat.get("droneArm"));
      pod.rotation.x = Math.PI / 2;
      pod.position.set(a[0] * 0.20, a[1] * 0.20, 0.02);
      pod.userData.mat = "droneArm";
      g.add(pod);
      /* Le disque plutôt que deux pales : à la vitesse où tourne une hélice,
         c'est un disque qu'on voit, et deux pales modélisées ne donnent
         qu'un scintillement. */
      const rot = new T.Mesh(new T.CylinderGeometry(0.095, 0.095, 0.004, 16),
        Y.Mat.get("rotor"));
      rot.rotation.x = Math.PI / 2;
      rot.position.set(a[0] * 0.20, a[1] * 0.20, 0.038);
      rot.userData.mat = "rotor";
      g.add(rot); S.rotors.push(rot);
    });
    const ball = new T.Mesh(new T.SphereGeometry(0.035, 10, 8),
      Y.Mat.get("sensor"));
    ball.position.set(0.07, 0, -0.045);
    ball.userData.mat = "sensor";
    g.add(ball);
    scene.add(g);
    S.group = g;
    S.p = new T.Vector3(); S.v = new T.Vector3();
    S.cam = new T.PerspectiveCamera(64, 1.5, 0.05, 300);
    S.cam.up.set(0, 0, 1);
  }

  /* --- relief -------------------------------------------------------
     Un drone ne suit pas le sol, il suit le PLAFOND du relief : ce qui
     compte est le point le plus haut sous lui et devant lui. Sonder un
     seul point le ferait passer dans un mur qu'il n'a pas encore atteint. */
  function ceiling(x, y, ax, ay) {
    let h = 0;
    for (let i = 0; i <= 4; i++) {
      const k = i / 4;
      const px = x + (ax - x) * k, py = y + (ay - y) * k;
      const z = Y.Terrain.heightAt(px, py);
      if (z > h) h = z;
      /* Les linteaux ne comptent pas dans `heightAt` — un mur percé d'une
         porte y est un trou. Le drone doit pourtant passer AU-DESSUS : on
         relit donc les blocs qui portent un toit. */
      (Y.Terrain.current.boxes || []).forEach(function (b) {
        if (px < b.x0 - 0.3 || px > b.x1 + 0.3) return;
        if (py < b.y0 - 0.3 || py > b.y1 + 0.3) return;
        if (b.h > h) h = b.h;
      });
    }
    return h;
  }

  /** Le point où le drone doit se tenir pour surveiller (x, y). */
  function station(x, y, ax, ay) {
    return ceiling(x, y, ax === undefined ? x : ax, ay === undefined ? y : ay)
      + AGL;
  }

  /* --- la route de reconnaissance ------------------------------------
     Un balayage en créneau sur l'emprise du terrain, au pas de deux
     portées : c'est le motif qu'emploie une reconnaissance réelle, et
     c'est le seul qui garantit qu'on ne laisse pas de trou. */
  function route() {
    const bs = Y.Terrain.current.boxes || [];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    bs.forEach(function (b) {
      if (b.x0 < x0) x0 = b.x0; if (b.x1 > x1) x1 = b.x1;
      if (b.y0 < y0) y0 = b.y0; if (b.y1 > y1) y1 = b.y1;
    });
    if (!isFinite(x0)) { x0 = -6; x1 = 30; y0 = -6; y1 = 6; }
    const step = DETECT / LANE;
    const out = [];
    const ny = Math.max(1, Math.round((y1 - y0) / step));
    for (let j = 0; j <= ny; j++) {
      const y = y0 + (y1 - y0) * (ny ? j / ny : 0.5);
      const a = j % 2 ? x1 : x0, b = j % 2 ? x0 : x1;
      out.push([a, y]); out.push([b, y]);
    }
    return out;
  }

  /* --- conduite de vol ------------------------------------------------ */

  function seek(dt, wx, wy, wz, vmax) {
    const dx = wx - S.p.x, dy = wy - S.p.y;
    const d = Math.hypot(dx, dy);
    /* La consigne se ralentit à l'approche : sans cela le drone dépasse son
       point et y revient en oscillant, ce qu'aucun pilote automatique ne
       fait — il freine. */
    const v = Math.min(vmax, d * 1.7 + 0.05);
    const ux = d > 1e-4 ? dx / d : 0, uy = d > 1e-4 ? dy / d : 0;
    const k = 1 - Math.exp(-dt / V_TAU);
    S.v.x += (ux * v - S.v.x) * k;
    S.v.y += (uy * v - S.v.y) * k;
    S.p.x += S.v.x * dt; S.p.y += S.v.y * dt;

    /* L'altitude est tenue à part : elle ne se négocie pas avec la route. La
       garde au-dessus du relief est un PLANCHER — sauf à la pose, seul
       moment où l'on a le droit de descendre jusqu'au pont, et où ce
       plancher empêcherait précisément de se poser. */
    const ahead = 2.5;
    const floor = ceiling(S.p.x, S.p.y, S.p.x + S.v.x * ahead,
                          S.p.y + S.v.y * ahead) + AGL_MIN;
    const want = S.landing ? wz : Math.max(wz, floor);
    S.p.z += clamp(want - S.p.z, -CLIMB * dt, CLIMB * dt);

    if (d > 0.25) {
      const a = Math.atan2(dy, dx);
      let e = ((a - S.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      S.yaw += clamp(e, -3.2 * dt, 3.2 * dt);
    }
    return d;
  }

  /** Le point de repos : au-dessus du robot, décalé pour ne pas le masquer. */
  function keepPoint() {
    const st = Y.Motion.state;
    const bx = st.px - Math.cos(st.yaw) * 1.2, by = st.py - Math.sin(st.yaw) * 1.2;
    return [bx, by, station(bx, by)];
  }

  /* --- repérage -------------------------------------------------------
     Ce qu'il voit entre dans la carte du robot. Rien d'autre : le drone
     n'a pas sa propre mémoire, et c'est voulu — deux cartes qui ne
     disent pas la même chose, c'est une carte de trop. */
  function scan(dt) {
    S.scan -= dt;
    if (S.scan > 0) return;
    S.scan = SCAN_DT;
    const n = Y.Range.spot(S.p.x, S.p.y, S.p.z, DETECT);
    if (n) { S.found += n; S.say = "Repéré " + S.found + " cible" + (S.found > 1 ? "s" : ""); }
  }

  /* --- la frappe ------------------------------------------------------ */

  function drop() {
    const t = S.tgt;
    S.charges--;
    Y.Range.strike(t.x, t.y, Y.Range.aimZ(t) - 0.15);
    S.tgt = null; S.wait = 0;
    S.say = S.charges > 0
      ? "Charge larguée — " + S.charges + " restante" + (S.charges > 1 ? "s" : "")
      : "Charges épuisées — retour";
    S.mode = S.charges > 0 ? "garde" : "retour";
  }

  /* --- le pas de temps ------------------------------------------------ */

  function step(dt) {
    if (!S.on || !S.group) return;
    /* Il n'est VISIBLE qu'en vol. Posé sur le pont, il se tenait juste
       derrière la tourelle, pile dans l'axe de la caméra de l'arme : un
       quadrirotor en travers du viseur au champ de tir. Rangé, un drone est
       rangé — il ne réapparaît qu'au décollage. Le reste continue de tourner
       en coulisse : la recharge, la batterie, les charges. */
    S.group.visible = S.fly;

    // les hélices tournent tant qu'il est en l'air : c'est ce qui le fait vivre
    S.spin += dt * (S.fly ? 62 : 0);
    S.rotors.forEach(function (r, i) {
      r.rotation.y = S.spin * (i % 2 ? -1 : 1);
    });

    if (!S.fly) {
      /* Au pont : il colle au dos du robot et se recharge. On lit la pose du
         robot dans le MONDE plutôt que d'accrocher le drone à la caisse —
         il doit pouvoir décoller sans changer de parent au milieu d'une
         image. */
      const st = Y.Motion.state;
      const c = Math.cos(st.yaw), s = Math.sin(st.yaw);
      S.p.set(st.px + DOCK.x * c - DOCK.y * s,
              st.py + DOCK.x * s + DOCK.y * c,
              st.z + DOCK.z);
      S.yaw = st.yaw;
      S.v.set(0, 0, 0);
      if (S.batt < 100) {
        S.batt = Math.min(100, S.batt + CHARGE_RATE * dt);
        if (S.batt >= 100) { S.charges = CHARGES; S.say = "Drone paré"; }
        else S.say = "Recharge " + S.batt.toFixed(0) + " %";
      }
      place();
      return;
    }

    /* En vol, la batterie descend — plus vite quand il se déplace. Sous le
       seuil, il rentre : la décision lui appartient, pas au pilote. */
    const moving = S.v.lengthSq() > 0.4;
    S.batt = Math.max(0, S.batt - (moving ? BATT_FLY : BATT_HOVER) * dt);
    if (S.batt <= BATT_LOW && S.mode !== "retour") {
      S.mode = "retour"; S.tgt = null; S.landing = false;
      S.say = "Batterie basse — retour au robot";
      Y.Audio.raise();
    }

    scan(dt);

    if (S.mode === "frappe" && S.tgt) {
      if (S.tgt.state === "down" || S.tgt.friend) {
        S.tgt = null; S.mode = "garde"; S.say = "Cible neutralisée";
      } else {
        const z = station(S.tgt.x, S.tgt.y) - 0.6;
        const d = seek(dt, S.tgt.x, S.tgt.y, z, V_MAX);
        if (d < DROP_R) {
          S.wait += dt;
          S.say = "À l'aplomb — largage dans " + Math.max(0, DROP_WAIT - S.wait).toFixed(1) + " s";
          if (S.wait >= DROP_WAIT) drop();
        } else { S.wait = 0; S.say = "En approche — " + d.toFixed(0) + " m"; }
      }
    } else if (S.mode === "recon") {
      const w = S.route[S.leg];
      if (!w) { S.mode = "garde"; S.say = "Reconnaissance terminée"; Y.Audio.done(); }
      else {
        const d = seek(dt, w[0], w[1], station(w[0], w[1]), V_MAX);
        if (d < 1.6) S.leg++;
        S.say = "Reconnaissance " + (S.leg + 1) + "/" + S.route.length
          + " · " + S.found + " repérées";
      }
    } else if (S.mode === "retour") {
      /* Le point de POSE est le pont lui-même, pas le stationnaire : viser le
         point de garde faisait tourner le drone à un mètre de son berceau
         sans jamais le trouver — il rattrapait la distance juste assez pour
         que la condition de descente ne tienne jamais deux images de suite. */
      const st = Y.Motion.state;
      const c = Math.cos(st.yaw), sn = Math.sin(st.yaw);
      const dx = st.px + DOCK.x * c - DOCK.y * sn;
      const dy = st.py + DOCK.x * sn + DOCK.y * c;
      const dz = st.z + DOCK.z;
      const d = seek(dt, dx, dy, S.landing ? dz : station(dx, dy), V_MAX);
      if (d < 1.4 && (S.recall || S.batt <= BATT_LOW)) S.landing = true;
      if (S.landing) {
        S.say = "Pose en cours";
        if (d < 0.6 && Math.abs(S.p.z - dz) < 0.14) {
          S.fly = false; S.landing = false; S.recall = false; S.mode = "pont";
          S.say = "Posé — recharge"; Y.Audio.hold();
        }
      } else if (d < 1.2) { S.mode = "garde"; }
      else S.say = "Retour au robot — " + d.toFixed(0) + " m";
    } else {
      /* Garde : stationnaire au-dessus du robot. Il SUIT, mais il ne se pose
         pas — un drone en garde reste une paire d'yeux en l'air. */
      const k = keepPoint();
      const d = seek(dt, k[0], k[1], k[2], V_MAX * 0.8);
      if (d < 1.2) S.say = "Stationnaire · " + S.batt.toFixed(0) + " %";
      else S.say = "En suivi · " + S.batt.toFixed(0) + " %";
    }

    place();
  }

  /** Poser le maillage et la caméra là où le vol les a menés. */
  function place() {
    S.group.position.copy(S.p);
    /* Une inclinaison proportionnelle à la vitesse : un quadrirotor avance en
       se penchant, et sans ce détail il glisse comme un ascenseur. */
    const c = Math.cos(-S.yaw), s = Math.sin(-S.yaw);
    const fx = S.v.x * c - S.v.y * s, fy = S.v.x * s + S.v.y * c;
    S.group.rotation.set(clamp(fy * 0.09, -0.35, 0.35),
                         clamp(-fx * 0.09, -0.35, 0.35), S.yaw, "ZYX");

    const cam = S.cam;
    cam.position.set(S.p.x, S.p.y, S.p.z - 0.05);
    if (S.tgt && S.mode === "frappe") {
      cam.lookAt(S.tgt.x, S.tgt.y, Y.Range.aimZ(S.tgt));
    } else {
      /* Le regard porte devant et vers le bas : une caméra de drone qui
         regarde l'horizon ne montre que le ciel, et c'est le sol qu'on
         cherche. */
      const look = 10;
      cam.lookAt(S.p.x + Math.cos(S.yaw) * look,
                 S.p.y + Math.sin(S.yaw) * look,
                 S.p.z - look * 0.62);
    }
  }

  /* --- commandes ------------------------------------------------------ */

  function launch() {
    if (!S.on) return false;
    if (S.fly) {
      /* Le rappel n'est pas un atterrissage immédiat : il rentre, et il se
         pose. On ne coupe pas les moteurs d'un drone à trente mètres. */
      S.mode = "retour"; S.recall = true; S.landing = false;
      S.tgt = null; S.say = "Rappel — retour au pont";
      Y.Audio.hold();
      return true;
    }
    if (S.batt < 20) { S.say = "Batterie insuffisante — recharge en cours"; return false; }
    S.fly = true; S.mode = "garde"; S.tgt = null; S.recall = false;
    S.route = route(); S.leg = 0;
    S.say = "Drone en vol";
    Y.Audio.raise();
    return true;
  }

  function task() {
    if (!S.on) return false;
    if (!S.fly) { S.say = "Drone au pont — lancez-le d'abord"; return false; }
    if (S.mode === "recon") { S.mode = "garde"; S.say = "Reconnaissance suspendue"; }
    else {
      S.mode = "recon";
      if (S.leg >= S.route.length) { S.route = route(); S.leg = 0; }
      S.say = "Reconnaissance en cours";
    }
    Y.Audio.lock();
    return true;
  }

  /** Le robot désigne, le drone frappe : la cible que tient la tourelle. */
  function assign() {
    if (!S.on) return false;
    const t = Y.Range.aimed();
    if (!t) { S.say = "Aucune cible désignée par le robot"; return false; }
    if (!S.fly && !launch()) return false;
    if (S.charges <= 0) { S.say = "Plus de charge — rappelez le drone"; return false; }
    S.tgt = t; S.mode = "frappe"; S.wait = 0;
    S.say = "Cible assignée au drone";
    Y.Audio.ping();
    return true;
  }

  /** Le drone repère, le robot élimine : on lance l'assaut. */
  function assault() {
    if (!S.on) return false;
    const seen = Y.Range.list().filter(function (t) {
      return t.seen && !t.friend && t.state !== "down" && t.state !== "falling";
    }).length;
    if (!seen) { S.say = "Rien de repéré — envoyez le drone en reconnaissance"; return false; }
    if (Y.Range.autopilot()) { Y.Range.sweep(); S.say = "Assaut interrompu"; return true; }
    Y.Range.sweep();
    S.say = "Assaut : " + seen + " cible" + (seen > 1 ? "s" : "") + " à traiter";
    return true;
  }

  const vMark = new T.Vector3();

  Y.Drone = {
    state: S,
    build: build,
    step: step,
    launch: launch,
    task: task,
    assign: assign,
    assault: assault,
    view: function () { S.view = !S.view; return S.view; },

    set: function (cfg) {
      /* Le drone est un équipement du robot, pas un décor : il est là dès
         qu'il y a une conduite de tir — champ de tir, défense, ou terrain
         de reconnaissance. */
      S.on = !!cfg;
      S.fly = false; S.mode = "pont"; S.tgt = null; S.wait = 0;
      S.charges = CHARGES; S.batt = 100; S.found = 0; S.leg = 0;
      S.landing = false; S.recall = false;
      S.route = S.on ? route() : [];
      S.say = S.on ? "Drone au pont — ↑ pour décoller" : "";
      S.view = true;
      if (S.group) S.group.visible = false;   // rangé tant qu'il n'a pas décollé
      if (S.on && S.group) {
        S.group.traverse(function (c) {
          if (c.userData.mat) c.material = Y.Mat.get(c.userData.mat);
        });
      }
    },

    active: function () { return S.on; },
    flying: function () { return S.on && S.fly; },
    /** La caméra du drone — seulement quand il vole et qu'on veut la voir. */
    camera: function () { return S.on && S.fly && S.view ? S.cam : null; },

    /** Les repères à poser sur la vue du drone : tout ce qui est debout. */
    marks: function () {
      if (!S.on || !S.fly || !S.cam) return [];
      const out = [];
      Y.Range.list().forEach(function (t) {
        if (t.state === "down" || t.state === "falling") return;
        vMark.set(t.x, t.y, Y.Range.aimZ(t)).project(S.cam);
        if (vMark.z > 1) return;
        if (Math.abs(vMark.x) > 1.1 || Math.abs(vMark.y) > 1.1) return;
        out.push({ x: vMark.x, y: vMark.y, on: t === S.tgt, friend: t.friend,
                   seen: t.seen,
                   far: Math.hypot(t.x - S.p.x, t.y - S.p.y) });
      });
      return out;
    },

    /** Pour la carte : où il est, où il regarde, et ce qu'il vise. */
    map: function () {
      if (!S.on) return null;
      return { x: S.p.x, y: S.p.y, yaw: S.yaw, fly: S.fly,
               tgt: S.tgt ? { x: S.tgt.x, y: S.tgt.y } : null,
               reach: DETECT };
    },

    /** Le bandeau de la vignette. */
    hud: function () {
      if (!S.on) return null;
      const label = { pont: "AU PONT", garde: "GARDE", recon: "RECON",
                      frappe: "FRAPPE", retour: "RETOUR" }[S.mode] || "";
      return { fly: S.fly, mode: label, say: S.say, batt: S.batt,
               charges: S.charges, found: S.found,
               alt: S.fly ? S.p.z - Y.Terrain.heightAt(S.p.x, S.p.y) : 0 };
    }
  };
})(window.YLO);
