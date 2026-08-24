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
      // nez de marche : une arête claire, comme la bande antidérapante d'un escalier
      const nose = new T.Mesh(new T.BoxGeometry(0.03, d, 0.008), edge);
      nose.position.set(b.x0 + 0.015, (b.y0 + b.y1) / 2, b.h + 0.004);
      nose.receiveShadow = true;
      group.add(nose);
    });
  }

  Y.Terrain = {
    presets: PRESETS,
    group: group,
    build: build,
    heightAt: heightAt,
    maxHeightAlong: maxHeightAlong,
    stepAhead: stepAhead,
    get current() { return current; },
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
