/* =====================================================================
   YLO-2 — défense de zone

   Le champ de tir demandait d'aller chercher des cibles qui attendaient.
   Ici c'est l'inverse : une zone à tenir, et des adversaires qui viennent
   de partout. Tout le reste — visée automatique, ligne de vue, réticule,
   repères, désignation à R1, pilote automatique sur PS — ne change pas
   d'une ligne, parce qu'un ennemi EST une cible du stand. Réécrire une
   seconde conduite de tir pour un second type d'adversaire garantirait
   qu'elles divergent.

   Ce que ce module ajoute, et rien de plus :

     · la ZONE, posée d'un clic sur la scène ou sur la carte ;
     · des VAGUES d'ennemis qui naissent au bord de l'arène, marchent vers
       la zone, s'arrêtent à portée et tirent ;
     · deux BARRES DE SANTÉ, celle de la zone et celle du robot ;
     · et, quand le robot est à bout, le CHOIX DE LA FIN — se jeter sur un
       ennemi, se poser en mine, ou se replier.

   Le tir ennemi est un lancer de rayon comme celui du robot, et il obéit à
   la même géométrie : un mur arrête une balle ennemie exactement comme il
   arrête la nôtre. Les blocs du centre sont donc des abris pour tout le
   monde, ce qui est la seule façon honnête de les rendre intéressants.
   ===================================================================== */
