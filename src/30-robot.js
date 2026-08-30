/* =====================================================================
   YLO-2 — géométrie réelle
   Décodage du paquet de maillages (issus des .dae/.stl du dépôt, voir
   tools/convert_meshes.py) et montage de l'arbre cinématique avec les
   placements exacts de l'URDF.
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;
  const K = Y.K;

  /* ---------- décodage du paquet ---------- */
  function b64ToBytes(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream !== "function") throw new Error("DecompressionStream absent");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  Y.Geo = {
    parts: {},
    ready: false,
    error: null,

    load: async function () {
      const index = window.YLO2_GEO_INDEX, b64 = window.YLO2_GEO_B64;
      if (!index || !b64) { this.error = "paquet de maillages absent"; return this; }
      try {
        const buf = await gunzip(b64ToBytes(b64));
        Object.keys(index.parts).forEach(function (name) {
          const p = index.parts[name];
          const g = new T.BufferGeometry();
          g.setAttribute("position", new T.BufferAttribute(new Float32Array(buf, p.pos[0], p.pos[1] / 4), 3));
          g.setAttribute("normal", new T.BufferAttribute(new Float32Array(buf, p.nrm[0], p.nrm[1] / 4), 3));
          g.setIndex(new T.BufferAttribute(new Uint32Array(buf, p.idx[0], p.idx[1] / 4), 1));
          g.computeBoundingSphere();
          Y.Geo.parts[name] = g;
        });
        this.ready = true;
        this.stats = { parts: Object.keys(this.parts).length,
          tris: Object.keys(index.parts).reduce(function (a, k) { return a + index.parts[k].tris; }, 0) };
      } catch (e) {
        this.error = e.message;
      }
      return this;
    },

    // copie miroir selon Y : l'URDF utilise scale="1 -1 1" pour les pattes droites
    mirrored: function (name) {
      const key = name + "$mirror";
      if (this.parts[key]) return this.parts[key];
      const src = this.parts[name];
      if (!src) return null;
      const g = src.clone();
      const pos = g.attributes.position.array.slice();
      const nrm = g.attributes.normal.array.slice();
      for (let i = 1; i < pos.length; i += 3) { pos[i] = -pos[i]; nrm[i] = -nrm[i]; }
      const idx = g.index.array.slice();
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("normal", new T.BufferAttribute(nrm, 3));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      this.parts[key] = g;
      return g;
    }
  };

  /* ---------- fabrique de pièces ---------- */
  const exploders = [];

  function tag(obj, sys, explode) {
    obj.traverse(function (o) {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.sys = sys; }
    });
    obj.userData.sys = sys;
    obj.userData.home = obj.position.clone();
    if (explode) { obj.userData.explode = new T.Vector3().fromArray(explode); exploders.push(obj); }
    return obj;
  }

  function meshOf(name, matGroup, mirror) {
    const g = mirror ? Y.Geo.mirrored(name) : Y.Geo.parts[name];
    if (!g) return null;
    return new T.Mesh(g, Y.Mat.get(matGroup));
  }

  function box(w, d, h, matGroup) {
    return new T.Mesh(new T.BoxGeometry(w, d, h), Y.Mat.get(matGroup));
  }
  function cyl(r, h, matGroup, seg) {
    const m = new T.Mesh(new T.CylinderGeometry(r, r, h, seg || 24), Y.Mat.get(matGroup));
    m.rotation.x = Math.PI / 2;                     // axe suivant Z
    return m;
  }

  /* ---------- montage ---------- */
  Y.Robot = {
    build: function (scene) {
      exploders.length = 0;
      const root = new T.Group(); scene.add(root);
      const body = new T.Group(); root.add(body);
      const legs = {};
      const extras = {};

      const real = Y.Geo.ready;

      /* --- tronc --- */
      if (real) {
        // toutes ces pièces sont à l'identité dans le repère « trunk »
        body.add(tag(meshOf("trunk", "frame"), "frame", [0, 0, 0]));
        body.add(tag(meshOf("cover", "cover"), "cover", [0, 0, 0.34]));
        body.add(tag(meshOf("abad_motors", "abad"), "motors", [0, 0, 0.06]));
        body.add(tag(meshOf("accessories", "sensor"), "frame", [0, 0, 0.2]));
        body.add(tag(meshOf("battery", "battery"), "power", [0, 0, -0.4]));
        body.add(tag(meshOf("d435", "sensor"), "d435", [0.5, 0, 0]));
        const t265 = tag(meshOf("t265", "sensor"), "t265", [-0.5, 0, 0.1]);
        t265.scale.set(1, 1.06, 1.04);              // échelle de l'URDF
        body.add(t265);
      } else {
        const slab = box(K.trunkL, K.trunkW * 0.62, K.trunkH * 0.7, "cover");
        slab.position.z = 0.02;
        body.add(tag(slab, "frame", [0, 0, 0.3]));
      }

      /* --- lidar : hors URDF, posé sur le dessus ---

         Il était planté 22 mm DANS le tronc — son maillage est centré sur son
         milieu, pas sur sa semelle, et le poser à la hauteur du dessus de
         caisse l'enfonçait d'une demi-hauteur. Et c'est tout le capteur qui
         tournait, embase comprise : un RPLIDAR a une embase FIXE, vissée sur
         le pont, et seule la tête tourne dessus. On dessine donc l'embase, on
         pose la tête à sa hauteur réelle, et on ne fait tourner que la tête —
         autour de son propre axe, recalé sur le centre du maillage. */
      const LID = { z: K.trunkTop, x: -0.02 };
      const lidar = new T.Group();
      const mount = new T.Mesh(new T.CylinderGeometry(0.042, 0.046, 0.012, 24),
        Y.Mat.get("frame"));
      mount.rotation.x = Math.PI / 2;                 // cylindre : axe Y -> Z
      mount.position.z = 0.006;
      lidar.add(mount);
      const head = new T.Group();
      head.position.z = 0.012;
      const lidarMesh = real ? meshOf("lidar", "sensor") : cyl(0.037, 0.045, "sensor");
      if (lidarMesh) {
        const bb = new T.Box3().setFromObject(lidarMesh);
        // l'axe de rotation passe par le centre du maillage, sa semelle repose
        // sur l'embase : deux recalages que le maillage ne porte pas lui-même
        lidarMesh.position.set(-(bb.min.x + bb.max.x) / 2,
                               -(bb.min.y + bb.max.y) / 2,
                               -bb.min.z);
        head.add(lidarMesh);
      }
      lidar.add(head);
      lidar.position.set(LID.x, 0, LID.z);
      body.add(tag(lidar, "lidar", [0, 0, 0.5]));
      extras.lidarSpin = head;

      /* --- électronique et capteurs non modélisés dans le dépôt --- */
      const upx = new T.Group();
      upx.add(box(0.122, 0.12, 0.006, "board"));
      const cpu = box(0.032, 0.032, 0.014, "abad"); cpu.position.z = 0.01; upx.add(cpu);
      upx.position.set(0.02, 0, 0.03);
      body.add(tag(upx, "upx", [0, 0, 0.5]));

      const peak = new T.Group();
      peak.add(box(0.042, 0.022, 0.004, "board"));
      for (let i = 0; i < 4; i++) {
        const port = box(0.008, 0.008, 0.006, "sensor");
        port.position.set(-0.014 + i * 0.009, 0.014, 0.004); peak.add(port);
      }
      peak.position.set(0.02, 0.05, 0.045);
      body.add(tag(peak, "peak", [0.1, 0.34, 0.5]));

      const imu = new T.Group();
      imu.add(box(0.034, 0.027, 0.005, "board"));
      imu.position.set(-0.03, 0, 0.045);
      body.add(tag(imu, "imu", [0, -0.34, 0.48]));

      const mic = new T.Group();
      mic.add(cyl(0.035, 0.008, "board"));
      const leds = [];
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2;
        const led = new T.Mesh(new T.CylinderGeometry(0.0032, 0.0032, 0.003, 8),
          new T.MeshStandardMaterial({ color: 0x120f0c, emissive: 0xff6a2b, emissiveIntensity: 0.15, roughness: 0.6 }));
        led.rotation.x = Math.PI / 2;
        led.position.set(Math.cos(a) * 0.028, Math.sin(a) * 0.028, 0.005);
        led.userData.led = i; leds.push(led); mic.add(led);
      }
      mic.position.set(0.10, 0, 0.098);
      body.add(tag(mic, "mic", [0, 0, 0.55]));
      extras.leds = leds;

      [0.085, -0.085].forEach(function (y) {
        const s = new T.Group();
        [-0.011, 0.011].forEach(function (dz) {
          const c = cyl(0.0085, 0.012, "sensor", 16);
          c.rotation.set(0, Math.PI / 2, 0); c.position.set(0, dz, 0); s.add(c);
        });
        s.position.set(K.trunkL / 2 - 0.02, y, 0.02);
        body.add(tag(s, "srf10", [0.4, y * 3, 0]));
      });

      /* --- pattes : placements exacts du xacro --- */
      Y.LEGS.forEach(function (L) {
        const hip = new T.Group();
        hip.position.set(L.x, L.y, K.legZ);
        body.add(hip);

        if (real) {
          const hipMesh = meshOf("hip", "hip");
          // <xacro:if> sur (mirror_dae, front_hind_dae) : rpy et xyz du visuel
          hipMesh.position.set(L.fdae ? -0.06 : 0.06, 0, 0);
          hipMesh.rotation.set(L.mdae ? 0 : Math.PI, L.fdae ? 0 : Math.PI, 0);
          hip.add(tag(hipMesh, "motors", [0, 0, 0]));
        } else {
          const stub = box(0.062, K.abad, 0.05, "hip");
          stub.position.set(0, L.m * K.abad / 2, 0);
          hip.add(tag(stub, "motors", [0, 0, 0]));
        }

        const upper = new T.Group();
        upper.position.set(0, L.m * K.abad, 0);
        hip.add(upper);

        if (real) {
          const th = meshOf("upper_leg", "upper", !L.mdae);   // scale="1 -1 1" à droite
          th.position.set(0, -0.0732 * L.m, 0);
          upper.add(tag(th, "legs", [0, 0, 0]));
        } else {
          const beam = box(0.043, 0.037, K.L1 * 0.86, "upper");
          beam.position.z = -K.L1 / 2;
          upper.add(tag(beam, "legs", [0, 0, 0]));
        }

        const lower = new T.Group();
        lower.position.set(0, L.m * -0.001, -K.L1);
        upper.add(lower);

        if (real) {
          const sh = meshOf("lower_leg", "lower");
          sh.position.set(0, 0.001 * L.m, 0);
          lower.add(tag(sh, "legs", [0, 0, 0]));
        } else {
          const shank = box(0.021, 0.016, K.L2 * 0.9, "lower");
          shank.position.z = -K.L2 * 0.5;
          lower.add(tag(shank, "legs", [0, 0, 0]));
        }

        // pied : lien fixe à -L2 ; le point de contact est l'origine du lien
        const foot = new T.Group();
        foot.position.set(0, 0, -K.L2);
        lower.add(foot);
        const footVisual = new T.Group();
        foot.add(footVisual);
        if (real) {
          const fm = meshOf("foot", "foot");
          fm.position.set(0.009, 0.001 * L.m + 0.001, 0.069);
          footVisual.add(tag(fm, "foot", [0, 0, -0.18]));
        } else {
          const ball = new T.Mesh(new T.SphereGeometry(K.footR, 20, 14), Y.Mat.get("foot"));
          ball.position.z = K.footR;
          footVisual.add(tag(ball, "foot", [0, 0, -0.18]));
        }

        // Roue motrice, à la manière des Go2-W. L'essieu est porté par la
        // jambe : il reste parallèle à l'axe du genou, donc à Y local. Le
        // moyeu est confondu avec l'origine du repère « foot », que la
        // cinématique inverse place à un rayon au-dessus du sol — la roue ne
        // doit surtout pas être décalée le long de la jambe, sinon elle
        // flotte de la valeur de ce décalage projetée à la verticale.
        const wheelR = 0.075;
        const wheel = new T.Group();
        wheel.position.set(0, L.m * 0.012, 0);
        /* Pneu large et cranté. Le tore fait 26 % du rayon de section — 39 mm
           de large contre 27 —, et une couronne de crampons vient dessus : sur
           un robot qui roule sur du béton cassé, une roue lisse et étroite ne
           dit pas ce qu'elle fait. Le tore a son axe sur Z, on le bascule sur
           Y pour l'aligner sur l'essieu. */
        /* Rayon moyen + section = exactement `wheelR` : le pneu touche le sol
           là où la physique le croit. Un tore plus gros que le rayon de
           contact ferait flotter le robot de la différence. */
        const tyre = new T.Mesh(new T.TorusGeometry(wheelR * 0.78, wheelR * 0.22, 16, 36),
          Y.Mat.get("wheel"));
        tyre.rotation.x = Math.PI / 2;
        wheel.add(tyre);
        // crampons : deux rangées décalées, comme une bande de pneu tout-terrain
        for (let k = 0; k < 12; k++) {
          const a = k * Math.PI / 6;
          for (let r = -1; r <= 1; r += 2) {
            // le crampon affleure la bande de roulement, il ne la dépasse pas
            const lug = new T.Mesh(new T.BoxGeometry(0.020, 0.018, 0.012),
              Y.Mat.get("wheel"));
            lug.position.set(Math.cos(a + (r > 0 ? 0.26 : 0)) * wheelR * 0.867,
                             r * wheelR * 0.16,
                             Math.sin(a + (r > 0 ? 0.26 : 0)) * wheelR * 0.867);
            lug.rotation.y = -(a + (r > 0 ? 0.26 : 0));
            wheel.add(lug);
          }
        }
        /* Jante de 4x4 : anneau de beadlock boulonné, cinq branches dédoublées
           en Y, moyeu bombé. C'est la signature d'une roue tout-terrain — la
           couronne extérieure vissée qui pince le pneu, et des bras assez
           larges pour qu'on les voie tourner. On s'arrête là : elle tourne à
           vingt tours par seconde, le détail s'y perdrait. */
        const bead = new T.Mesh(new T.TorusGeometry(wheelR * 0.70, wheelR * 0.075, 8, 32),
          Y.Mat.get("rim"));
        bead.rotation.x = Math.PI / 2;
        wheel.add(bead);
        // boulons de beadlock : dix têtes réparties sur la couronne
        for (let k = 0; k < 10; k++) {
          const a = k * Math.PI / 5 + 0.15;
          const bolt = new T.Mesh(new T.CylinderGeometry(0.0042, 0.0042, 0.030, 6),
            Y.Mat.get("hub"));
          bolt.rotation.x = Math.PI / 2;
          bolt.position.set(Math.cos(a) * wheelR * 0.70, 0, Math.sin(a) * wheelR * 0.70);
          wheel.add(bolt);
        }
        // cinq branches en Y : un pied unique au moyeu, deux bras vers la jante
        for (let k = 0; k < 5; k++) {
          const a = k * Math.PI * 2 / 5;
          const foot2 = new T.Mesh(new T.BoxGeometry(wheelR * 0.26, 0.030, 0.030),
            Y.Mat.get("rim"));
          foot2.position.set(Math.cos(a) * wheelR * 0.24, 0, Math.sin(a) * wheelR * 0.24);
          foot2.rotation.y = -a;
          wheel.add(foot2);
          for (let j = -1; j <= 1; j += 2) {
            const br = a + j * 0.30;
            const arm = new T.Mesh(new T.BoxGeometry(wheelR * 0.40, 0.024, 0.026),
              Y.Mat.get("rim"));
            arm.position.set(Math.cos(br) * wheelR * 0.50, 0, Math.sin(br) * wheelR * 0.50);
            arm.rotation.y = -br;
            wheel.add(arm);
          }
        }
        /* Le moyeu a sa propre matière : la jante prend la couleur du robot,
           le moyeu reste noir. Bombé, comme un cache-moyeu de 4x4. */
        const hubCap = new T.Mesh(new T.CylinderGeometry(wheelR * 0.30, wheelR * 0.26, 0.040, 20),
          Y.Mat.get("hub"));
        const dome = new T.Mesh(new T.SphereGeometry(wheelR * 0.20, 16, 10,
          0, Math.PI * 2, 0, Math.PI / 2), Y.Mat.get("hub"));
        dome.rotation.x = -Math.PI / 2;
        dome.position.y = 0.020;
        const dome2 = dome.clone();
        dome2.rotation.x = Math.PI / 2;
        dome2.position.y = -0.020;
        wheel.add(hubCap, dome, dome2);
        wheel.visible = false;
        tag(wheel, "wheels", [0, L.m * 0.3, -0.1]);
        foot.add(wheel);

        // repères d'axes articulaires
        function axisMark(color, dir, parent) {
          const g = new T.Group();
          const mat = new T.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.9 });
          const a = new T.Mesh(new T.CylinderGeometry(0.0032, 0.0032, 0.2, 8), mat);
          const ring = new T.Mesh(new T.TorusGeometry(0.032, 0.0022, 6, 28), mat);
          if (dir === "x") { a.rotation.set(0, 0, Math.PI / 2); ring.rotation.set(0, Math.PI / 2, 0); }
          if (dir === "y") { ring.rotation.set(Math.PI / 2, 0, 0); }
          g.add(a, ring); g.visible = false;
          g.traverse(function (o) { o.renderOrder = 6; });
          parent.add(g); return g;
        }

        legs[L.id] = {
          L: L, hip: hip, upper: upper, lower: lower, foot: foot,
          footVisual: footVisual, wheel: wheel,
          axes: [axisMark(0xff6a2b, "x", hip), axisMark(0x77c2a6, "y", upper), axisMark(0x77c2a6, "y", lower)],
          q: [0, 0, 0], contact: true, phase: 0, world: new T.Vector3()
        };
      });

      this.root = root; this.body = body; this.legs = legs;
      this.extras = extras; this.exploders = exploders;
      return this;
    },

    // écarte les sous-ensembles pour la vue éclatée
    explode: function (k) {
      const v = new T.Vector3();
      exploders.forEach(function (o) {
        v.copy(o.userData.home).addScaledVector(o.userData.explode, k * 0.32);
        o.position.copy(v);
      });
    },

    /** Bascule pattes / roues : le contact passe du pied au bas du pneu. */
    setWheels: function (on) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        if (!n) return;
        if (n.wheel) n.wheel.visible = !!on;
        if (n.footVisual) n.footVisual.visible = !on;
      });
    },

    // pièce représentative d'un sous-système (ancrage des étiquettes)
    anchorFor: function (sysId) {
      let found = null;
      this.root.traverse(function (o) {
        if (!found && o.userData.sys === sysId && o.userData.home) found = o;
      });
      return found;
    }
  };
})(window.YLO);
