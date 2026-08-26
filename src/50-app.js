/* =====================================================================
   YLO-2 — scène, rendu et interface
   ===================================================================== */
(function (Y) {
  "use strict";
  const T = window.THREE;
  const K = Y.K;
  const M = Y.Motion;

  const canvas = document.getElementById("gl");
  const stage = document.getElementById("stage");
  const boot = document.getElementById("boot");

  const renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new T.Scene();
  scene.background = new T.Color(0x0e100e);
  scene.fog = new T.Fog(0x0e100e, 4.5, 14);

  const camera = new T.PerspectiveCamera(38, 1, 0.05, 100);
  camera.up.set(0, 0, 1);

  /* --- environnement : sans réflexions, les métaux rendent noir --- */
  (function buildEnv() {
    const c = document.createElement("canvas");
    c.width = 128; c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0.00, "#8fa3ab");
    grad.addColorStop(0.42, "#4a534f");
    grad.addColorStop(0.52, "#23282a");
    grad.addColorStop(1.00, "#0c0e0d");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 64);
    const spot = g.createRadialGradient(34, 14, 1, 34, 14, 26);
    spot.addColorStop(0, "#fff4e6"); spot.addColorStop(1, "rgba(255,244,230,0)");
    g.fillStyle = spot; g.fillRect(0, 0, 128, 64);
    const warm = g.createRadialGradient(104, 26, 1, 104, 26, 30);
    warm.addColorStop(0, "#ff9a5c"); warm.addColorStop(1, "rgba(255,154,92,0)");
    g.globalAlpha = 0.5; g.fillStyle = warm; g.fillRect(0, 0, 128, 64); g.globalAlpha = 1;
    const tex = new T.CanvasTexture(c);
    tex.mapping = T.EquirectangularReflectionMapping;
    tex.colorSpace = T.SRGBColorSpace;
    const pmrem = new T.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose(); pmrem.dispose();
  })();

  scene.add(new T.AmbientLight(0xb6c6c2, 0.35));
  scene.add(new T.HemisphereLight(0x9db4b0, 0.6));
  const key = new T.DirectionalLight(0xfff0e2, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 9;
  key.shadow.camera.left = -1.4; key.shadow.camera.right = 1.4;
  key.shadow.camera.top = 1.4; key.shadow.camera.bottom = -1.4;
  key.shadow.bias = -0.0002; key.shadow.normalBias = 0.055;
  scene.add(key, key.target);
  const rim = new T.DirectionalLight(0xff8b4d, 0.55); scene.add(rim, rim.target);
  const fill = new T.DirectionalLight(0x9fd8c4, 0.5); fill.position.set(-1, 2.2, 0.6); scene.add(fill);

  const ground = new T.Mesh(new T.PlaneGeometry(40, 40),
    new T.MeshStandardMaterial({ color: 0x191d1e, roughness: 0.95, metalness: 0 }));
  ground.receiveShadow = true; ground.position.z = -0.0005; scene.add(ground);
  const gridFine = new T.GridHelper(40, 400, 0x1d241f, 0x1d241f);
  const gridCoarse = new T.GridHelper(40, 80, 0x2c3a30, 0x2c3a30);
  [gridFine, gridCoarse].forEach(function (g) {
    g.rotation.x = Math.PI / 2; g.material.transparent = true;
    g.material.opacity = g === gridFine ? 0.32 : 0.6; scene.add(g);
  });

  Y.Terrain.build(scene);

  /* --- état d'affichage --- */
  const view = { explode: 0, explodeOn: false, axes: false, trace: true,
    support: false, selected: null, name: "iso", stunt: 0, speed: 0 };

  /* --- traces de pieds --- */
  const TRACE_N = 220;
  const traces = {};
  Y.LEGS.forEach(function (L) {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(new Float32Array(TRACE_N * 3), 3));
    const line = new T.Line(geo, new T.LineBasicMaterial({
      color: L.m > 0 ? 0xff6a2b : 0x77c2a6, transparent: true, opacity: 0.75
    }));
    line.frustumCulled = false; scene.add(line);
    traces[L.id] = { line: line, pts: [], geo: geo };
  });

  const polyGeo = new T.BufferGeometry();
  polyGeo.setAttribute("position", new T.BufferAttribute(new Float32Array(5 * 3), 3));
  const poly = new T.LineLoop(polyGeo, new T.LineBasicMaterial({ color: 0xffc24d, transparent: true, opacity: 0.85 }));
  poly.frustumCulled = false; poly.visible = false; scene.add(poly);
  const comDot = new T.Mesh(new T.SphereGeometry(0.014, 16, 12), new T.MeshBasicMaterial({ color: 0xffc24d }));
  comDot.visible = false; scene.add(comDot);

  /* --- caméra orbitale --- */
  const orbit = { az: -0.85, el: 0.30, dist: 2.30, target: new T.Vector3(0, 0, 0.24) };
  let dragging = false, lastX = 0, lastY = 0, pinch0 = 0, downAt = null, camTween = null;
  // vitesse de balayage demandée par le stick droit de la manette, en rad/s
  let padLook = null;
  /* Vue de suivi. Sur les terrains qui sont des PARCOURS, la caméra se tient
     derrière le robot : c'est la seule vue depuis laquelle on peut lire ce qui
     arrive. Quand la main s'en mêle, elle rend la main — et elle y revient
     toute seule, après une seconde et demie sans rien toucher. */
  const CHASE = { el: 0.16, dist: 3.0, hold: 1.5, back: 6.0 };
  let manualCam = 0;
  function grabCam(long) { manualCam = long ? CHASE.back : CHASE.hold; }
  /** Chronomètre du parcours : de la sortie du départ à l'entrée dans l'arrivée. */
  const course = { t: 0, armed: false, running: false, best: 0, done: 0 };
  const pointers = new Map();
  const clamp = function (v, a, b) { return Math.min(Math.max(v, a), b); };
  const lerp = function (a, b, t) { return a + (b - a) * t; };

  function placeCamera() {
    const fit = clamp(1.55 / camera.aspect, 1, 1.95);
    // pendant une figure on recule : le robot monte à près d'un mètre
    const d = orbit.dist * fit * (1 + 0.3 * view.stunt + 0.12 * view.speed);
    const cd = Math.cos(orbit.el) * d;
    camera.position.set(
      orbit.target.x + Math.cos(orbit.az) * cd,
      orbit.target.y + Math.sin(orbit.az) * cd,
      orbit.target.z + Math.sin(orbit.el) * d
    );
    camera.lookAt(orbit.target);
  }

  /**
   * Caméra de session : elle suit le robot, se cale sur le cadrage voulu par
   * l'acte en cours et anticipe un peu sa trajectoire sur les liaisons. Tout
   * est fondu, sinon chaque changement d'acte ferait un saut de caméra.
   */
  function followSession(dt) {
    const shot = Y.Session.shot();
    const st = M.state;
    const k = Math.min(1, dt * 1.8);
    const lead = shot.lead * (Y.Natural.state.dir || 1);
    orbit.target.x += (st.px + Math.cos(st.yaw) * lead - orbit.target.x) * k;
    orbit.target.y += (st.py + Math.sin(st.yaw) * lead - orbit.target.y) * k;
    orbit.target.z += (Math.max(st.z, 0.24) - orbit.target.z) * k;
    orbit.dist += (shot.dist - orbit.dist) * k;
    orbit.el += (shot.el - orbit.el) * k;
    // l'azimut se rejoint par le plus court chemin, sinon la caméra fait le tour
    let da = (shot.az - orbit.az) % (Math.PI * 2);
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    orbit.az += da * k;
  }

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    dragging = pointers.size === 1; lastX = e.clientX; lastY = e.clientY;
    camTween = null; downAt = [e.clientX, e.clientY];
    if (pointers.size === 2) {
      const p = [...pointers.values()];
      pinch0 = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
    }
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const p = [...pointers.values()];
      const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
      if (pinch0) orbit.dist = clamp(orbit.dist * (pinch0 / d), 0.45, 6);
      pinch0 = d; return;
    }
    if (!dragging) return;
    // L'axe vertical est INVERSÉ : tirer vers le haut monte le point de vue,
    // tirer vers le bas descend dessous le robot. C'est le sens qu'attend la
    // main quand on cherche à voir sous la caisse ou à travers une ouverture.
    grabCam(false);
    orbit.az -= (e.clientX - lastX) * 0.006;
    orbit.el = clamp(orbit.el - (e.clientY - lastY) * 0.005, -0.35, 1.45);
    lastX = e.clientX; lastY = e.clientY;
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
    if (pointers.size === 0) dragging = false;
  }
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    grabCam(false);
    orbit.dist = clamp(orbit.dist * (1 + Math.sign(e.deltaY) * 0.09), 0.45, 6);
  }, { passive: false });

  const VIEWS = {
    iso: { az: -0.85, el: 0.30, dist: 2.30 },
    side: { az: -Math.PI / 2, el: 0.05, dist: 2.05 },
    front: { az: 0, el: 0.08, dist: 1.85 },
    top: { az: -Math.PI / 2, el: 1.40, dist: 2.45 }
  };
  function setView(name, silent) {
    // Un cadrage demandé explicitement tient plus longtemps qu'un coup de
    // souris. Au démarrage, en revanche, personne n'a rien demandé : la page
    // ne doit pas retenir la caméra six secondes avant de suivre le robot.
    if (!silent) grabCam(true);
    view.name = name;
    camTween = Object.assign({}, VIEWS[name]);
    document.querySelectorAll("#views button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.view === name));
    });
  }

  /* --- sélection --- */
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  const highlighted = [];

  canvas.addEventListener("pointerup", function (e) {
    endPointer(e);
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 5 || !Y.Robot.root) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(Y.Robot.root.children, true)
      .find(function (h) { return h.object.userData.sys; });
    select(hit ? hit.object.userData.sys : null);
  });

  function select(id) {
    view.selected = id;
    highlighted.forEach(function (m) { m.material = m.userData.mat0; });
    highlighted.length = 0;
    const sys = Y.SYS.find(function (s) { return s.id === id; });
    const target = sys && sys.focus ? sys.focus : id;
    if (target && Y.Robot.root) {
      Y.Robot.root.traverse(function (o) {
        if (o.isMesh && o.userData.sys === target && o.material && o.material.emissive) {
          o.userData.mat0 = o.userData.mat0 || o.material;
          const hi = o.userData.mat0.clone();
          hi.emissive = new T.Color(0xff6a2b);
          hi.emissiveIntensity = 0.5;
          o.material = hi;
          highlighted.push(o);
        }
      });
    }
    document.querySelectorAll(".node").forEach(function (b) {
      b.setAttribute("aria-current", String(b.dataset.sys === id));
    });
    renderDetail(sys);
  }

  /* =====================================================================
     Panneau « Systèmes »
     ===================================================================== */
  function buildSysPane() {
    const pane = document.getElementById("pane-sys");
    const groups = [];
    Y.SYS.forEach(function (s) {
      let g = groups.find(function (x) { return x.name === s.group; });
      if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
      g.items.push(s);
    });
    groups.forEach(function (g) {
      const sect = document.createElement("section");
      sect.className = "sect";
      const h = document.createElement("h2"); h.textContent = g.name; sect.appendChild(h);
      g.items.forEach(function (s) {
        const b = document.createElement("button");
        b.className = "node"; b.dataset.sys = s.id; b.setAttribute("aria-current", "false");
        b.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="qty"></span>';
        b.querySelector(".nm").textContent = s.name;
        b.querySelector(".qty").textContent = s.qty;
        b.addEventListener("click", function () {
          select(s.id);
          if (innerWidth <= 1080) { closeRail(); openPanel("detail", true); }
        });
        sect.appendChild(b);
      });
      pane.appendChild(sect);
    });
  }

  /* =====================================================================
     Panneau « Matières »
     ===================================================================== */
  function buildMatPane() {
    const pane = document.getElementById("pane-mat");
    pane.innerHTML = "";

    const intro = document.createElement("section");
    intro.className = "sect";
    intro.innerHTML = '<h2>Ambiances</h2><p class="note">Un point de départ, puis chaque groupe ' +
      'se règle à part. Les réglages sont conservés dans ce navigateur.</p>';
    const chips = document.createElement("div");
    chips.className = "chips";
    Y.THEMES.forEach(function (t) {
      const b = document.createElement("button");
      b.textContent = t.name;
      b.addEventListener("click", function () { Y.Mat.applyTheme(t.id); buildMatPane(); });
      chips.appendChild(b);
    });
    intro.appendChild(chips);
    pane.appendChild(intro);

    Y.MATGROUPS.forEach(function (g) {
      const s = Y.Mat.settings(g.id);
      const row = document.createElement("div");
      row.className = "matrow";
      row.innerHTML =
        '<div class="head">' +
          '<input class="swatch" type="color" aria-label="Couleur ' + g.name + '">' +
          '<span class="name"></span>' +
          '<select aria-label="Motif ' + g.name + '"></select>' +
        '</div>' +
        '<div class="fine"><label>Métal</label><input type="range" min="0" max="1" step="0.02"><output></output></div>' +
        '<div class="fine"><label>Rugos.</label><input type="range" min="0.05" max="1" step="0.02"><output></output></div>' +
        '<div class="fine"><label>Échelle</label><input type="range" min="1" max="14" step="1"><output></output></div>';
      row.querySelector(".name").textContent = g.name;

      const color = row.querySelector(".swatch");
      color.value = s.color;
      color.style.background = s.color;
      color.addEventListener("input", function () {
        color.style.background = color.value;
        Y.Mat.set(g.id, { color: color.value });
      });

      const sel = row.querySelector("select");
      Y.PATTERNS.forEach(function (p) {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name;
        if (p.id === s.pattern) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { Y.Mat.set(g.id, { pattern: sel.value }); });

      const fines = row.querySelectorAll(".fine");
      const bind = function (el, keyName, fmt) {
        const input = el.querySelector("input"), out = el.querySelector("output");
        input.value = s[keyName];
        out.textContent = fmt(s[keyName]);
        input.addEventListener("input", function () {
          const v = parseFloat(input.value);
          out.textContent = fmt(v);
          const patch = {}; patch[keyName] = v;
          Y.Mat.set(g.id, patch);
        });
      };
      bind(fines[0], "metal", function (v) { return v.toFixed(2); });
      bind(fines[1], "rough", function (v) { return v.toFixed(2); });
      bind(fines[2], "scale", function (v) { return "×" + v; });

      pane.appendChild(row);
    });

    const btns = document.createElement("div");
    btns.className = "rowbtns";
    const exp = document.createElement("button");
    exp.className = "btn"; exp.textContent = "Exporter le jeu";
    exp.addEventListener("click", exportMaterials);
    const imp = document.createElement("button");
    imp.className = "btn"; imp.textContent = "Importer";
    imp.addEventListener("click", importMaterials);
    const rst = document.createElement("button");
    rst.className = "btn"; rst.textContent = "Réinitialiser";
    rst.addEventListener("click", function () { Y.Mat.reset(); buildMatPane(); });
    btns.append(exp, imp, rst);
    pane.appendChild(btns);
  }

  function exportMaterials() {
    const data = JSON.stringify({ format: "ylo2.materials/1", groups: Y.Mat.serialize() }, null, 1);
    navigator.clipboard.writeText(data).then(function () {
      flash("Jeu de matières copié dans le presse-papier");
    }, function () {
      flash("Copie refusée par le navigateur");
    });
  }

  function importMaterials() {
    const raw = prompt("Coller un jeu de matières (JSON) :");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      Y.Mat.load(data.groups || data);
      buildMatPane();
      flash("Matières appliquées");
    } catch (e) {
      flash("JSON illisible : " + e.message);
    }
  }

  /* =====================================================================
     Panneau « Simulation »
     ===================================================================== */
  const SCRIPTS = [
    { file: "trot_forward.py", name: "Trot en ligne droite",
      desc: "0,15 m/s pendant 8 s, avec relevé des butées articulaires." },
    { file: "turn_in_place.py", name: "Rotation sur place",
      desc: "ωz = 0,6 rad/s : montre le couplage abduction / hanche." },
    { file: "stand_squat.py", name: "Accroupissement",
      desc: "Balayage de la hauteur de caisse de 320 à 170 mm, les quatre pieds au sol." },
    { file: "joint_sweep.py", name: "Balayage articulaire",
      desc: "Chaque axe parcourt sa course URDF, un par un — contrôle des limites." },
    { file: "can_traffic.py", name: "Trafic CAN",
      desc: "Trames position envoyées par port PCAN, cadence et charge de bus." },
    { file: "backflip.py", name: "Salto arrière",
      desc: "La même figure que le bouton du bandeau, écrite en trajectoire rejouable." },
    { file: "souple_vs_brut.py", name: "Souple contre brut",
      desc: "Même consigne, deux styles : distance, vitesses articulaires, marge de stabilité." },
    { file: "felin_walk.py", name: "Marche féline",
      desc: "Voie étroite, triple appui, balancement du tronc, puis bascule en trot." },
    { file: "figures.py", name: "Enchaînement de figures",
      desc: "Salto arrière, double salto et 540 McTwist à la suite, en une trajectoire." },
    { file: "course.py", name: "Montée en vitesse",
      desc: "0,15 à 1,7 m/s : allure, cadence et temps de suspension à chaque palier." },
    { file: "escalier.py", name: "Escalier",
      desc: "Montée, palier, descente : le gouverneur ralentit tout seul à l'approche." },
    { file: "roues.py", name: "Roues motrices",
      desc: "Vitesse sur le plat, limite face à une marche, retour sur pattes." },
    { file: "roues_figures.py", name: "Figures sur roues",
      desc: "Cabrage vertical, tenue sur deux roues, saltos et McTwist, puis freinage." },
    { file: "roues_escalier.py", name: "Escalier en roues",
      desc: "La patte soulève la roue marche après marche, comme un Go2-W." },
    { file: "skatepark.py", name: "Skatepark",
      desc: "La mini-plaza en pattes puis en roues, recentrage et cabrage tenu." },
    { file: "session.py", name: "Session",
      desc: "Le run complet : quatre figures lancées par les rampes, slide final." }
  ];

  function buildSimPane() {
    const pane = document.getElementById("pane-sim");
    pane.innerHTML = "";

    const st = document.createElement("dl");
    st.className = "status"; st.id = "simStatus";
    pane.appendChild(st);

    const tr = document.createElement("div");
    tr.className = "transport"; tr.id = "simTransport";
    pane.appendChild(tr);

    const btns = document.createElement("div");
    btns.className = "rowbtns";
    const load = document.createElement("button");
    load.className = "btn primary"; load.textContent = "Charger une trajectoire";
    load.addEventListener("click", function () { document.getElementById("trajFile").click(); });
    const link = document.createElement("button");
    link.className = "btn"; link.textContent = "Serveur local";
    link.addEventListener("click", function () {
      if (M.live.status === "connecté") M.live.disconnect(); else M.live.connect("");
    });
    const back = document.createElement("button");
    back.className = "btn"; back.textContent = "Générateur interne";
    back.addEventListener("click", function () { M.live.disconnect(); M.play.clear(); });
    btns.append(load, link, back);
    pane.appendChild(btns);

    const head = document.createElement("section");
    head.className = "sect";
    head.innerHTML = '<h2>Scripts du dépôt</h2><p class="note">Le simulateur Python vit dans ' +
      '<code>sim/</code>. Il reprend la cinématique de l\'URDF et la logique d\'allure de CHAMP, ' +
      'puis écrit une trajectoire que cette page rejoue.</p>' +
      '<div class="cmd">pip install -e sim/ &amp;&amp; ylo2-sim list</div>';
    pane.appendChild(head);

    SCRIPTS.forEach(function (s) {
      const d = document.createElement("div");
      d.className = "script";
      d.innerHTML = "<b></b><span></span><div class='cmd'></div>";
      d.querySelector("b").textContent = s.name;
      d.querySelector("span").textContent = s.desc;
      d.querySelector(".cmd").textContent = "ylo2-sim run sim/scripts/" + s.file + " -o out/" + s.file.replace(".py", ".json");
      pane.appendChild(d);
    });

    const serve = document.createElement("section");
    serve.className = "sect";
    serve.innerHTML = '<h2>Pilotage en direct</h2><p class="note">Servez cette page depuis le ' +
      'simulateur pour piloter le robot simulé avec les curseurs, et voir la boucle Python ' +
      'à l\'écran.</p><div class="cmd">ylo2-sim serve --port 8770 --page index.html</div>';
    pane.appendChild(serve);

    refreshSimStatus();
  }

  function refreshSimStatus() {
    const st = document.getElementById("simStatus");
    if (!st) return;
    const src = M.state.source;
    const label = { internal: "Générateur interne", file: "Trajectoire Python", live: "Serveur local" }[src];
    const cls = src === "internal" ? "" : (src === "live" ? "on" : "warn");
    st.innerHTML =
      "<dt>Source</dt><dd><span class='pill " + cls + "'><i></i>" + label + "</span></dd>" +
      "<dt>Liaison</dt><dd>" + (M.live.available() ? M.live.status : "page statique") + "</dd>" +
      "<dt>Fichier</dt><dd>" + (M.play.traj ? M.play.name : "—") + "</dd>";
    refreshTransport();
  }

  function refreshTransport() {
    const tr = document.getElementById("simTransport");
    if (!tr) return;
    if (!M.play.traj) {
      tr.innerHTML = "<span class='note' style='font-size:12px;color:var(--dim)'>" +
        "Aucune trajectoire chargée : la page anime son propre générateur d'allure.</span>";
      return;
    }
    tr.innerHTML =
      "<div class='line'><button class='btn' id='simPlay'></button>" +
      "<input type='range' id='simSeek' min='0' max='1000' step='1'>" +
      "<span class='cmd' id='simTime' style='border:none;background:none;padding:0'></span></div>" +
      "<div class='line'><label style='font-size:11px;color:var(--dim)'>Vitesse</label>" +
      "<select id='simSpeed'><option value='0.25'>×0,25</option><option value='0.5'>×0,5</option>" +
      "<option value='1' selected>×1</option><option value='2'>×2</option></select>" +
      "<span style='font-size:11px;color:var(--faint)' id='simInfo'></span></div>";
    const play = document.getElementById("simPlay");
    play.textContent = M.play.playing ? "Pause" : "Lecture";
    play.addEventListener("click", function () {
      M.play.playing = !M.play.playing;
      play.textContent = M.play.playing ? "Pause" : "Lecture";
    });
    document.getElementById("simSeek").addEventListener("input", function (e) {
      M.play.t = (e.target.value / 1000) * M.play.duration;
    });
    document.getElementById("simSpeed").addEventListener("change", function (e) {
      M.play.speed = parseFloat(e.target.value);
    });
    document.getElementById("simInfo").textContent =
      M.play.traj.frames.length + " images · " + (1 / M.play.dt).toFixed(0) + " Hz";
  }

  document.getElementById("trajFile").addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        M.play.load(JSON.parse(reader.result), file.name);
        flash("Trajectoire « " + file.name + " » chargée");
      } catch (err) {
        flash("Lecture impossible : " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  /* =====================================================================
     Fiche
     ===================================================================== */
  const detail = document.getElementById("detail");
  let jtBody = null;

  function renderDetail(sys) {
    if (!sys) {
      const geoLine = Y.Geo.ready
        ? "Maillages du dépôt : " + Y.Geo.stats.parts + " pièces, " +
          Y.Geo.stats.tris.toLocaleString("fr-FR") + " triangles."
        : "Maillages indisponibles (" + (Y.Geo.error || "inconnu") + ") : silhouette de secours.";
      detail.innerHTML =
        '<div class="head"><p class="eyebrow">Banc cinématique</p>' +
        '<h3>YLO-2, quadrupède 12 axes</h3>' +
        '<p>Robot conçu de zéro par Vincent Foucault : châssis imprimé 3D et tubes carbone, ' +
        'jambes CNC en 7075, douze actionneurs mjbots pilotés en CAN-FD depuis une UP Xtreme ' +
        'sous ROS Noetic. La géométrie affichée est celle des maillages du dépôt, montée sur ' +
        'la chaîne articulaire de l\'URDF.</p>' +
        '<p>' + geoLine + '</p></div>' +
        '<div id="jtWrap"></div>';
      mountJointTable();
      return;
    }
    detail.innerHTML =
      '<div class="head"><p class="eyebrow">' + sys.group + ' · ' + sys.qty + '</p>' +
      '<h3></h3><p class="d"></p></div>' +
      '<dl class="specs"></dl>' +
      '<div class="pathrow"><div class="path"></div></div>' +
      '<div id="jtWrap"></div>';
    detail.querySelector("h3").textContent = sys.name;
    detail.querySelector(".d").textContent = sys.desc;
    const dl = detail.querySelector(".specs");
    sys.specs.forEach(function (kv) {
      const row = document.createElement("div"); row.className = "spec";
      const dt = document.createElement("dt"); dt.textContent = kv[0];
      const dd = document.createElement("dd"); dd.textContent = kv[1];
      row.append(dt, dd); dl.appendChild(row);
    });
    detail.querySelector(".path").textContent = sys.path;
    if (sys.link) {
      const a = document.createElement("a");
      a.className = "linkout"; a.href = sys.link; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Voir dans le dépôt ↗";
      detail.querySelector(".pathrow").appendChild(a);
    }
    mountJointTable();
  }

  function mountJointTable() {
    const wrap = document.getElementById("jtWrap");
    if (!wrap) { jtBody = null; return; }
    const sect = document.createElement("div");
    sect.className = "sect";
    sect.innerHTML = '<h2>Télémétrie articulaire (°)</h2>' +
      '<table class="jt"><thead><tr><th>Patte</th><th>HAA</th><th>HFE</th><th>KFE</th>' +
      '<th>CAN</th><th>État</th></tr></thead><tbody></tbody></table>';
    wrap.appendChild(sect);
    jtBody = sect.querySelector("tbody");
    Y.LEGS.forEach(function (L) {
      const tr = document.createElement("tr");
      tr.dataset.leg = L.id;
      tr.innerHTML = "<td>" + L.label + "</td><td></td><td></td><td></td><td></td><td></td>";
      tr.children[4].textContent = "P" + Y.CANMAP[L.id + "_haa"].port;
      jtBody.appendChild(tr);
    });
  }

  const deg = function (r) { return r * 180 / Math.PI; };
  function updateJointTable() {
    if (!jtBody) return;
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      const tr = jtBody.querySelector('tr[data-leg="' + L.id + '"]');
      if (!tr) return;
      const c = tr.children, q = n.q, bad = M.outOfLimits(q);
      c[1].textContent = deg(q[0]).toFixed(1);
      c[2].textContent = deg(q[1]).toFixed(1);
      c[3].textContent = deg(q[2]).toFixed(1);
      c[1].className = bad[0] ? "lim" : "";
      c[3].className = bad[2] ? "lim" : "";
      c[5].textContent = n.contact ? "appui" : "vol";
      tr.dataset.contact = n.contact ? "1" : "0";
    });
  }

  /* =====================================================================
     HUD
     ===================================================================== */
  const bars = {};
  let lastGait = "";
  function buildGaitButtons() {
    const el = document.getElementById("gaits");
    const entries = Object.keys(Y.GAITS).map(function (k) {
      return { id: k, label: Y.GAITS[k].label };
    });
    entries.push({ id: "auto", label: "Auto" });
    entries.forEach(function (e) {
      const b = document.createElement("button");
      b.textContent = e.label;
      b.dataset.gait = e.id;
      b.title = e.id === "auto"
        ? "Laisse le style choisir l'allure selon la vitesse"
        : "Impose cette allure";
      b.addEventListener("click", function () { setGait(e.id); });
      el.appendChild(b);
    });
    syncGaitButtons();
  }

  function setMode(k) {
    if (k === M.state.mode) return;
    M.blendFrom(0.4);
    M.state.mode = k;
    Y.Robot.setWheels(k === "roues");
    // Une figure appartient à son train : elle ne survit pas au changement,
    // dans un sens comme dans l'autre. Sans ça une tenue maintenue continuait
    // de piloter le robot après le passage en pattes — dressé à 83° sur des
    // roues devenues invisibles — et son bouton « Reposer », reconstruit pour
    // l'autre mode, n'existait plus pour la relâcher.
    if (Y.Stunt.active) Y.Stunt.stop();
    Y.Natural.reset();
    clearTraces();
    document.querySelectorAll("#modes button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === k));
    });
    const vx = document.getElementById("sVx");
    vx.max = k === "roues" ? Y.SPEED.wheelMax : Y.SPEED.max;
    if (M.state.vx > vx.max) { vx.value = vx.max; vx.dispatchEvent(new Event("input")); }
    // en roues, seule « Statique » reste active : elle sert de frein
    document.querySelectorAll("#gaits button").forEach(function (b) {
      b.disabled = k === "roues" && b.dataset.gait !== "stand";
    });
    document.querySelectorAll("#styles button").forEach(function (b) {
      b.disabled = k === "roues";
    });
    buildStuntButtons();
    if (Y.Session.state.running) Y.Session.stop();
    document.getElementById("sessionrow").hidden = k !== "roues";
    flash(k === "roues"
      ? "Roues motrices : jusqu'à " + Y.SPEED.wheelMax.toFixed(1) + " m/s sur terrain roulant"
      : "Retour sur pattes");
  }

  function buildTerrainSelect() {
    const sel = document.getElementById("terrain");
    Y.Terrain.presets.forEach(function (t) {
      const o = document.createElement("option");
      o.value = t.id; o.textContent = t.name; o.title = t.desc;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      Y.Terrain.set(sel.value);
      recenter();                              // sinon le robot peut se retrouver dans un mur
      const t = Y.Terrain.current;
      flash(t.name + (t.maxStep ? " · marche " + Math.round(t.maxStep * 1000) + " mm" : ""));
    });
  }

  function setStyle(k) {
    if (k !== M.state.style) M.blendFrom(0.35);   // pas de saut de pose
    M.state.style = k;
    // on change de profil sans réinitialiser : la posture est fondue en marche
    if (k !== "brut") Y.Natural.setProfile(k);
    document.querySelectorAll("#styles button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.style === k));
    });
  }

  /**
   * Déclenche une figure. `charge` garde l'armement sous tension : le robot
   * se prépare — et continue de rouler — jusqu'à ce qu'on relâche le bouton.
   */
  function launchStunt(name, charge) {
    if (M.state.source !== "internal") {
      flash("Les figures viennent du générateur interne : repassez sur cette source");
      return;
    }
    if (Y.Stunt.active) {
      const same = Y.Stunt.active === name;
      // une tenue se relâche proprement : on la repose au lieu de la couper
      if (same && Y.Stunt.sustaining()) { Y.Stunt.release(); return; }
      Y.Stunt.stop();
      if (same) return;
    }
    const ok = Y.Stunt.start(name, charge);
    if (ok === "pente") {
      flash("Tenue impossible ici : les quatre roues ne sont pas de niveau");
      return;
    }
    clearTraces();
  }

  /**
   * Remet le robot à son point de départ, à plat.
   *
   * « Au centre » sur la plupart des terrains ; en haut du roll-in sur la
   * mega ramp, parce qu'une transition de 2,60 m ne se remonte pas et qu'un
   * robot posé en bas n'aurait aucun moyen d'y accéder.
   */
  function recenter() {
    if (Y.Stunt.active) Y.Stunt.stop();
    const home = Y.Terrain.start();
    M.state.px = home[0]; M.state.py = home[1]; M.state.yaw = home[2];
    M.state.roll = 0; M.state.pitch = 0; M.state.yawWag = 0;
    M.state.phase = 0;
    // la garde au sol n'est pas la même sur pattes et sur roues : en roues
    // la caisse est portée par l'essieu, à un rayon au-dessus du sol
    const ground = Y.Terrain.heightAt(home[0], home[1]);
    M.state.z = M.state.mode === "roues"
      ? ground + M.state.height * 0.92 + Y.Natural.wheelRadius
      : ground + M.state.height;
    Y.Natural.reset();
    M.blendFrom(0.3);
    clearTraces();
    flash(home[0] || home[1] ? "Robot replacé au départ" : "Robot replacé au centre");
  }

  function buildStuntButtons() {
    const row = document.getElementById("stunts");
    row.innerHTML = "";
    Y.Stunt.forMode(M.state.mode).forEach(function (id) {
      const f = Y.Stunt.figures[id];
      const b = document.createElement("button");
      b.className = "stunt";
      b.dataset.stunt = id;
      b.textContent = f.label;
      b.title = (f.kind === "tilt"
        ? (f.axis === "roll" ? "tenue sur les deux roues droites" : "train avant en l'air") +
          " · " + Math.round(Math.abs(f.angle) * 180 / Math.PI) + "° de bascule"
        : (f.turns ? f.turns + " tour" + (f.turns > 1 ? "s" : "") : "sans rotation") +
          (f.twist ? " + " + (f.twist * 360) + "° de vrille" : "")) +
        (f.sustain && f.kind === "tilt"
         ? " · tenue jusqu'au prochain appui sur le bouton"
         : f.sustain ? " · au bouton, une fois ; en PLAY, tenue tant qu'on garde la commande"
         : f.flight ? " · vol " + f.flight.toFixed(2) + " s · apex +" + f.apex.toFixed(2) +
                      " m · appui maintenu : le robot arme son saut en roulant, "
                      + "et détend au relâchement"
                    : " · " + f.duration.toFixed(1) + " s au sol");
      // On garde l'armement tant que le bouton reste enfoncé, puis on
      // détend au relâchement. Un simple clic reste un simple clic : appui
      // et relâchement s'enchaînent, la figure part comme avant.
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        b.setPointerCapture && b.setPointerCapture(e.pointerId);
        launchStunt(id, true);
      });
      ["pointerup", "pointercancel"].forEach(function (ev) {
        b.addEventListener(ev, function () { Y.Stunt.fire(); });
      });
      row.appendChild(b);
    });
  }

  function setGait(k) {
    if (M.state.mode === "roues") {
      if (k !== "stand") return;
      brake();                                // « Statique » freine les roues
      return;
    }
    if (k === "auto") {                       // rendre la main au choix automatique
      Y.Natural.setAuto(true);
      syncGaitButtons();
      return;
    }
    M.state.gait = k;
    Y.Natural.setAuto(false);                 // un choix explicite est respecté
    if (Y.Stunt.active) Y.Stunt.stop();
    syncGaitButtons();
    buildPhase();
    if (M.live.status === "connecté") M.live.send({ gait: k });
  }

  /** Écrit une consigne EN PASSANT PAR LE CURSEUR, pour que l'écran suive. */
  function setSlider(id, v) {
    const el = document.getElementById(id);
    if (!el || Math.abs(parseFloat(el.value) - v) < 1e-4) return;
    el.value = v;
    el.dispatchEvent(new Event("input"));
  }

  /** Arrêt franc : remet la consigne à zéro, curseurs compris. */
  function brake() {
    ["sVx", "sWz"].forEach(function (id) {
      const el = document.getElementById(id);
      el.value = 0;
      el.dispatchEvent(new Event("input"));
    });
    if (Y.Stunt.active) Y.Stunt.stop();
    flash("Arrêt");
  }

  function syncGaitButtons() {
    const auto = Y.Natural.isAuto();
    document.querySelectorAll("#gaits button").forEach(function (x) {
      if (M.state.mode === "roues") {
        x.setAttribute("aria-pressed", String(x.dataset.gait === "stand" &&
          Math.abs(M.state.vx) < 1e-3));
      } else if (x.dataset.gait === "auto") {
        x.setAttribute("aria-pressed", String(auto));
      } else {
        x.setAttribute("aria-pressed", String(!auto && x.dataset.gait === M.state.gait));
      }
    });
  }

  function buildPhase() {
    const phaseEl = document.getElementById("phase");
    phaseEl.innerHTML = "";
    const G = Y.GAITS[M.state.gait] || Y.GAITS.trot;
    Y.LEGS.forEach(function (L) {
      const row = document.createElement("div"); row.className = "prow";
      const s = document.createElement("span"); s.textContent = L.label;
      const bar = document.createElement("div"); bar.className = "bar";
      const start = (1 - G.off[L.id]) % 1;
      const parts = start + G.duty > 1 ? [[start, 1], [0, start + G.duty - 1]] : [[start, start + G.duty]];
      parts.forEach(function (p) {
        const i = document.createElement("i");
        i.style.left = (p[0] * 100) + "%";
        i.style.width = ((p[1] - p[0]) * 100) + "%";
        bar.appendChild(i);
      });
      const cur = document.createElement("div"); cur.className = "cursor";
      bar.appendChild(cur); bars[L.id] = cur;
      row.append(s, bar); phaseEl.appendChild(row);
    });
  }

  function bindSlider(id, out, keyName, fmt, cmdKey) {
    const el = document.getElementById(id), o = document.getElementById(out);
    function sync() {
      M.state[keyName] = parseFloat(el.value);
      o.textContent = fmt(M.state[keyName]);
      if (cmdKey && M.live.status === "connecté") {
        const cmd = {}; cmd[cmdKey] = M.state[keyName];
        M.live.send(cmd);
      }
    }
    el.addEventListener("input", sync); sync();
  }

  /* --- panneaux : superposés en étroit, colonnes repliables en large --- */
  function openPanel(which, force) {
    const el = document.getElementById(which);
    const btn = document.getElementById(which === "rail" ? "btnRail" : "btnDetail");
    if (innerWidth > 1080) {
      // Sur grand écran le panneau est une colonne de la grille : le replier
      // rend ses 262 ou 318 px à la scène au lieu de les lui prendre. Les
      // deux ensemble, c'est la moitié d'un écran de portable.
      const main = document.querySelector(".main");
      const on = force !== undefined ? force : main.dataset[which] === "off";
      main.dataset[which] = on ? "on" : "off";
      btn.setAttribute("aria-pressed", String(on));
      return;
    }
    const on = force !== undefined ? force : !el.classList.contains("open");
    el.classList.toggle("open", on);
    btn.setAttribute("aria-pressed", String(on));
  }
  function closeRail() { openPanel("rail", false); }

  /** Affiche la correspondance des commandes, et l'état de la manette. */
  function renderPadmap() {
    const P = Y.Play.state;
    const box = document.getElementById("padmap");
    const src = document.querySelector("#playsrc button[aria-pressed=true]");
    const wanted = P.on ? P.source : (src ? src.dataset.src : "clavier");
    box.hidden = !P.on;
    document.getElementById("play").setAttribute("aria-pressed", String(P.on));
    document.getElementById("playsay").textContent = P.on ? (P.say || "à vous") : "";
    document.getElementById("padmaptitle").textContent =
      wanted === "manette" ? "Manette" : "Clavier";
    document.querySelectorAll("#padmaptable tr").forEach(function (tr, i) {
      tr.cells[0].textContent = wanted === "manette" ? Y.Play.map[i].pad : Y.Play.map[i].key;
    });
    const note = document.getElementById("padnote");
    if (wanted !== "manette") {
      note.textContent = "Au sol, chaque touche lance sa figure. En l'air, la même touche fait "
        + "tourner le vol en cours : on quitte la lèvre d'abord, on choisit ensuite.";
    } else if (P.padName) {
      // La disposition retenue est affichée : sur une manette exposée en HID
      // brut, ce n'est pas la même que sur une manette « standard », et
      // savoir laquelle a été reconnue est la première chose à vérifier si
      // un bouton ne tombe pas juste.
      note.textContent = "Manette : " + P.padName +
        (P.padLayout ? " · " + P.padLayout : "");
    } else {
      note.textContent = "Aucune manette détectée. Branchez-la ou appairez-la, " +
        "puis appuyez sur un bouton : le navigateur ne la déclare qu'au premier appui.";
    }
  }

  /**
   * Chronomètre du parcours.
   *
   * Il part quand le robot QUITTE la zone de départ — pas quand on appuie sur
   * un bouton : c'est le premier mètre parcouru qui compte — et il s'arrête
   * en entrant dans la zone d'arrivée. Revenir se poser sur le départ remet
   * tout à zéro, ce qui permet de retenter sans rien réinitialiser.
   */
  function stepCourse(dt) {
    if (!Y.Terrain.current.zones) {
      if (course.running || course.done) { course.running = false; course.done = 0; }
      return;
    }
    const here = Y.Terrain.zoneAt(M.state.px, M.state.py);
    if (here === "start") {
      if (course.running || course.done) flash("Départ armé");
      course.t = 0; course.armed = true; course.running = false; course.done = 0;
      return;
    }
    if (course.armed) { course.armed = false; course.running = true; }
    if (!course.running) return;
    course.t += dt;
    if (here === "finish") {
      course.running = false;
      course.done = course.t;
      const better = !course.best || course.t < course.best;
      if (better) course.best = course.t;
      flash("Arrivée — " + course.t.toFixed(2) + " s"
        + (better ? "   meilleur temps" : "   record " + course.best.toFixed(2) + " s"));
    }
  }

  /**
   * Compteur d'enchaînements.
   *
   * En l'air, il affiche ce qui est en train de se construire — chaque figure
   * bouclée s'y ajoute — et le vol qu'il reste pour en tenter une de plus. À
   * la réception, il fige l'enchaînement validé. C'est le seul retour qui
   * dise au joueur qu'il vient de gagner quelque chose.
   */
  function updateCombo() {
    const box = document.getElementById("combo");
    if (!box) return;
    const P = Y.Play.state;
    // le compteur ne sert qu'en PLAY, mais le chrono du parcours vaut aussi
    // pour qui roule aux curseurs
    box.hidden = !P.on && !course.running && !course.done;
    if (box.hidden) return;
    document.getElementById("comboScore").textContent = P.score.toLocaleString("fr-FR");
    const chain = document.getElementById("comboChain");
    const live = P.combo.length > 0;
    chain.textContent = live ? P.combo.join(" + ") : (P.last || "");
    chain.classList.toggle("live", live);
    const left = Y.Natural.airLeft();
    const chrono = course.running ? course.t.toFixed(2) + " s"
      : course.done ? course.done.toFixed(2) + " s · arrivée"
      : course.armed ? "au départ" : "";
    document.getElementById("comboAir").textContent =
      left > 0.05 ? "vol " + left.toFixed(2) + " s" : chrono;
  }

  /** Replie le bandeau de commandes : la scène est alors entièrement dégagée. */
  function toggleHud(force) {
    const hud = document.querySelector(".hud");
    const btn = document.getElementById("btnHud");
    const on = force !== undefined ? force : hud.classList.contains("folded");
    hud.classList.toggle("folded", !on);
    btn.setAttribute("aria-pressed", String(on));
  }

  /* --- avertissements : capacité des actionneurs, obstacle vs roues --- */
  function updateWarning(speed) {
    const el = document.getElementById("warnStrip");
    if (!el) return;
    let msg = "";
    if (M.state.mode === "roues") {
      const step = Y.Natural.wheelWarning();
      const v = Math.abs(Y.Natural.state.vx);
      if (Y.Natural.freeRolling() && v > 3.0) {
        // Une grande rampe rend bien plus de vitesse que les moteurs n'en
        // donnent. À ce régime, suivre le relief coûte plus que les 20 rad/s
        // de l'URDF : le mouvement est montré, il n'est pas certifié.
        msg = v.toFixed(1) + " m/s en roue libre : à cette vitesse, suivre le " +
          "relief demande plus que les 20 rad/s déclarés — mouvement montré, " +
          "hors spécification";
      } else if (step) msg = "Marche de " + Math.round(step * 1000) + " mm devant : au-delà de ce " +
        "qu'une roue de 75 mm franchit — repasser sur pattes (touche W)";
    } else if (speed > Y.SPEED.declared) {
      msg = "Au-delà de " + Y.SPEED.declared.toFixed(2) + " m/s, les articulations " +
        "dépassent les 20 rad/s déclarés dans l'URDF : mouvement montré, hors spécification";
    }
    el.textContent = msg;
    el.classList.toggle("on", !!msg);
  }

  /* --- message éphémère --- */
  let flashEl = null, flashTimer = 0;
  function flash(msg) {
    if (!flashEl) {
      flashEl = document.createElement("div");
      flashEl.className = "tag on";
      flashEl.style.cssText = "left:50%;top:auto;bottom:14px;transform:translateX(-50%);" +
        "border-left-color:var(--accent);z-index:8";
      document.getElementById("tags").appendChild(flashEl);
    }
    flashEl.textContent = msg;
    flashEl.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flashEl.classList.remove("on"); }, 3200);
  }

  /* =====================================================================
     Boucle
     ===================================================================== */
  const tagsEl = document.getElementById("tags");
  const tagEls = {};
  const anchors = {};
  const readout = document.getElementById("readout");
  const camTarget = new T.Vector3();
  const _p = new T.Vector3(), _v = new T.Vector3();
  let last = performance.now(), acc = 0;

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function clearTraces() {
    Y.LEGS.forEach(function (L) { traces[L.id].pts.length = 0; });
  }

  function updateTraces() {
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id], tr = traces[L.id];
      n.foot.getWorldPosition(n.world);
      if (!view.trace) { tr.geo.setDrawRange(0, 0); return; }
      const lastPt = tr.pts[tr.pts.length - 1];
      if (!lastPt || n.world.distanceTo(lastPt) > 0.004) {
        tr.pts.push(n.world.clone());
        if (tr.pts.length > TRACE_N) tr.pts.shift();
        const arr = tr.geo.attributes.position.array;
        for (let i = 0; i < tr.pts.length; i++) {
          arr[i * 3] = tr.pts[i].x; arr[i * 3 + 1] = tr.pts[i].y; arr[i * 3 + 2] = tr.pts[i].z;
        }
        tr.geo.attributes.position.needsUpdate = true;
        tr.geo.setDrawRange(0, tr.pts.length);
      }
    });
  }

  function updateSupport() {
    poly.visible = comDot.visible = view.support;
    if (!view.support) return;
    const pts = ["lf", "rf", "rh", "lh"].map(function (id) { return Y.Robot.legs[id]; })
      .filter(function (n) { return n.contact; }).map(function (n) { return n.world; });
    const arr = polyGeo.attributes.position.array;
    for (let i = 0; i < pts.length; i++) {
      arr[i * 3] = pts[i].x; arr[i * 3 + 1] = pts[i].y; arr[i * 3 + 2] = 0.002;
    }
    polyGeo.attributes.position.needsUpdate = true;
    polyGeo.setDrawRange(0, pts.length >= 2 ? pts.length : 0);
    comDot.position.set(Y.Robot.root.position.x, Y.Robot.root.position.y, 0.004);
  }

  function updateTags() {
    const r = canvas.getBoundingClientRect();
    const taken = [];
    Y.SYS.forEach(function (s) {
      const el = tagEls[s.id];
      const sel = view.selected === s.id;
      const show = sel || (view.explodeOn && s.group !== "Logiciel");
      if (!show) { el.classList.remove("on", "sel"); return; }
      const a = anchors[s.id];
      if (a) a.getWorldPosition(_p);
      else _p.set(s.at[0], s.at[1], s.at[2]).applyMatrix4(Y.Robot.body.matrixWorld);
      _p.project(camera);
      if (_p.z > 1) { el.classList.remove("on"); return; }
      let x = (_p.x * 0.5 + 0.5) * r.width, y = (-_p.y * 0.5 + 0.5) * r.height;
      for (let i = 0; i < taken.length; i++) {
        if (Math.abs(taken[i][0] - x) < 150 && Math.abs(taken[i][1] - y) < 19) { y = taken[i][1] + 20; i = -1; }
      }
      taken.push([x, y]);
      el.style.left = x + "px"; el.style.top = y + "px";
      el.classList.add("on");
      el.classList.toggle("sel", sel);
    });
  }

  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;

    M.state.frozen = view.explodeOn;
    if (Y.Session.state.running) Y.Session.step(dt);
    Y.Play.step(dt);
    M.step(dt);
    if (Y.Session.state.running) followSession(dt);

    const target = view.explodeOn ? 1 : 0;
    view.explode += (target - view.explode) * Math.min(1, dt * 5);
    Y.Robot.explode(view.explode);

    updateTraces();
    updateSupport();
    stepCourse(dt);
    if (Y.Robot.extras.lidarSpin) Y.Robot.extras.lidarSpin.rotation.z += dt * 9;
    (Y.Robot.extras.leds || []).forEach(function (o) {
      const d = ((o.userData.led / 12) - M.state.phase + 1) % 1;
      o.material.emissiveIntensity = 0.1 + Math.pow(1 - d, 6) * 2.4;
    });

    const portrait = camera.aspect < 0.9;
    view.stunt += ((Y.Stunt.active ? 1 : 0) - view.stunt) * Math.min(1, dt * 3);
    view.speed += (clamp(Math.hypot(Y.Natural.state.vx, Y.Natural.state.vy) / 1.5, 0, 1) - view.speed)
      * Math.min(1, dt * 1.5);
    const baseZ = portrait ? 0.0 : M.state.height * 0.5 + 0.03;
    camTarget.set(Y.Robot.root.position.x, Y.Robot.root.position.y,
      lerp(baseZ, Math.max(baseZ, M.state.z * 0.72), view.stunt));
    const chase = 3.2 + Math.hypot(Y.Natural.state.vx, Y.Natural.state.vy) * 2.5;
    orbit.target.lerp(camTarget, Math.min(1, dt * chase));
    if (padLook && (padLook[0] || padLook[1])) {
      camTween = null;                       // la main reprend sur le cadrage
      grabCam(false);
      orbit.az -= padLook[0] * dt;
      // Le stick était déjà dans ce sens-là : poussé vers le haut, il monte le
      // point de vue. C'est la souris qui faisait l'inverse ; les deux
      // s'accordent maintenant.
      orbit.el = clamp(orbit.el - padLook[1] * dt, -0.35, 1.45);
    }
    /* Retour en vue de suivi. L'azimut vise l'arrière du SENS DE MARCHE et
       non l'arrière du robot : après un 540 il roule en fakie, et la caméra
       doit rester devant ce qui arrive, pas derrière ce qu'il regarde. */
    manualCam = Math.max(0, manualCam - dt);
    if (Y.Terrain.current.chase && !Y.Session.state.running && manualCam <= 0) {
      camTween = null;                       // la vue de suivi reprend la main
      {
        const fakie = (Y.Natural.state.dir || 1) < 0;
        const back = M.state.yaw + (fakie ? 0 : Math.PI);
        let da = (back - orbit.az) % (Math.PI * 2);
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        const k = Math.min(1, dt * 1.6);
        orbit.az += da * k;
        orbit.el += (CHASE.el - orbit.el) * k;
        orbit.dist += (CHASE.dist - orbit.dist) * k;
      }
    }
    if (camTween) {
      const e = 1 - Math.exp(-dt * 6);
      orbit.az += (camTween.az - orbit.az) * e;
      orbit.el += (camTween.el - orbit.el) * e;
      orbit.dist += (camTween.dist - orbit.dist) * e;
      if (Math.abs(camTween.dist - orbit.dist) < 0.002 && Math.abs(camTween.az - orbit.az) < 0.004) camTween = null;
    }
    placeCamera();
    key.target.position.copy(orbit.target);
    const ka = orbit.az + 0.75;
    key.position.set(orbit.target.x + Math.cos(ka) * 2, orbit.target.y + Math.sin(ka) * 2, 2.4);
    const ra = orbit.az - 2.2;
    rim.position.set(orbit.target.x + Math.cos(ra) * 2.4, orbit.target.y + Math.sin(ra) * 2.4, 0.9);
    rim.target.position.copy(orbit.target); rim.target.updateMatrixWorld();

    acc += dt;
    if (acc > 0.033) {
      acc = 0;
      Y.LEGS.forEach(function (L) {
        if (bars[L.id]) bars[L.id].style.left = (M.state.phase * 100) + "%";
      });
      updateJointTable();
      updateTags();
      updateCombo();
      if (M.state.mode === "roues") {
        syncGaitButtons();
      } else if (Y.Natural.isAuto()) {
        syncGaitButtons();
        if (M.state.gait !== lastGait) { lastGait = M.state.gait; buildPhase(); }
      }
      const G = Y.GAITS[M.state.gait] ||
        { label: M.state.mode === "roues" ? "Roues" : M.state.gait, duty: 1, stance: 1 };
      const src = M.state.source;
      const srcLabel = { internal: "générateur interne", file: "trajectoire Python", live: "serveur local" }[src];
      let lines = "Source <span class='src'>" + srcLabel + "</span><br>";
      if (Y.Stunt.active) {
        lines += "Figure <b>" + Y.Stunt.label() + "</b> · " + Y.Stunt.phase +
          (Y.Stunt.sustaining() ? " <span class='src'>maintenue</span>" : "") + "<br>" +
          "Hauteur de caisse <b>" + (M.state.z * 1000).toFixed(0) + " mm</b> · rotation <b>" +
          Math.abs(M.state.pitch * 180 / Math.PI).toFixed(0) + "°</b><br>";
        const bar = document.querySelector("#flipbar i");
        if (bar) bar.style.width = (Y.Stunt.progress * 100) + "%";
      }
      if (src === "file") {
        lines += "Fichier <b>" + M.play.name + "</b><br>" +
          "Lecture <b>" + M.play.t.toFixed(2) + " / " + M.play.duration.toFixed(2) + " s</b>" +
          " · ×" + M.play.speed + "<br>";
      } else {
        lines += "Allure <b>" + G.label + "</b> · cycle <b>" + (G.stance / G.duty).toFixed(2) + " s</b><br>" +
          "Appui <b>" + Math.round(G.duty * 100) + " %</b> · phase <b>" + M.state.phase.toFixed(2) + "</b><br>";
      }
      const realV = Math.hypot(Y.Natural.state.vx, Y.Natural.state.vy);
      const nContact = Y.LEGS.filter(function (L) { return Y.Robot.legs[L.id].contact; }).length;
      readout.innerHTML = lines +
        "Vitesse <b>" + realV.toFixed(2) + " m/s</b> · <b>" + (realV * 3.6).toFixed(1) + " km/h</b>" +
        (Y.Natural.state.dir < 0 ? " · <span class='src'>fakie, roues en arrière</span>" : "") + "<br>" +
        "Odométrie <b>" + Math.hypot(M.state.px, M.state.py).toFixed(2) + " m</b> · cap <b>" +
        ((M.state.yaw * 180 / Math.PI) % 360).toFixed(0) + "°</b><br>" +
        "Appuis au sol <b>" + nContact + " / 4</b>" +
        (Y.Natural.airborne() ? " · <span class='src'>suspension</span>" : "") +
        (Y.Natural.lastFlight() > 0.01
          ? "<br>Dernier temps de vol <b>" + (Y.Natural.lastFlight() * 1000).toFixed(0) + " ms</b>"
          : "") +
        "<br>Terrain <b>" + Y.Terrain.current.name + "</b> · sol <b>" +
        (Y.Terrain.heightAt(M.state.px, M.state.py) * 1000).toFixed(0) + " mm</b>";
      updateWarning(realV);
      const phaseTitle = document.querySelector(".card-phase h4");
      if (phaseTitle) {
        phaseTitle.textContent = src === "internal"
          ? "Diagramme d'appui" : "Diagramme d'appui (générateur interne)";
      }
      if (M.play.traj) {
        const seek = document.getElementById("simSeek");
        if (seek && document.activeElement !== seek) seek.value = (M.play.t / M.play.duration) * 1000;
        const tEl = document.getElementById("simTime");
        if (tEl) tEl.textContent = M.play.t.toFixed(2) + " / " + M.play.duration.toFixed(2) + " s";
      }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  /* =====================================================================
     Démarrage
     ===================================================================== */
  async function start() {
    Y.Mat.init();
    await Y.Geo.load();
    Y.Robot.build(scene);

    Y.SYS.forEach(function (s) {
      const el = document.createElement("div");
      el.className = "tag"; el.textContent = s.name;
      tagsEl.appendChild(el); tagEls[s.id] = el;
      anchors[s.id] = Y.Robot.anchorFor(s.focus || s.id);
    });

    buildSysPane();
    buildMatPane();
    buildSimPane();
    buildGaitButtons();
    buildPhase();

    bindSlider("sVx", "oVx", "vx", function (v) {
      return v.toFixed(2) + " m/s\n" + (v * 3.6).toFixed(1) + " km/h";
    }, "vx");
    bindSlider("sWz", "oWz", "wz", function (v) { return v.toFixed(2) + " rad/s"; }, "wz");
    bindSlider("sH", "oH", "height", function (v) { return (v * 1000).toFixed(0) + " mm"; }, "height");
    bindSlider("sSw", "oSw", "swing", function (v) { return (v * 1000).toFixed(0) + " mm"; }, "swing");

    document.getElementById("toggles").addEventListener("click", function (e) {
      const b = e.target.closest("button[data-tog]"); if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      const k = b.dataset.tog;
      if (k === "explode") view.explodeOn = on;
      if (k === "axes") {
        view.axes = on;
        Y.LEGS.forEach(function (L) {
          Y.Robot.legs[L.id].axes.forEach(function (a) { a.visible = on; });
        });
      }
      if (k === "trace") {
        view.trace = on;
        if (!on) Y.LEGS.forEach(function (L) { traces[L.id].pts.length = 0; });
      }
      if (k === "support") view.support = on;
    });
    document.getElementById("modes").addEventListener("click", function (e) {
      const b = e.target.closest("button[data-mode]"); if (b) setMode(b.dataset.mode);
    });
    buildTerrainSelect();
    document.getElementById("styles").addEventListener("click", function (e) {
      const b = e.target.closest("button[data-style]"); if (b) setStyle(b.dataset.style);
    });
    buildStuntButtons();
    Y.Stunt.onChange(function (st) {
      document.querySelectorAll("#stunts button").forEach(function (b) {
        const on = st.active === b.dataset.stunt;
        b.setAttribute("aria-pressed", String(on));
        const f = Y.Stunt.figures[b.dataset.stunt];
        b.textContent = !on ? f.label
          : Y.Stunt.charging() ? "Lâchez pour sauter"
          : f.sustain ? "Reposer" : "Annuler";
      });
      document.getElementById("flipbar").classList.toggle("on", !!st.active);
    });
    document.getElementById("views").addEventListener("click", function (e) {
      const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view);
    });
    document.querySelector(".tabs").addEventListener("click", function (e) {
      const b = e.target.closest("button[data-tab]"); if (!b) return;
      document.querySelectorAll(".tabs button").forEach(function (x) {
        x.setAttribute("aria-selected", String(x === b));
      });
      ["sys", "mat", "sim"].forEach(function (id) {
        document.getElementById("pane-" + id).dataset.open = String(id === b.dataset.tab);
      });
    });
    document.getElementById("recenter").addEventListener("click", recenter);
    document.getElementById("session").addEventListener("click", function () {
      if (Y.Session.state.running) { Y.Session.stop(); return; }
      if (Y.Terrain.current.id !== "skatepark") {   // le run est écrit pour la plaza
        document.getElementById("terrain").value = "skatepark";
        Y.Terrain.set("skatepark");
        recenter();
      } else {
        recenter();
      }
      if (!Y.Session.start()) flash("La session demande le mode roues");
    });
    Y.Session.onChange(function (st) {
      const b = document.getElementById("session");
      b.setAttribute("aria-pressed", String(st.running));
      b.textContent = st.running ? "Arrêter la session" : "Session AUTO";
      document.getElementById("sessionsay").textContent = st.running ? st.label : "";
    });
    document.getElementById("btnRail").addEventListener("click", function () { openPanel("rail"); });
    document.getElementById("btnDetail").addEventListener("click", function () { openPanel("detail"); });
    document.getElementById("btnHud").addEventListener("click", function () { toggleHud(); });

    /* --- mode PLAY : clavier ou manette --- */
    Y.Play.bind({
      setVx: function (v) { setSlider("sVx", v.toFixed(2)); },
      setWz: function (v) { setSlider("sWz", v.toFixed(2)); },
      setHeight: function (v) { setSlider("sH", v.toFixed(3)); },
      setBrake: function (on) { Y.Natural.setBrake(on); },
      // Le stick droit donne une VITESSE de caméra ; c'est la boucle de rendu
      // qui l'intègre, avec son propre pas de temps.
      look: function (az, el) { padLook = [az, el]; },
      flash: flash,
      mode: function (m) { if (M.state.mode !== m) setMode(m); }
    });
    // La correspondance vient du module : le panneau ne peut donc pas mentir
    // sur ce que fait la manette.
    document.getElementById("padmaptable").innerHTML = Y.Play.map.map(function (r) {
      return "<tr><td>" + r.pad + "</td><td>" + r.act + "</td></tr>";
    }).join("");
    document.getElementById("playsrc").addEventListener("click", function (e) {
      const b = e.target.closest("button[data-src]"); if (!b) return;
      document.querySelectorAll("#playsrc button").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      if (Y.Play.state.on) Y.Play.start(b.dataset.src);
      else renderPadmap();
    });
    document.getElementById("play").addEventListener("click", function () {
      if (Y.Play.state.on) { Y.Play.stop(); return; }
      const src = document.querySelector("#playsrc button[aria-pressed=true]").dataset.src;
      Y.Play.start(src);
    });
    Y.Play.onChange(renderPadmap);
    renderPadmap();

    addEventListener("keydown", function (e) {
      if (e.target && e.target.matches && e.target.matches("input, select, textarea")) return;
      // PLAY passe en premier : sinon `C` replierait le bandeau au lieu de
      // cabrer le robot, et les flèches ne piloteraient rien.
      if (Y.Play.key(e.key, true)) { e.preventDefault(); return; }
      const map = { "1": "iso", "2": "side", "3": "front", "4": "top" };
      if (map[e.key]) setView(map[e.key]);
      if (e.key === "Escape") select(null);
      if (e.key === " ") { e.preventDefault(); setGait(M.state.gait === "stand" ? "trot" : "stand"); }
      if (e.key === "w" || e.key === "W") setMode(M.state.mode === "roues" ? "pattes" : "roues");
      // Au clavier aussi l'armement se garde : `e.repeat` écarte la
      // répétition automatique, qui sinon relançait la figure dix fois par
      // seconde, et le relâchement de la touche détend.
      const figs = Y.Stunt.forMode(M.state.mode);
      const KEYS = { b: 0, d: 1, t: 2, f: 3, g: 4, h: 5 };
      const slot = KEYS[e.key.toLowerCase()];
      if (slot !== undefined && !e.repeat) {
        launchStunt(slot === 3 ? (figs[3] || figs[0]) : figs[slot], true);
      }
      if (e.key === "s" || e.key === "S") brake();
      if (e.key === "r" || e.key === "R") recenter();
      if (e.key === "a" || e.key === "A") document.getElementById("session").click();
      if (e.key === "c" || e.key === "C") toggleHud();
    });

    addEventListener("keyup", function (e) {
      if (e.target && e.target.matches && e.target.matches("input, select, textarea")) return;
      if (Y.Play.key(e.key, false)) { e.preventDefault(); return; }
      if ("bdtfgh".indexOf(e.key.toLowerCase()) >= 0) Y.Stunt.fire();
    });

    // changer de source téléporte le robot : on repart d'une trace vierge
    M.play.onChange(function () { clearTraces(); refreshSimStatus(); });
    M.live.onChange(function () { clearTraces(); refreshSimStatus(); });
    Y.Mat.onChange(function () { /* les matières sont partagées : rien à reconstruire */ });

    addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);

    window.__ylo = { Y: Y, scene: scene, camera: camera, orbit: orbit, view: view };

    Y.Terrain.set("plat");
    resize(); setView("iso", true); placeCamera(); select(null);
    boot.hidden = true;
    if (!Y.Geo.ready) flash("Maillages indisponibles : " + Y.Geo.error);
    requestAnimationFrame(tick);
  }

  start();
})(window.YLO);