(function (Y) {
  "use strict";

  const T = window.THREE;

  const R_ZONE = 3.2;                 // rayon de la zone à tenir, m
  const SPAWN_R = 19.0;               // les ennemis naissent au bord
  const FOE_V = 1.15;                 // leur vitesse d'approche, m/s
  const FOE_STOP = 7.5;               // ils s'arrêtent à cette distance de la zone
  const FOE_REACH = 11.0;             // portée de leur tir
  const FOE_RATE = 2.3;               // s entre deux de leurs coups
  const FOE_SPREAD = 3.2;             // leur dispersion, degrés
  const DMG_ZONE = 3;                 // dégâts d'un coup au but sur la zone
  const DMG_BOT = 6;                  // dégâts d'un coup au but sur le robot
  const ZONE_HP = 100, BOT_HP = 100;
  const WAVE_GAP = 9.0;               // s entre deux vagues
  const FOE_MAX = 8;                  // au-delà, on ne fait plus naître personne
  const GUARD_R = 12.0;               // la laisse du pilote automatique

  /** Combien d'ennemis on tolère en même temps, selon l'avancement. */
  function cap() { return Math.min(14, FOE_MAX + Math.floor(S.wave / 3)); }
  const KAMIKAZE_V = 3.2;             // le dernier élan, m/s
  const BLAST_R = 4.2;                // rayon de la charge du robot

  const S = {
    on: false, placed: false, cx: 0, cy: 0, r: R_ZONE,
    zoneHP: ZONE_HP, botHP: BOT_HP,
    foes: [], wave: 0, next: 0, t: 0,
    over: false, choice: "", ending: "", endT: 0,
    say: "Placez la zone à protéger", kills: 0,
    ring: null, group: null, tracers: []
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* --- la couronne au sol qui marque la zone ------------------------ */

  function buildRing(scene) {
    if (S.group) return;
    S.group = new T.Group();
    S.group.visible = false;
    scene.add(S.group);
    const ring = new T.Mesh(new T.RingGeometry(R_ZONE - 0.12, R_ZONE, 48),
      new T.MeshBasicMaterial({ color: 0x2f9bd8, transparent: true, opacity: 0.85,
        side: T.DoubleSide, depthWrite: false }));
    const disc = new T.Mesh(new T.CircleGeometry(R_ZONE, 48),
      new T.MeshBasicMaterial({ color: 0x2f9bd8, transparent: true, opacity: 0.10,
        side: T.DoubleSide, depthWrite: false }));
    const pole = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 1.6, 10),
      new T.MeshBasicMaterial({ color: 0x2f9bd8 }));
    pole.rotation.x = Math.PI / 2; pole.position.z = 0.8;
    S.ring = new T.Group();
    S.ring.add(ring, disc, pole);
    S.group.add(S.ring);
  }

  /* --- placer la zone ------------------------------------------------ */

  function place(x, y) {
    if (!S.on) return false;
    S.cx = x; S.cy = y; S.placed = true;
    const z = Y.Terrain.heightAt(x, y);
    S.ring.position.set(x, y, z + 0.02);
    S.group.visible = true;
    S.zoneHP = ZONE_HP; S.botHP = BOT_HP;
    S.wave = 0; S.next = 2.5; S.t = 0; S.kills = 0;
    /* Le pilote automatique reçoit sa consigne : garder CECI, et ne pas
       s'en éloigner de plus que ça. */
    Y.Range.guard(x, y, GUARD_R);
    S.over = false; S.choice = ""; S.ending = "";
    clearFoes();
    Y.Range.arm();
    S.say = "Zone posée — tenez-la";
    Y.Audio.hold();
    return true;
  }

  function clearFoes() {
    S.foes.forEach(function (f) { Y.Range.despawn(f.t); });
    S.foes.length = 0;
  }

  /* --- les vagues ---------------------------------------------------- */

  function wave() {
    S.wave++;
    /* Le nombre monte, mais lentement : ce qui rend une vague dure n'est pas
       la foule, c'est qu'elle arrive de plusieurs côtés à la fois. */
    const n = Math.min(cap() - S.foes.length, Math.min(6, 2 + Math.floor(S.wave * 0.5)));
    if (n <= 0) return;
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      /* Réparties sur le tour, avec du jeu : deux ennemis exactement opposés
         se prennent l'un l'autre dans le dos du robot, et c'est le sel. */
      const a = base + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
      const rr = SPAWN_R + (Math.random() - 0.5) * 2.0;
      const x = S.cx + Math.cos(a) * rr, y = S.cy + Math.sin(a) * rr;
      const t = Y.Range.spawn(x, y, Y.Terrain.heightAt(x, y), true);
      if (t) S.foes.push({ t: t, fire: 1.0 + Math.random(), a: a });
    }
    S.say = "Vague " + S.wave + " — " + n + " ennemis";
    Y.Audio.raise();
  }

  /* --- leur tir ------------------------------------------------------ */

  const v0 = new T.Vector3(), v1 = new T.Vector3();

  function foeShoot(f) {
    const st = Y.Motion.state;
    const gz = Y.Terrain.heightAt(f.t.x, f.t.y) + 0.75;
    v0.set(f.t.x, f.t.y, gz);
    /* Ils tirent sur le ROBOT quand ils le voient, sinon sur la zone. Un
       ennemi qui viserait toujours la zone se ferait démolir sans réagir ;
       un ennemi qui viserait toujours le robot ne menacerait jamais ce
       qu'on défend. Le choix se fait sur ce qui est à découvert. */
    const seeBot = !Y.Terrain.blocked(v0.x, v0.y, v0.z, st.px, st.py, st.z + 0.05, 0.4)
      && Math.hypot(st.px - f.t.x, st.py - f.t.y) < FOE_REACH;
    const tx = seeBot ? st.px : S.cx, ty = seeBot ? st.py : S.cy;
    const tz = seeBot ? st.z + 0.05 : Y.Terrain.heightAt(S.cx, S.cy) + 0.6;
    const d = Math.hypot(tx - v0.x, ty - v0.y);
    if (!seeBot && d > FOE_REACH + 4) return;

    // dispersion : ils ne sont pas des snipers
    const sp = FOE_SPREAD * Math.PI / 180;
    const yaw = Math.atan2(ty - v0.y, tx - v0.x) + (Math.random() - 0.5) * 2 * sp;
    const pit = Math.atan2(tz - v0.z, d) + (Math.random() - 0.5) * 2 * sp;
    const dir = new T.Vector3(Math.cos(pit) * Math.cos(yaw),
                              Math.cos(pit) * Math.sin(yaw), Math.sin(pit));
    const wall = Y.Terrain.hitDist(v0.x, v0.y, v0.z,
      v0.x + dir.x * FOE_REACH, v0.y + dir.y * FOE_REACH, v0.z + dir.z * FOE_REACH, 0.4);
    const reach = wall < 0 ? FOE_REACH : wall;
    v1.copy(v0).addScaledVector(dir, reach);

    // touché ? on compare l'écart du rayon à la cible visée
    let hit = false;
    if (wall < 0 || wall > d - 0.4) {
      const ox = tx - v0.x, oy = ty - v0.y, oz = tz - v0.z;
      const along = ox * dir.x + oy * dir.y + oz * dir.z;
      const px = ox - dir.x * along, py = oy - dir.y * along, pz = oz - dir.z * along;
      hit = Math.hypot(px, py, pz) < (seeBot ? 0.30 : S.r * 0.8);
    }
    if (hit) {
      if (seeBot) hurtBot(DMG_BOT);
      else { S.zoneHP = Math.max(0, S.zoneHP - DMG_ZONE); Y.Audio.hit(); }
    }
    S.tracers.push({ a: v0.clone(), b: v1.clone(), t: 0 });
    Y.Audio.shot();
  }

  function hurtBot(n) {
    if (S.over) return;
    S.botHP = Math.max(0, S.botHP - n);
    Y.Audio.hit();
    if (S.botHP <= 0) {
      S.over = true; S.choice = "";
      S.say = "Systèmes critiques — choisissez la fin";
      Y.Audio.done();
    }
  }

  /* --- la fin, et ses trois portes ---------------------------------- */

  /**
   * Le robot n'a plus de vie. Il ne meurt pas tout seul : il PROPOSE.
   *
   * Les trois sorties ne se valent pas et c'est voulu. Le kamikaze paie un
   * ennemi comptant, la mine en paie peut-être plusieurs mais il faut qu'ils
   * viennent, le repli n'en paie aucun mais laisse la zone tenir un peu plus
   * longtemps sans le robot pour attirer les tirs. Il n'y a pas de bon choix,
   * seulement un choix.
   */
  function choose(kind) {
    if (!S.over || S.ending) return false;
    S.ending = kind; S.endT = 0; S.choice = kind;
    S.say = kind === "kamikaze" ? "Kamikaze — dernier élan"
      : kind === "mine" ? "Mode mine — armé, en attente"
      : "Repli — systèmes en veille";
    Y.Audio.hold();
    return true;
  }

  function blast(x, y) {
    const p = new T.Vector3(x, y, Y.Terrain.heightAt(x, y) + 0.3);
    let n = 0;
    for (let i = S.foes.length - 1; i >= 0; i--) {
      const f = S.foes[i];
      if (Math.hypot(f.t.x - x, f.t.y - y) > BLAST_R) continue;
      Y.Range.despawn(f.t); S.foes.splice(i, 1); n++;
    }
    S.kills += n;
    Y.Audio.blast();
    S.say = n ? "Explosion — " + n + " ennemi" + (n > 1 ? "s" : "") + " emporté"
                + (n > 1 ? "s" : "") : "Explosion — personne";
    S.ending = "fini";
    return n;
  }

  /* --- pas de temps -------------------------------------------------- */

  function step(dt) {
    if (!S.on) return;
    const st = Y.Motion.state;

    // les traceurs ennemis s'éteignent comme les nôtres
    for (let i = S.tracers.length - 1; i >= 0; i--) {
      const tr = S.tracers[i];
      tr.t += dt;
      if (tr.t > 0.10) {
        if (tr.line) { S.group.remove(tr.line); tr.line.geometry.dispose(); }
        S.tracers.splice(i, 1); continue;
      }
      if (!tr.line) {
        tr.line = new T.Line(new T.BufferGeometry().setFromPoints([tr.a, tr.b]),
          new T.LineBasicMaterial({ color: 0xff5a44, transparent: true, opacity: 0.9 }));
        S.group.add(tr.line);
      }
      tr.line.material.opacity = 0.9 * (1 - tr.t / 0.10);
    }

    if (!S.placed) return;
    S.t += dt;

    /* La couronne bat au rythme de ce qu'il lui reste : discrète tant que
       tout va bien, insistante quand elle est entamée. */
    const life = S.zoneHP / ZONE_HP;
    S.ring.children[0].material.opacity =
      0.55 + 0.35 * Math.sin(S.t * (2 + (1 - life) * 10));
    S.ring.children[0].material.color.setHSL(0.55 * life, 0.75, 0.5);
    S.ring.children[1].material.color.setHSL(0.55 * life, 0.75, 0.5);

    /* --- la fin, si elle est engagée ---
       Les ennemis, eux, CONTINUENT : ils avancent et ils tirent pendant que
       le robot joue sa dernière carte. Les figer pendant une fin vidait le
       mode mine de tout son sens — personne ne venait jamais se poser
       dessus, et l'on attendait vingt secondes pour rien. En revanche plus
       aucune vague ne naît : ce qui est là est là. */
    if (S.ending && S.ending !== "fini") {
      stepFoes(dt, true);
      stepEnding(dt);
      return;
    }
    if (S.over) { stepFoes(dt, true); return; }   // on attend le choix

    if (S.zoneHP <= 0) {
      S.over = true; S.ending = "fini";
      S.say = "Zone perdue — vague " + S.wave + ", " + S.kills + " ennemis abattus";
      Y.Audio.blast();
      return;
    }

    stepFoes(dt, false);
  }

  /** Les ennemis : ils naissent, ils avancent, ils s'arrêtent et ils tirent. */
  function stepFoes(dt, endgame) {
    const st = Y.Motion.state;
    S.next -= dt;
    /* La pression MONTE : les vagues se rapprochent et grossissent. Sans
       escalade, une défense bien tenue durerait indéfiniment et l'on ne
       verrait jamais la fin — or c'est la fin qui est intéressante. Pendant
       une fin engagée, en revanche, plus personne n'arrive : ce qui est là
       est là, et c'est avec ça qu'on joue sa dernière carte. */
    if (!endgame && S.next <= 0 && S.foes.length < cap()) {
      wave();
      S.next = Math.max(4.0, WAVE_GAP - S.wave * 0.35);
    }

    for (let i = S.foes.length - 1; i >= 0; i--) {
      const f = S.foes[i];
      if (f.t.state === "down" || f.t.state === "falling") {
        Y.Range.despawn(f.t); S.foes.splice(i, 1); S.kills++;
        S.say = S.kills + " ennemis abattus · vague " + S.wave;
        continue;
      }
      const dx = S.cx - f.t.x, dy = S.cy - f.t.y;
      const d = Math.hypot(dx, dy);
      /* Le robot hors jeu, plus rien ne les retient : ils entrent DANS la
         zone au lieu de la tirer de loin. C'est ce qui donne son sens au
         mode mine — il faut qu'ils viennent — et son prix au repli. */
      const stop = S.over ? 1.8 : FOE_STOP;
      if (d > stop) {
        /* Ils marchent vers la zone en contournant ce qui les gêne : le même
           balayage d'angle que le pilote automatique du robot, en plus
           simple — ils n'ont qu'à trouver un cap qui passe. */
        let a = Math.atan2(dy, dx);
        const z = Y.Terrain.heightAt(f.t.x, f.t.y) + 0.5;
        for (let k = 0; k < 9; k++) {
          const off = (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.35);
          const c = a + off;
          if (!Y.Terrain.blocked(f.t.x, f.t.y, z,
                f.t.x + Math.cos(c) * 2.2, f.t.y + Math.sin(c) * 2.2, z, 0.05)) {
            a = c; break;
          }
        }
        Y.Range.moveTarget(f.t, f.t.x + Math.cos(a) * FOE_V * dt,
                                f.t.y + Math.sin(a) * FOE_V * dt);
      } else {
        f.fire -= dt;
        if (f.fire <= 0) { foeShoot(f); f.fire = FOE_RATE * (0.75 + Math.random() * 0.5); }
      }
    }
  }

  /**
   * Un cap qui passe, vers un point donné.
   *
   * Les blocs du centre font 550 mm : ce sont des murs pour une roue qui en
   * franchit 450. Un dernier élan qui va taper dedans n'est pas un dernier
   * élan, c'est une panne — le kamikaze mettait vingt-cinq secondes à ne
   * tuer personne. On balaie donc l'angle comme le fait le pilote
   * automatique, en gardant l'écart le plus faible qui passe.
   */
  function steer(st, tx, ty, span) {
    const want = Math.atan2(ty - st.py, tx - st.px);
    const z = Y.Terrain.heightAt(st.px, st.py) + 0.25;
    const d = Math.min(span || 3.0, Math.max(1.0, Math.hypot(tx - st.px, ty - st.py)));
    for (let i = 0; i < 15; i++) {
      const off = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.26;
      const a = want + off;
      let free = true;
      for (let sgn = -1; sgn <= 1 && free; sgn++) {
        const nx = -Math.sin(a) * 0.26 * sgn, ny = Math.cos(a) * 0.26 * sgn;
        if (Y.Terrain.blocked(st.px + nx, st.py + ny, z,
              st.px + nx + Math.cos(a) * d, st.py + ny + Math.sin(a) * d, z, 0.05)) {
          free = false;
        }
      }
      if (free) return a;
    }
    return want;
  }

  /** Les trois fins, une fois choisies. */
  function stepEnding(dt) {
    const st = Y.Motion.state;
    S.endT += dt;
    if (S.ending === "repli") {
      /* Repli : le robot se met en veille. Il ne tire plus, il ne bouge plus,
         et les ennemis cessent de le viser — la zone tient seule ce qu'elle
         peut tenir. */
      st.vx = 0; st.wz = 0;
      Y.Natural.setBrake(true);
      if (S.endT > 1.2) { S.ending = "fini"; S.say = "Replié — la zone tient seule"; }
      return;
    }
    if (S.ending === "mine") {
      /* Mine : le robot se traîne au CENTRE de ce qu'il défendait, puis ne
         bouge plus. On ne mine pas n'importe où — on mine ce que l'autre
         vient chercher, et c'est la seule position où l'attente a un sens. */
      const dz = Math.hypot(S.cx - st.px, S.cy - st.py);
      if (dz > 0.6 && S.endT < 8) {
        const a = steer(st, S.cx, S.cy);
        let e = ((a - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        st.wz = clamp(e * 2.6, -1.8, 1.8);
        st.vx = 1.1 * (1 - Math.min(1, Math.abs(e) / 1.3) * 0.7);
        Y.Natural.setBrake(false);
        S.say = "Mode mine — en place";
      } else {
        st.vx = 0; st.wz = 0;
        Y.Natural.setBrake(true);
        S.say = "Mode mine — armé, en attente";
      }
      const near = S.foes.some(function (f) {
        return Math.hypot(f.t.x - st.px, f.t.y - st.py) < BLAST_R * 0.8;
      });
      if (near || S.endT > 22) blast(st.px, st.py);
      return;
    }
    // kamikaze : on fonce sur le plus proche, et on saute au contact
    let best = null, bd = Infinity;
    S.foes.forEach(function (f) {
      const d = Math.hypot(f.t.x - st.px, f.t.y - st.py);
      if (d < bd) { bd = d; best = f; }
    });
    if (!best) { blast(st.px, st.py); return; }
    const a = steer(st, best.t.x, best.t.y);
    let e = ((a - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    st.wz = clamp(e * 3.0, -2.2, 2.2);
    st.vx = KAMIKAZE_V * (1 - Math.min(1, Math.abs(e) / 1.4) * 0.6);
    Y.Natural.setBrake(false);
    if (bd < 1.1 || S.endT > 25) blast(st.px, st.py);
  }

  Y.Defense = {
    state: S,
    build: buildRing,
    place: place,
    choose: choose,
    step: step,

    set: function (cfg) {
      S.on = !!(cfg && cfg.defense);
      if (!S.on && Y.Range) Y.Range.guard(null);
      if (S.group) S.group.visible = false;
      S.placed = false; S.over = false; S.ending = ""; S.choice = "";
      S.zoneHP = ZONE_HP; S.botHP = BOT_HP;
      S.foes.length = 0; S.wave = 0; S.kills = 0; S.t = 0;
      S.say = S.on ? "Placez la zone à protéger — clic sur la scène ou la carte" : "";
      if (S.on && S.ring) {
        [0, 1].forEach(function (i) {
          S.ring.children[i].material.color.set(0x2f9bd8);
        });
      }
    },

    active: function () { return S.on; },
    awaiting: function () { return S.on && !S.placed; },
    /** Le robot est-il à bout, et attend-il qu'on choisisse sa fin ? */
    asking: function () { return S.on && S.over && !S.ending; },
    /** Le robot a-t-il rendu les armes ? */
    finished: function () { return S.on && S.ending === "fini"; },
    /** Le pilote n'a plus la main pendant une fin engagée. */
    scripted: function () { return S.on && S.ending && S.ending !== "fini"; },

    /** Ce que le bandeau affiche : deux barres et une ligne. */
    hud: function () {
      if (!S.on) return null;
      return { placed: S.placed, zone: S.zoneHP / ZONE_HP, bot: S.botHP / BOT_HP,
               wave: S.wave, kills: S.kills, foes: S.foes.length,
               say: S.say, asking: S.on && S.over && !S.ending, end: S.ending };
    },

    /** Pour la carte : la zone et les ennemis repérés. */
    map: function () {
      if (!S.on || !S.placed) return null;
      return { cx: S.cx, cy: S.cy, r: S.r, life: S.zoneHP / ZONE_HP };
    },

    /** Dégâts pris autrement qu'au tir — le module de tir peut y recourir. */
    hurt: hurtBot
  };
})(window.YLO);
