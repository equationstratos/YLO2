/* =====================================================================
   YLO-2 — la boule du skatepark

   Un objet qui n'est ni le robot ni le décor : une boule que le robot
   pousse. Elle a sa propre inertie, elle roule, elle ralentit, elle
   redescend les pentes et elle rebondit sur ce qu'elle ne peut pas
   franchir.

   Son rayon — 260 mm — n'est pas décoratif : la caisse du robot roule à
   300 mm du sol, et une boule plus petite passerait dessous au lieu
   d'être poussée. À cette taille, elle arrive à hauteur de tronc et il
   n'y a pas d'autre issue que de la pousser.
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;

  const R = 0.26;                    // rayon de la boule
  const ROBOT_R = 0.21;              // empreinte du robot, vue de dessus
  const ROLL_DRAG = 0.85;            // s⁻¹ : une boule roule loin, pas indéfiniment
  const G = 9.81;
  const PUSH = 1.35;                 // ce que la boule prend de la poussée

  const S = {
    on: false, x: 0, y: 0, z: R, vx: 0, vy: 0,
    group: null, mesh: null, home: [0, 0]
  };

  function build(scene) {
    if (S.group) return;
    const g = new T.Group();
    const ball = new T.Mesh(new T.SphereGeometry(R, 28, 20), Y.Mat.get("ball"));
    ball.castShadow = true; ball.receiveShadow = true;
    ball.userData.mat = "ball";
    g.add(ball);
    /* Trois ceintures sombres, sur les trois axes. Sans repère, une sphère
       lisse tourne sans qu'on le voie — et tout l'intérêt est justement de la
       voir rouler. Trois et non deux : deux ceintures posées sur le même axe
       se confondent, et la boule paraissait unie. */
    [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]].forEach(function (r) {
      const band = new T.Mesh(new T.TorusGeometry(R * 0.99, R * 0.06, 8, 40),
        Y.Mat.get("ballBand"));
      band.rotation.set(r[0], r[1], r[2]);
      band.userData.mat = "ballBand";
      g.add(band);
    });
    g.visible = false;
    scene.add(g);
    S.group = g; S.mesh = g;
  }

  function groundAt(x, y) {
    return Y.Terrain && Y.Terrain.heightAt ? Y.Terrain.heightAt(x, y) : 0;
  }

  /** Poser la boule, ou la retirer. `at` vaut [x, y] ou rien. */
  function set(at) {
    S.on = !!at;
    if (S.group) {
      S.group.visible = S.on;
      /* Les matières sont réglées APRÈS la construction de la scène : prises
         à la construction, elles étaient encore blanches et la boule sortait
         unie, ceintures comprises. On les relit ici, comme le fait le terrain
         à chaque reconstruction. */
      S.group.children.forEach(function (c) {
        if (c.userData.mat) c.material = Y.Mat.get(c.userData.mat);
      });
    }
    if (!at) return;
    S.home = [at[0], at[1]];
    reset();
  }

  function reset() {
    S.x = S.home[0]; S.y = S.home[1];
    S.z = groundAt(S.x, S.y) + R;
    S.vx = 0; S.vy = 0;
    if (S.group) {
      S.group.position.set(S.x, S.y, S.z);
      S.group.quaternion.identity();
    }
  }

  const axis = new T.Vector3();

  function step(dt) {
    if (!S.on || !S.group) return;

    /* --- poussée du robot ---
       Le robot est vu de dessus comme un disque : c'est assez pour dire s'il
       touche la boule et de quel côté. On la chasse hors du recouvrement et
       on lui donne la part de vitesse du robot dirigée vers elle — une boule
       ne prend pas ce qui la frôle, elle prend ce qui la pousse. */
    const st = Y.Motion.state;
    const dx = S.x - st.px, dy = S.y - st.py;
    const d = Math.hypot(dx, dy);
    const reach = R + ROBOT_R;
    if (d < reach && d > 1e-6 && Math.abs(st.z - S.z) < R + 0.30) {
      const nx = dx / d, ny = dy / d;
      S.x += nx * (reach - d); S.y += ny * (reach - d);
      const rv = Y.Natural.state.vx * (Y.Natural.state.dir || 1);
      const push = (Math.cos(st.yaw) * nx + Math.sin(st.yaw) * ny) * rv;
      if (push > 0) {
        S.vx += nx * push * PUSH * Math.min(1, dt * 30);
        S.vy += ny * push * PUSH * Math.min(1, dt * 30);
      }
    }

    /* --- pente et frottement ---
       La boule descend ce qui descend : on lit la pente du champ de hauteurs
       sous elle et on l'accélère dedans. C'est la même gravité de pente que
       celle du robot en roue libre, sans l'effet de pompage. */
    const e = 0.12;
    const gx = (groundAt(S.x + e, S.y) - groundAt(S.x - e, S.y)) / (2 * e);
    const gy = (groundAt(S.x, S.y + e) - groundAt(S.x, S.y - e)) / (2 * e);
    S.vx -= G * gx * 0.75 * dt;
    S.vy -= G * gy * 0.75 * dt;
    const k = Math.min(1, ROLL_DRAG * dt);
    S.vx -= S.vx * k; S.vy -= S.vy * k;
    if (Math.hypot(S.vx, S.vy) < 0.02) { S.vx = 0; S.vy = 0; }

    /* --- avance et rebond ---
       Ce qu'elle ne peut pas monter la renvoie. Une boule de 260 mm gravit
       une pente, pas une marche : au-delà d'un quart de son rayon, c'est un
       mur et elle repart dessus. */
    const nx2 = S.x + S.vx * dt, ny2 = S.y + S.vy * dt;
    const here = groundAt(S.x, S.y);
    if (groundAt(nx2, ny2) - here > R * 0.25) {
      const hx = groundAt(S.x + e, S.y) - groundAt(S.x - e, S.y);
      const hy = groundAt(S.x, S.y + e) - groundAt(S.x, S.y - e);
      const n = Math.hypot(hx, hy) || 1;
      const ux = -hx / n, uy = -hy / n;               // normale sortante du mur
      const dot = S.vx * ux + S.vy * uy;
      S.vx = (S.vx - 2 * dot * ux) * 0.55;
      S.vy = (S.vy - 2 * dot * uy) * 0.55;
    } else { S.x = nx2; S.y = ny2; }

    // la boule repose sur le relief, filtrée pour ne pas sauter aux marches
    const want = groundAt(S.x, S.y) + R;
    S.z += (want - S.z) * Math.min(1, dt * 10);

    /* --- rotation ---
       Elle roule sans glisser : un tour par 2πR parcourus, autour de l'axe
       perpendiculaire au déplacement. C'est ce qui rend le mouvement lisible. */
    const sp = Math.hypot(S.vx, S.vy);
    if (sp > 1e-4) {
      axis.set(-S.vy / sp, S.vx / sp, 0);
      S.group.rotateOnWorldAxis(axis, sp * dt / R);
    }
    S.group.position.set(S.x, S.y, S.z);
  }

  Y.Ball = {
    state: S,
    radius: R,
    build: build,
    set: set,
    reset: reset,
    step: step,
    /** Présente sur ce terrain ? */
    active: function () { return S.on; }
  };
})(window.YLO);
