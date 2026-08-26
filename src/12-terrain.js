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
    return { x0: x0, x1: x1, y0: y0, y1: y1, h: h };
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
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
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
      })() },

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
      if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && b.h > h) h = b.h;
    }
    return h;
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

  function rebuild() {
    while (group.children.length) {
      const m = group.children.pop();
      if (m.geometry) m.geometry.dispose();
      group.remove(m);
    }
    const mat = Y.Mat.get("obstacle");
    const edge = Y.Mat.get("obstacleEdge");
    current.boxes.forEach(function (b) {
      const w = b.x1 - b.x0, d = b.y1 - b.y0;
      const mesh = new T.Mesh(new T.BoxGeometry(w, d, b.h), mat);
      mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.h / 2);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
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
  }

  Y.Terrain = {
    presets: PRESETS,
    group: group,
    build: build,
    heightAt: heightAt,
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
      rebuild();
      return true;
    },
    refresh: rebuild
  };
})(window.YLO);
