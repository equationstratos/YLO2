/* =====================================================================
   YLO-2 — matières et motifs
   Un jeu de matières PBR par groupe de pièces, avec motifs procéduraux
   dessinés sur canvas (donc modifiables sans le moindre fichier externe).
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;

  const SIZE = 512;
  const cache = {};                      // "motif@échelle" -> CanvasTexture

  function canvas() {
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    return c;
  }

  function noise(g, amount, alpha) {
    const img = g.getImageData(0, 0, SIZE, SIZE), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amount;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
      if (alpha !== undefined) d[i + 3] = alpha;
    }
    g.putImageData(img, 0, 0);
  }

  const DRAW = {
    brushed: function (g) {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 2600; i++) {
        const y = Math.random() * SIZE, w = 40 + Math.random() * 420;
        const v = 210 + Math.random() * 45;
        g.strokeStyle = "rgba(" + v + "," + v + "," + v + ",0.55)";
        g.lineWidth = 0.6 + Math.random();
        g.beginPath(); g.moveTo(Math.random() * SIZE, y);
        g.lineTo(Math.random() * SIZE + w, y + (Math.random() - 0.5) * 1.5); g.stroke();
      }
      noise(g, 10);
    },
    carbon: function (g) {
      const cell = SIZE / 16;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const warp = ((x >> 1) + (y >> 1)) % 2 === 0;
          const grad = warp
            ? g.createLinearGradient(x * cell, y * cell, x * cell + cell, y * cell)
            : g.createLinearGradient(x * cell, y * cell, x * cell, y * cell + cell);
          grad.addColorStop(0, "#6e7276"); grad.addColorStop(0.5, "#d5d9dc"); grad.addColorStop(1, "#6e7276");
          g.fillStyle = grad; g.fillRect(x * cell, y * cell, cell, cell);
        }
      }
      noise(g, 12);
    },
    print: function (g) {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, SIZE, SIZE);
      const step = SIZE / 42;
      for (let i = 0; i <= 42; i++) {
        const y = i * step;
        const grad = g.createLinearGradient(0, y, 0, y + step);
        grad.addColorStop(0, "#c9c9c9"); grad.addColorStop(0.45, "#ffffff"); grad.addColorStop(1, "#d8d8d8");
        g.fillStyle = grad; g.fillRect(0, y, SIZE, step);
      }
      noise(g, 7);
    },
    anodized: function (g) {
      g.fillStyle = "#f2f2f2"; g.fillRect(0, 0, SIZE, SIZE);
      noise(g, 26);
      for (let i = 0; i < 500; i++) {
        g.fillStyle = "rgba(255,255,255,0.4)";
        g.fillRect(Math.random() * SIZE, Math.random() * SIZE, 2, 2);
      }
    },
    hex: function (g) {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, SIZE, SIZE);
      g.strokeStyle = "#7e847f"; g.lineWidth = 2;
      const r = SIZE / 12, h = Math.sqrt(3) / 2 * r;
      for (let row = -1; row * h * 2 < SIZE + r; row++) {
        for (let col = -1; col * r * 1.5 < SIZE + r; col++) {
          const cx = col * r * 1.5, cy = row * h * 2 + (col % 2 ? h : 0);
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = k * Math.PI / 3;
            g[k ? "lineTo" : "moveTo"](cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92);
          }
          g.closePath(); g.stroke();
        }
      }
    },
    perf: function (g) {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, SIZE, SIZE);
      const n = 12, step = SIZE / n;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const cx = x * step + step / 2 + (y % 2 ? step / 2 : 0), cy = y * step + step / 2;
          const grad = g.createRadialGradient(cx, cy, 1, cx, cy, step * 0.3);
          grad.addColorStop(0, "#3a3f3b"); grad.addColorStop(0.8, "#5c625d"); grad.addColorStop(1, "#ffffff");
          g.fillStyle = grad;
          g.beginPath(); g.arc(cx, cy, step * 0.3, 0, Math.PI * 2); g.fill();
        }
      }
    },
    stripe: function (g) {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, SIZE, SIZE);
      g.save(); g.translate(SIZE / 2, SIZE / 2); g.rotate(-Math.PI / 4); g.translate(-SIZE, -SIZE);
      const band = SIZE / 8;
      for (let i = 0; i < 32; i++) {
        g.fillStyle = i % 2 ? "#2e3230" : "#ffffff";
        g.fillRect(i * band, 0, band, SIZE * 2);
      }
      g.restore();
    }
  };

  function texture(pattern) {
    if (pattern === "none" || !DRAW[pattern]) return null;
    if (cache[pattern]) return cache[pattern];
    const c = canvas();
    DRAW[pattern](c.getContext("2d"));
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = T.SRGBColorSpace;
    cache[pattern] = tex;
    return tex;
  }

  /* Les maillages du dépôt n'ont pas de coordonnées de texture exploitables :
     on projette les motifs en triplanaire, dans le repère local de la pièce.
     Le motif reste donc collé à la pièce quand le robot bouge, sans couture. */
  function triplanar(material) {
    material.onBeforeCompile = function (shader) {
      shader.uniforms.uPatScale = material.userData.patScale;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>",
          "#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNrm;")
        .replace("#include <begin_vertex>",
          "#include <begin_vertex>\nvObjPos = transformed;\nvObjNrm = objectNormal;");

      const helper =
        "uniform float uPatScale;\n" +
        "varying vec3 vObjPos;\nvarying vec3 vObjNrm;\n" +
        "vec4 triSample(sampler2D tex, float s) {\n" +
        "  vec3 bw = abs(normalize(vObjNrm));\n" +
        "  bw = pow(bw, vec3(4.0));\n" +
        "  bw /= max(bw.x + bw.y + bw.z, 1e-4);\n" +
        "  return texture2D(tex, vObjPos.zy * s) * bw.x\n" +
        "       + texture2D(tex, vObjPos.xz * s) * bw.y\n" +
        "       + texture2D(tex, vObjPos.xy * s) * bw.z;\n" +
        "}\n";

      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + helper)
        .replace("#include <map_fragment>",
          "#ifdef USE_MAP\ndiffuseColor *= triSample(map, uPatScale);\n#endif")
        .replace("#include <roughnessmap_fragment>",
          "float roughnessFactor = roughness;\n#ifdef USE_ROUGHNESSMAP\n" +
          "roughnessFactor *= mix(0.75, 1.15, triSample(roughnessMap, uPatScale).g);\n#endif");
    };
  }

  const state = {};                        // id -> {color, metal, rough, pattern, scale}
  const mats = {};                         // id -> MeshStandardMaterial
  const listeners = [];

  const Mat = {
    STORE: "ylo2.materials.v1",

    init: function () {
      Y.MATGROUPS.forEach(function (g) {
        state[g.id] = Object.assign({ scale: 3 }, g.preset);
        const m = new T.MeshStandardMaterial({ name: g.id });
        m.envMapIntensity = 1.15;
        m.userData.patScale = { value: 8 };
        triplanar(m);
        // la cuisse et la hanche partagent la surface du tambour d'épaule :
        // on tranche le conflit de profondeur au lieu de le laisser scintiller
        if (g.id === "hip" || g.id === "abad") {
          m.polygonOffset = true;
          m.polygonOffsetFactor = 1.2;
          m.polygonOffsetUnits = 1.2;
        }
        mats[g.id] = m;
      });
      this.restore();
      Object.keys(state).forEach(this.refresh, this);
      return this;
    },

    get: function (id) { return mats[id] || mats.frame; },
    settings: function (id) { return state[id]; },

    refresh: function (id) {
      const s = state[id], m = mats[id];
      if (!s || !m) return;
      m.color.set(s.color);
      m.metalness = s.metal;
      m.roughness = s.rough;
      const had = !!m.map;
      const tex = texture(s.pattern);
      m.map = tex;
      m.roughnessMap = tex;
      m.userData.patScale.value = s.scale * 4;      // motifs par mètre
      if (had !== !!tex) m.needsUpdate = true;      // le programme change
    },

    set: function (id, patch) {
      Object.assign(state[id], patch);
      this.refresh(id);
      this.save();
      listeners.forEach(function (fn) { fn(id, state[id]); });
    },

    applyTheme: function (themeId) {
      const th = Y.THEMES.find(function (t) { return t.id === themeId; });
      if (!th) return;
      Y.MATGROUPS.forEach(function (g) {
        state[g.id] = Object.assign({ scale: 3 }, g.preset);
      });
      Object.keys(th.set || {}).forEach(function (k) { state[k].color = th.set[k]; });
      Object.keys(th.pat || {}).forEach(function (k) { state[k].pattern = th.pat[k]; });
      Object.keys(state).forEach(this.refresh, this);
      this.save();
      listeners.forEach(function (fn) { fn(null, null); });
    },

    reset: function () {
      Y.MATGROUPS.forEach(function (g) { state[g.id] = Object.assign({ scale: 3 }, g.preset); });
      Object.keys(state).forEach(this.refresh, this);
      this.save();
      listeners.forEach(function (fn) { fn(null, null); });
    },

    onChange: function (fn) { listeners.push(fn); },

    serialize: function () { return JSON.parse(JSON.stringify(state)); },

    load: function (data) {
      Object.keys(data || {}).forEach(function (k) {
        if (state[k]) Object.assign(state[k], data[k]);
      });
      Object.keys(state).forEach(this.refresh, this);
      listeners.forEach(function (fn) { fn(null, null); });
    },

    save: function () {
      try { localStorage.setItem(this.STORE, JSON.stringify(state)); } catch (e) { /* privé */ }
    },

    restore: function () {
      try {
        const raw = localStorage.getItem(this.STORE);
        if (raw) {
          const data = JSON.parse(raw);
          Object.keys(data).forEach(function (k) {
            if (state[k]) Object.assign(state[k], data[k]);
          });
        }
      } catch (e) { /* stockage indisponible : on garde les préréglages */ }
    }
  };

  Y.Mat = Mat;
})(window.YLO);
