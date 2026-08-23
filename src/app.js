/* =====================================================================
   YLO-2 Kinematic Bench
   Visualiseur 3D du quadrupède YLO-2 (github.com/elpimous/ylo-2).
   Géométrie et limites articulaires extraites de
   champ_for_ylo2/ylo2_description/urdfs/const.xacro + leg.xacro,
   allures d'après ylo2_config/config/gait/gait.yaml.
   Repère URDF conservé : X avant, Y gauche, Z haut.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 1. Constantes machine (URDF) ---------- */
  const K = {
    trunkL: 0.569125, trunkW: 0.350, trunkH: 0.148521,
    legX: 0.387 / 2 - 0.019,      // ±0.1745 m, entraxe HAA avant/arrière
    legY: 0.1144 / 2 + 0.006,     // ±0.0632 m, entraxe HAA gauche/droite
    legZ: 0.023,                  // décalage vertical tronc -> axe HAA
    abad: 0.092,                  // décalage latéral HAA -> HFE
    L1: 0.215427,                 // cuisse, axe HFE -> axe KFE
    L2: 0.229819,                 // jambe, axe KFE -> sol
    footR: 0.0265,
    haaMin: -70 * Math.PI / 180, haaMax: 70 * Math.PI / 180,
    kfeMin: -159 * Math.PI / 180, kfeMax: -37 * Math.PI / 180,
    mass: { trunk: 3.128, hip: 0.599, upper: 1.080, lower: 0.175, foot: 0.078 }
  };
  K.total = K.mass.trunk + 4 * (K.mass.hip + K.mass.upper + K.mass.lower + K.mass.foot);

  const LEGS = [
    { id: "lf", label: "LF", m: +1, x: +K.legX, y: +K.legY },
    { id: "rf", label: "RF", m: -1, x: +K.legX, y: -K.legY },
    { id: "lh", label: "LH", m: +1, x: -K.legX, y: +K.legY },
    { id: "rh", label: "RH", m: -1, x: -K.legX, y: -K.legY }
  ];

  const GAITS = {
    stand: { label: "Statique", duty: 1, stance: 1, off: { lf: 0, rf: 0, lh: 0, rh: 0 } },
    walk:  { label: "Walk",  duty: 0.75, stance: 0.35, off: { lf: 0, rh: 0.25, rf: 0.5, lh: 0.75 } },
    trot:  { label: "Trot",  duty: 0.50, stance: 0.25, off: { lf: 0, rf: 0.5, lh: 0.5, rh: 0 } },
    pace:  { label: "Pace",  duty: 0.50, stance: 0.25, off: { lf: 0, lh: 0, rf: 0.5, rh: 0.5 } },
    bound: { label: "Bound", duty: 0.50, stance: 0.20, off: { lf: 0, rf: 0, lh: 0.5, rh: 0.5 } }
  };

  /* ---------- 2. Sous-systèmes (données du dépôt) ---------- */
  const SYS = [
    { id: "frame", group: "Structure", name: "Châssis imprimé + tubes carbone", qty: "3D + Ø1 mm",
      at: [0, 0, 0.02],
      desc: "Structure entièrement conçue de zéro : pièces imprimées 3D reliées par des tubes carbone de 1 mm d'épaisseur. Le tronc mesure 569 × 350 × 149 mm pour 3,128 kg déclarés dans l'URDF.",
      specs: [["Longueur", "569,1 mm"], ["Largeur", "350,0 mm"], ["Hauteur", "148,5 mm"], ["Masse tronc", "3,128 kg"], ["Masse totale", K.total.toFixed(2).replace(".", ",") + " kg"]],
      path: "champ_for_ylo2/ylo2_description/urdfs/const.xacro" },

    { id: "cover", group: "Structure", name: "Carénages peints 2K", qty: "×4",
      at: [0.12, 0, 0.085],
      desc: "Tous les capots sont imprimés 3D, poncés, peints puis vernis avec un vernis 2K. Ils ferment le volume électronique sans participer à la rigidité.",
      specs: [["Procédé", "FDM + apprêt"], ["Finition", "vernis 2K"], ["Rôle", "protection"]],
      path: "images/robot/body_cover.jpg" },

    { id: "legs", group: "Structure", name: "Jambes CNC alu 7075", qty: "×4",
      at: [K.legX, K.legY + K.abad, -0.12],
      desc: "Cuisses et jambes usinées CNC dans de l'aluminium 7075. La cuisse fait 215,4 mm d'axe HFE à axe KFE, la jambe 229,8 mm d'axe KFE au contact sol.",
      specs: [["Matière", "ALU 7075"], ["Cuisse L1", "215,4 mm"], ["Jambe L2", "229,8 mm"], ["Masse cuisse", "1,080 kg"], ["Masse jambe", "0,175 kg"]],
      path: "images/robot/legs_cnc.png" },

    { id: "belt", group: "Structure", name: "Transmission courroie GT3", qty: "550 dents",
      at: [K.legX, K.legY + K.abad, -0.11],
      desc: "Le genou est entraîné par une courroie crantée GT3 550 dents entre deux poulies alu CNC : rapport 3:1 au genou, en plus du 6:1 du réducteur moteur, soit 18:1 en sortie.",
      specs: [["Courroie", "GT3 · 550 dents"], ["Poulies", "alu CNC"], ["Rapport genou", "3 : 1"], ["Chaîne totale", "18 : 1"]],
      path: "images/robot/timing_belt_idea.png" },

    { id: "foot", group: "Structure", name: "Pieds silicone moulés", qty: "×4",
      at: [K.legX, K.legY + K.abad, -0.24],
      desc: "Pieds coulés en silicone dans un moule imprimé 3D, insérés en force comme une chaussette : remplacement immédiat en cas d'usure.",
      specs: [["Rayon", "26,5 mm"], ["Masse", "0,078 kg"], ["Moule", "imprimé 3D"], ["Montage", "insertion en force"]],
      path: "images/robot/foot_silicon_mold.jpg" },

    { id: "motors", group: "Actionneurs", name: "mjbots qdd100 beta 2", qty: "×12",
      at: [K.legX, K.legY, 0],
      desc: "Douze actionneurs BLDC quasi-direct-drive, trois par patte : abduction (HAA), hanche (HFE), genou (KFE). Réducteur planétaire 6:1 intégré, contrôleur moteus embarqué.",
      specs: [["Nombre", "12 (3 × 4 pattes)"], ["Réducteur", "6 : 1"], ["Couple max URDF", "15 N·m"], ["Vitesse max", "20 rad/s"], ["Course HAA", "±70°"], ["Course KFE", "−159° … −37°"]],
      path: "Mjbots/README.md", link: "https://github.com/elpimous/ylo-2/tree/main/Mjbots" },

    { id: "moteus", group: "Actionneurs", name: "Contrôleurs moteus r4-5", qty: "×12",
      at: [K.legX, K.legY, 0.02],
      desc: "Chaque articulation est pilotée en mode position par un moteus r4-5 sur bus CAN-FD. La bibliothèque C++ maison encode les trames, envoie les consignes et lit position / vitesse / couple.",
      specs: [["Bus", "CAN-FD"], ["Mode", "position"], ["Boucle", "4 ports × 3 moteurs"], ["Outil", "ZeroPosition"]],
      path: "moteus_driver/src/YloTwoPcanToMoteus.cpp", link: "https://github.com/elpimous/ylo-2/tree/main/moteus_driver" },

    { id: "power", group: "Énergie", name: "Batterie + power dist r4-3b", qty: "1",
      at: [-0.08, 0, -0.02],
      desc: "Accumulateur logé sous le tronc, distribution mjbots power dist r4-3b, et un BEC Hyper HV GSR-6005MD qui sort 12 V à 5 A (7 A crête) pour l'électronique.",
      specs: [["Distribution", "power dist r4-3b"], ["BEC", "GSR-6005MD"], ["Sortie", "12 V / 5 A"], ["Crête", "7 A"]],
      path: "UP-Xtreme/README.md" },

    { id: "upx", group: "Calcul", name: "UP Xtreme i7", qty: "1",
      at: [0.05, 0, 0.045],
      desc: "Calculateur embarqué sous Ubuntu avec noyau temps réel : c'est lui qui fait tourner ROS Noetic, le contrôleur CHAMP et le driver moteus.",
      specs: [["Carte", "UP Xtreme i7"], ["OS", "Ubuntu 18.04 / 20.04"], ["Noyau", "RT 5.5.143-rt64"], ["Middleware", "ROS Noetic"]],
      path: "UP-Xtreme/rt_5.5.143rt64_kernel", link: "https://github.com/elpimous/ylo-2/tree/main/UP-Xtreme" },

    { id: "peak", group: "Calcul", name: "PEAK PCAN-M.2 4 canaux", qty: "1",
      at: [0.05, 0.05, 0.062],
      desc: "Carte M.2 (PCIe) quatre ports CAN-FD : un port par patte, trois contrôleurs moteus par port. Le driver Linux PEAK 8.12 expose PCAN_PCIBUS1…4.",
      specs: [["Interface", "M.2 PCIe"], ["Ports", "4 × CAN-FD"], ["Répartition", "3 moteurs / port"], ["Driver", "PEAK 8.12.0"]],
      path: "Peak4can/ylo2_library", link: "https://github.com/elpimous/ylo-2/tree/main/Peak4can" },

    { id: "imu", group: "Perception", name: "myAHRS+ IMU", qty: "1",
      at: [0, 0, 0.058],
      desc: "Centrale inertielle 9 axes sur USB, lue par myahrs_driver côté ROS. Elle fournit l'attitude du tronc au contrôleur d'allure.",
      specs: [["Type", "AHRS 9 axes"], ["Liaison", "USB / ttyACM0"], ["Nœud ROS", "myahrs_driver"], ["État", "opérationnel"]],
      path: "Myahrs+/README.md", link: "https://github.com/elpimous/ylo-2/tree/main/Myahrs%2B" },

    { id: "lidar", group: "Perception", name: "RPLIDAR A2", qty: "1",
      at: [-0.02, 0, 0.125],
      desc: "Lidar 2D 360° monté sur le dessus du tronc, destiné au gmapping et à l'AMCL. Nœud rplidar_ros sur ttyUSB0.",
      specs: [["Balayage", "360° · 2D"], ["Nœud ROS", "rplidar_ros"], ["Port", "/dev/ttyUSB0"], ["Usage", "GMAPPING / AMCL"]],
      path: "Rplidar A2/README.md" },

    { id: "d435", group: "Perception", name: "RealSense D435", qty: "1",
      at: [0.288, 0, 0.005],
      desc: "Caméra de profondeur en façade, prévue pour la détection d'obstacles et l'analyse du terrain. Le maillage texturé de la D435 est déjà présent dans l'URDF.",
      specs: [["Type", "profondeur stéréo"], ["Position", "face avant"], ["Maillage", "ylo2_d435_textured.dae"], ["État", "en cours"]],
      path: "champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_d435_textured.dae" },

    { id: "t265", group: "Perception", name: "RealSense T265", qty: "1",
      at: [0.276, 0, 0.055],
      desc: "Caméra de tracking pour l'odométrie visuelle-inertielle, montée au-dessus de la D435.",
      specs: [["Type", "tracking VIO"], ["Position", "face avant haute"], ["Maillage", "ylo2_t265_textured.dae"], ["État", "en cours"]],
      path: "champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_t265_textured.dae" },

    { id: "mic", group: "Perception", name: "ReSpeaker Mic Array v2", qty: "4 micros",
      at: [0.10, 0, 0.10],
      desc: "Réseau de 4 microphones avec 12 LED RGB programmables et détection d'activité vocale. Les LED servent de retour d'état : ordres reçus, activité, humeur.",
      specs: [["Micros", "4"], ["LED", "12 RGB"], ["Fonctions", "VAD / DOA"], ["API", "pixel_ring"]],
      path: "Respeaker4mic/README.md" },

    { id: "srf10", group: "Perception", name: "Télémètres SRF10", qty: "×2",
      at: [0.285, 0.085, 0.005],
      desc: "Sonars I2C Devantech en façade, pour la détection rapprochée. L'I2C fonctionne sur l'UP Xtreme, l'intégration des capteurs reste à faire.",
      specs: [["Type", "sonar I2C"], ["Bus", "I2C UP Xtreme"], ["État", "à intégrer"]],
      path: "Devantech_SRF10/README.md" },

    { id: "champ", group: "Logiciel", name: "CHAMP · contrôleur d'allure", qty: "ROS Noetic", focus: "legs",
      at: [0, 0, -0.06],
      desc: "Le générateur d'allure CHAMP, adapté à YLO-2, calcule les trajectoires de pieds puis les angles articulaires envoyés aux moteus en mode position. Les valeurs des curseurs ci-dessous sont celles de gait.yaml.",
      specs: [["Hauteur nominale", "0,250 m"], ["Garde au sol", "0,040 m"], ["Durée d'appui", "0,250 s"], ["Vx max", "0,200 m/s"], ["ωz max", "1,000 rad/s"], ["Genoux", "orientation « >> »"]],
      path: "champ_for_ylo2/ylo2_config/config/gait/gait.yaml", link: "https://github.com/elpimous/ylo-2/tree/main/champ_for_ylo2" },

    { id: "wolf", group: "Logiciel", name: "WoLF · pile whole-body", qty: "simulation", focus: "frame",
      at: [0, 0, 0.14],
      desc: "Descriptions et essais WoLF (Whole-body Locomotion Framework) pour YLO-2, utilisés en simulation avant portage sur la machine réelle.",
      specs: [["Rôle", "whole-body control"], ["Support", "simulation"], ["Base", "k3lso_moteus"]],
      path: "Wolf_for_ylo2/wolf_descriptions", link: "https://github.com/elpimous/ylo-2/tree/main/Wolf_for_ylo2" }
  ];

  /* ---------- 3. Scène ---------- */
  const T = window.THREE;
  const canvas = document.getElementById("gl");
  const stage = document.getElementById("stage");
  const renderer = new T.WebGLRenderer({ canvas, antialias: true });
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

  // Environnement : sans réflexions, les matières métalliques rendent noir.
  // On génère un ciel d'atelier procédural, filtré en PMREM.
  (function buildEnv() {
    const c = document.createElement("canvas");
    c.width = 128; c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0.00, "#8fa3ab");   // plafond
    grad.addColorStop(0.42, "#4a534f");
    grad.addColorStop(0.52, "#23282a");   // ligne d'horizon
    grad.addColorStop(1.00, "#0c0e0d");   // sol
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
  scene.add(new T.HemisphereLight(0x9db4b0, 0x14181a, 0.6));
  const key = new T.DirectionalLight(0xfff0e2, 2.6);
  key.position.set(1.6, 2.0, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 9;
  key.shadow.camera.left = -1.4; key.shadow.camera.right = 1.4;
  key.shadow.camera.top = 1.4; key.shadow.camera.bottom = -1.4;
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const rim = new T.DirectionalLight(0xff8b4d, 0.55); scene.add(rim, rim.target);
  const fill = new T.DirectionalLight(0x9fd8c4, 0.5); fill.position.set(-1.0, 2.2, 0.6); scene.add(fill);

  // sol
  const ground = new T.Mesh(
    new T.PlaneGeometry(40, 40),
    new T.MeshStandardMaterial({ color: 0x191d1e, roughness: 0.95, metalness: 0.0 })
  );
  ground.receiveShadow = true; ground.position.z = -0.0005; scene.add(ground);
  const gridFine = new T.GridHelper(40, 400, 0x1d241f, 0x1d241f);
  const gridCoarse = new T.GridHelper(40, 80, 0x2c3a30, 0x2c3a30);
  [gridFine, gridCoarse].forEach(function (g) {
    g.rotation.x = Math.PI / 2; g.material.transparent = true;
    g.material.opacity = g === gridFine ? 0.32 : 0.6; scene.add(g);
  });

  /* ---------- 4. Matières ---------- */
  const MAT = {
    alu: new T.MeshStandardMaterial({ color: 0xc6ccc6, metalness: 0.62, roughness: 0.30 }),
    aluDark: new T.MeshStandardMaterial({ color: 0x8e968f, metalness: 0.55, roughness: 0.42 }),
    carbon: new T.MeshStandardMaterial({ color: 0x23272a, metalness: 0.3, roughness: 0.45 }),
    cover: new T.MeshStandardMaterial({ color: 0xd7dad2, metalness: 0.12, roughness: 0.42,
      transparent: true, opacity: 0.96 }),
    print: new T.MeshStandardMaterial({ color: 0x3a423c, metalness: 0.1, roughness: 0.8 }),
    pcb: new T.MeshStandardMaterial({ color: 0x1c6b48, metalness: 0.2, roughness: 0.6 }),
    pcbBlue: new T.MeshStandardMaterial({ color: 0x1d3f6b, metalness: 0.2, roughness: 0.6 }),
    motor: new T.MeshStandardMaterial({ color: 0x4a5450, metalness: 0.6, roughness: 0.38 }),
    silicone: new T.MeshStandardMaterial({ color: 0xff6a2b, metalness: 0.0, roughness: 0.85 }),
    belt: new T.MeshStandardMaterial({ color: 0x101210, metalness: 0.2, roughness: 0.8 }),
    glass: new T.MeshStandardMaterial({ color: 0x0d1116, metalness: 0.4, roughness: 0.15 }),
    battery: new T.MeshStandardMaterial({ color: 0x191d24, metalness: 0.25, roughness: 0.7 })
  };

  Object.keys(MAT).forEach(function (k) { MAT[k].envMapIntensity = 1.15; });

  function box(w, d, h, mat) { return new T.Mesh(new T.BoxGeometry(w, d, h), mat); }
  function cyl(r, h, mat, seg) {
    const m = new T.Mesh(new T.CylinderGeometry(r, r, h, seg || 24), mat);
    m.rotation.x = Math.PI / 2; return m;                       // axe le long de Z
  }
  function tube(a, b, r, mat) {                                  // segment entre deux points
    const A = new T.Vector3().fromArray(a), B = new T.Vector3().fromArray(b);
    const d = new T.Vector3().subVectors(B, A);
    const m = new T.Mesh(new T.CylinderGeometry(r, r, d.length(), 12), mat);
    m.position.copy(A).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.clone().normalize());
    return m;
  }
  function tagPart(obj, sysId, explode) {
    obj.traverse(function (o) {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.sys = sysId; }
    });
    obj.userData.sys = sysId;
    if (explode) obj.userData.explode = new T.Vector3().fromArray(explode);
    if (!obj.userData.home) obj.userData.home = obj.position.clone();
    exploders.push(obj);
    return obj;
  }
  const exploders = [];

  /* ---------- 5. Construction du robot ---------- */
  const robot = new T.Group(); scene.add(robot);           // pose odométrique
  const body = new T.Group(); robot.add(body);             // tronc

  // ossature : platines + tubes carbone
  const frame = new T.Group();
  const hx = K.trunkL / 2 - 0.03, hy = 0.072, deckZ = 0.052;
  [-deckZ, deckZ].forEach(function (z) {
    const deck = box(K.trunkL - 0.06, 0.168, 0.006, MAT.print);
    deck.position.set(0, 0, z); frame.add(deck);
  });
  [[+hy], [-hy]].forEach(function (p) {
    frame.add(tube([-hx, p[0], -deckZ], [hx, p[0], -deckZ], 0.008, MAT.carbon));
    frame.add(tube([-hx, p[0], deckZ], [hx, p[0], deckZ], 0.008, MAT.carbon));
    [-hx, hx].forEach(function (x) {
      frame.add(tube([x, p[0], -deckZ], [x, p[0], deckZ], 0.008, MAT.carbon));
    });
  });
  // traverses des paliers de hanche
  LEGS.forEach(function (L) {
    frame.add(tube([L.x, 0, 0], [L.x, L.y, 0], 0.014, MAT.aluDark));
  });
  body.add(tagPart(frame, "frame", [0, 0, 0]));

  // carénages haut / bas
  const coverTop = new T.Group();
  const cShell = box(K.trunkL * 0.92, K.trunkW * 0.62, 0.048, MAT.cover);
  const cCham = box(K.trunkL * 0.80, K.trunkW * 0.48, 0.020, MAT.cover);
  cCham.position.z = 0.032;
  const cLip = box(K.trunkL * 0.94, K.trunkW * 0.64, 0.006, MAT.print);
  cLip.position.z = -0.026;
  coverTop.add(cShell, cCham, cLip);
  [-1, 1].forEach(function (sgn) {
    const skirt = box(K.trunkL * 0.86, 0.005, 0.055, MAT.cover);
    skirt.position.set(0, sgn * K.trunkW * 0.31, -0.05);
    coverTop.add(skirt);
  });
  coverTop.position.set(0.01, 0, 0.082);
  body.add(tagPart(coverTop, "cover", [0, 0, 0.30]));
  const coverBot = box(K.trunkL * 0.8, K.trunkW * 0.5, 0.03, MAT.cover);
  coverBot.position.set(0, 0, -0.072);
  body.add(tagPart(coverBot, "cover", [0, 0, -0.26]));
  const nose = box(0.07, 0.18, 0.09, MAT.cover);
  nose.position.set(K.trunkL / 2 - 0.03, 0, 0.02);
  body.add(tagPart(nose, "cover", [0.28, 0, 0]));

  // batterie + distribution
  const batt = new T.Group();
  const bcell = box(0.17, 0.09, 0.05, MAT.battery); batt.add(bcell);
  const pdb = box(0.06, 0.05, 0.008, MAT.pcbBlue); pdb.position.set(-0.11, 0, 0.012); batt.add(pdb);
  batt.position.set(-0.08, 0, -0.028);
  body.add(tagPart(batt, "power", [0, 0, -0.42]));

  // UP Xtreme + PEAK M.2
  const upx = new T.Group();
  const upBoard = box(0.122, 0.12, 0.006, MAT.pcb); upx.add(upBoard);
  const cpu = box(0.032, 0.032, 0.014, MAT.aluDark); cpu.position.z = 0.01; upx.add(cpu);
  [[-0.04, 0.04], [0.04, -0.04], [0.04, 0.04]].forEach(function (p) {
    const c = box(0.014, 0.02, 0.007, MAT.motor); c.position.set(p[0], p[1], 0.007); upx.add(c);
  });
  upx.position.set(0.05, 0, 0.042);
  body.add(tagPart(upx, "upx", [0, 0, 0.52]));

  const peak = new T.Group();
  const pk = box(0.042, 0.022, 0.004, MAT.pcbBlue); peak.add(pk);
  for (let i = 0; i < 4; i++) {
    const port = box(0.008, 0.008, 0.006, MAT.motor);
    port.position.set(-0.014 + i * 0.009, 0.014, 0.004); peak.add(port);
  }
  peak.position.set(0.05, 0.05, 0.06);
  body.add(tagPart(peak, "peak", [0.1, 0.34, 0.52]));

  // IMU
  const imu = new T.Group();
  imu.add(box(0.034, 0.027, 0.005, MAT.pcbBlue));
  const chip = box(0.01, 0.01, 0.004, MAT.motor); chip.position.z = 0.004; imu.add(chip);
  imu.position.set(0, 0, 0.056);
  body.add(tagPart(imu, "imu", [0, -0.34, 0.5]));

  // Lidar
  const lidar = new T.Group();
  const lbase = cyl(0.038, 0.018, MAT.print); lbase.position.z = 0.009; lidar.add(lbase);
  const lhead = cyl(0.034, 0.024, MAT.motor); lhead.position.z = 0.03; lidar.add(lhead);
  const lwin = cyl(0.0345, 0.008, MAT.glass); lwin.position.z = 0.033; lidar.add(lwin);
  lidar.position.set(-0.02, 0, 0.108);
  body.add(tagPart(lidar, "lidar", [0, 0, 0.55]));
  const lidarSpin = lhead;

  // ReSpeaker
  const mic = new T.Group();
  const disc = cyl(0.035, 0.008, MAT.print); mic.add(disc);
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    const led = cyl(0.0032, 0.003, new T.MeshStandardMaterial({
      color: 0x120f0c, emissive: 0xff6a2b, emissiveIntensity: 0.15, roughness: 0.6
    }), 8);
    led.position.set(Math.cos(a) * 0.028, Math.sin(a) * 0.028, 0.005);
    led.userData.led = i; mic.add(led);
  }
  mic.position.set(0.10, 0, 0.106);
  body.add(tagPart(mic, "mic", [0, 0, 0.6]));

  // RealSense D435 / T265
  const d435 = new T.Group();
  d435.add(box(0.026, 0.09, 0.025, MAT.aluDark));
  [-0.03, 0, 0.03].forEach(function (y) {
    const lens = cyl(0.0075, 0.006, MAT.glass, 16);
    lens.rotation.set(0, Math.PI / 2, 0); lens.position.set(0.013, y, 0); d435.add(lens);
  });
  d435.position.set(K.trunkL / 2 + 0.004, 0, 0.002);
  body.add(tagPart(d435, "d435", [0.55, 0, 0]));

  const t265 = new T.Group();
  t265.add(box(0.014, 0.108, 0.026, MAT.motor));
  [-0.04, 0.04].forEach(function (y) {
    const lens = cyl(0.008, 0.005, MAT.glass, 16);
    lens.rotation.set(0, Math.PI / 2, 0); lens.position.set(0.008, y, 0.003); t265.add(lens);
  });
  t265.position.set(K.trunkL / 2 - 0.008, 0, 0.052);
  body.add(tagPart(t265, "t265", [0.5, 0, 0.2]));

  // SRF10
  [0.085, -0.085].forEach(function (y, i) {
    const s = new T.Group();
    [-0.011, 0.011].forEach(function (dz) {
      const c = cyl(0.0085, 0.012, MAT.aluDark, 16);
      c.rotation.set(0, Math.PI / 2, 0); c.position.set(0, dz, 0); s.add(c);
    });
    s.position.set(K.trunkL / 2 - 0.004, y, 0.004);
    body.add(tagPart(s, "srf10", [0.4, y * 3, 0]));
  });

  /* --- pattes --- */
  const legNodes = {};
  LEGS.forEach(function (L) {
    const hip = new T.Group();
    hip.position.set(L.x, L.y, K.legZ);
    body.add(hip);

    // moteur HAA (axe X)
    const haaMotor = new T.Group();
    const hm = cyl(0.046, 0.058, MAT.motor); hm.rotation.set(0, Math.PI / 2, 0);
    haaMotor.add(hm);
    const hcap = cyl(0.024, 0.062, MAT.aluDark); hcap.rotation.set(0, Math.PI / 2, 0);
    haaMotor.add(hcap);
    haaMotor.position.set(-0.03 * (L.x > 0 ? -1 : 1), 0, 0);
    hip.add(tagPart(haaMotor, "motors", [0, 0, 0]));

    // bras d'abduction jusqu'à l'axe HFE
    const abadArm = box(0.062, K.abad, 0.05, MAT.alu);
    abadArm.position.set(0, L.m * K.abad / 2, 0);
    hip.add(tagPart(abadArm, "motors", [0, 0, 0]));

    // moteur HFE
    const upper = new T.Group();
    upper.position.set(0, L.m * K.abad, 0);
    hip.add(upper);
    const hfeMotor = cyl(0.045, 0.05, MAT.motor);
    hfeMotor.rotation.set(Math.PI / 2, 0, 0);
    upper.add(tagPart(hfeMotor, "motors", [0, 0, 0]));
    const moteusBoard = box(0.045, 0.008, 0.045, MAT.pcbBlue);
    moteusBoard.position.set(0, L.m * 0.032, 0);
    upper.add(tagPart(moteusBoard, "moteus", [0, L.m * 0.5, 0.1]));

    // cuisse : caisson alu + courroie + poulies
    const thigh = new T.Group();
    const beam = box(0.043, 0.0374, K.L1 * 0.86, MAT.alu);
    beam.position.set(0, L.m * -0.006, -K.L1 / 2);
    thigh.add(beam);
    const web = box(0.022, 0.05, K.L1 * 0.6, MAT.aluDark);
    web.position.set(0, L.m * -0.006, -K.L1 / 2); thigh.add(web);
    upper.add(tagPart(thigh, "legs", [0, 0, 0]));

    const drive = new T.Group();
    const pulleyTop = cyl(0.026, 0.01, MAT.aluDark, 20); pulleyTop.rotation.set(Math.PI / 2, 0, 0);
    const pulleyBot = cyl(0.014, 0.01, MAT.aluDark, 20); pulleyBot.rotation.set(Math.PI / 2, 0, 0);
    pulleyBot.position.z = -K.L1;
    drive.add(pulleyTop, pulleyBot);
    [-0.0255, 0.0135].forEach(function (x) {
      const strand = box(0.004, 0.008, K.L1, MAT.belt);
      strand.position.set(x, 0, -K.L1 / 2); drive.add(strand);
    });
    drive.position.set(0, L.m * -0.028, 0);
    upper.add(tagPart(drive, "belt", [0, L.m * 0.45, 0]));

    // jambe
    const lower = new T.Group();
    lower.position.set(0, L.m * -0.001, -K.L1);
    upper.add(lower);
    const shank = box(0.0208, 0.016, K.L2 * 0.9, MAT.aluDark);
    shank.position.z = -K.L2 * 0.5;
    const shankTop = box(0.05, 0.02, 0.05, MAT.alu); shankTop.position.z = -0.012;
    const shankG = new T.Group(); shankG.add(shank, shankTop);
    lower.add(tagPart(shankG, "legs", [0, 0, 0]));

    const footG = new T.Group();
    const ball = new T.Mesh(new T.SphereGeometry(K.footR, 22, 16), MAT.silicone);
    footG.add(ball);
    const ankle = cyl(0.014, 0.03, MAT.aluDark, 16); ankle.position.z = 0.02; footG.add(ankle);
    footG.position.set(0, 0, -K.L2);
    lower.add(tagPart(footG, "foot", [0, 0, -0.2]));

    // repères d'axes articulaires
    const axes = new T.Group(); axes.visible = false;
    function axisMark(color, dir, parent) {
      const g = new T.Group();
      const mat = new T.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.9 });
      const a = cyl(0.0032, 0.20, mat, 8);
      const ring = new T.Mesh(new T.TorusGeometry(0.032, 0.0022, 6, 28), mat);
      if (dir === "x") { a.rotation.set(0, Math.PI / 2, 0); ring.rotation.set(0, Math.PI / 2, 0); }
      if (dir === "y") { a.rotation.set(Math.PI / 2, 0, 0); ring.rotation.set(Math.PI / 2, 0, 0); }
      g.add(a, ring); g.renderOrder = 6;
      g.traverse(function (o) { o.renderOrder = 6; });
      parent.add(g); return g;
    }
    const axHAA = axisMark(0xff6a2b, "x", hip);
    const axHFE = axisMark(0x77c2a6, "y", upper);
    const axKFE = axisMark(0x77c2a6, "y", lower);
    [axHAA, axHFE, axKFE].forEach(function (a) { a.visible = false; axes.add(a); });

    legNodes[L.id] = { L: L, hip: hip, upper: upper, lower: lower, foot: footG,
      axes: [axHAA, axHFE, axKFE], q: [0, 0, 0], contact: true, world: new T.Vector3() };
  });

  /* --- traces de pieds --- */
  const TRACE_N = 220;
  const traces = {};
  LEGS.forEach(function (L) {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(new Float32Array(TRACE_N * 3), 3));
    const line = new T.Line(geo, new T.LineBasicMaterial({
      color: L.m > 0 ? 0xff6a2b : 0x77c2a6, transparent: true, opacity: 0.75
    }));
    line.frustumCulled = false; scene.add(line);
    traces[L.id] = { line: line, pts: [], geo: geo };
  });

  /* --- polygone de sustentation + projection du centre de masse --- */
  const polyGeo = new T.BufferGeometry();
  polyGeo.setAttribute("position", new T.BufferAttribute(new Float32Array(5 * 3), 3));
  const poly = new T.LineLoop(polyGeo, new T.LineBasicMaterial({ color: 0xffc24d, transparent: true, opacity: 0.85 }));
  poly.frustumCulled = false; poly.visible = false; scene.add(poly);
  const comDot = new T.Mesh(new T.SphereGeometry(0.014, 16, 12),
    new T.MeshBasicMaterial({ color: 0xffc24d }));
  comDot.visible = false; scene.add(comDot);

  /* ---------- 6. Cinématique inverse ---------- */
  function ik(L, tx, ty, tz) {
    // cible exprimée dans le repère du tronc ; ramenée au repère hanche
    const x = tx - L.x, y = ty - L.y, z = tz - K.legZ;
    const off = L.m * K.abad;
    const r2 = y * y + z * z;
    const zp = -Math.sqrt(Math.max(r2 - off * off, 1e-6));
    const q1 = Math.atan2(z, y) - Math.atan2(zp, off);
    const X = -x, Z = -zp;                       // plan sagittal
    let D = Math.hypot(X, Z);
    const dmax = (K.L1 + K.L2) * 0.999, dmin = Math.abs(K.L1 - K.L2) + 0.02;
    D = Math.min(Math.max(D, dmin), dmax);
    const c3 = (D * D - K.L1 * K.L1 - K.L2 * K.L2) / (2 * K.L1 * K.L2);
    const q3 = -Math.acos(Math.min(1, Math.max(-1, c3)));
    const q2 = Math.atan2(X, Z) - Math.atan2(K.L2 * Math.sin(q3), K.L1 + K.L2 * Math.cos(q3));
    return [q1, q2, q3];
  }

  /* ---------- 7. Générateur d'allure ---------- */
  const state = {
    gait: "trot", vx: 0.12, vy: 0, wz: 0, height: 0.25, swing: 0.04,
    phase: 0, t: 0, px: 0, py: 0, yaw: 0,
    explode: 0, explodeOn: false, axes: false, trace: true, support: false,
    selected: null, view: "iso"
  };

  function smooth(s) { return s * s * (3 - 2 * s); }

  function stepGait(dt) {
    const G = GAITS[state.gait];
    // en vue éclatée on fige la machine : c'est un mode d'inspection
    const moving = state.gait !== "stand" && !state.explodeOn;
    const cycle = G.stance / G.duty;
    if (moving) state.phase = (state.phase + dt / cycle) % 1;

    // odométrie du tronc
    if (moving) {
      state.yaw += state.wz * dt;
      state.px += (state.vx * Math.cos(state.yaw) - state.vy * Math.sin(state.yaw)) * dt;
      state.py += (state.vx * Math.sin(state.yaw) + state.vy * Math.cos(state.yaw)) * dt;
    }

    const bob = moving ? Math.sin(state.phase * Math.PI * 4) * 0.006 : 0;
    const pitch = moving ? Math.sin(state.phase * Math.PI * 4 + 1.1) * 0.018 : 0;
    const roll = (state.gait === "pace" || state.gait === "walk")
      ? Math.sin(state.phase * Math.PI * 2) * 0.03 : 0;
    robot.position.set(state.px, state.py, state.height + K.footR + bob);
    robot.rotation.set(roll, pitch, state.yaw, "ZYX");

    LEGS.forEach(function (L) {
      const n = legNodes[L.id];
      const nx = L.x, ny = L.y + L.m * K.abad;              // pied au repos sous la hanche
      const vfx = state.vx - state.wz * ny;                  // v + ω × r
      const vfy = state.vy + state.wz * nx;
      const sweepX = vfx * G.stance, sweepY = vfy * G.stance;

      let ph = (state.phase + G.off[L.id]) % 1;
      let fx = nx, fy = ny, fz = -state.height, contact = true;

      if (moving) {
        if (ph < G.duty) {                                   // appui : recul dans le repère tronc
          const s = ph / G.duty;
          fx = nx + sweepX * (0.5 - s);
          fy = ny + sweepY * (0.5 - s);
          contact = true;
        } else {                                             // vol : retour + garde au sol
          const s = (ph - G.duty) / (1 - G.duty), e = smooth(s);
          fx = nx + sweepX * (-0.5 + e);
          fy = ny + sweepY * (-0.5 + e);
          fz = -state.height + Math.sin(Math.PI * s) * state.swing;
          contact = false;
        }
      }

      const q = ik(L, fx, fy, fz);
      n.q = q; n.contact = contact; n.phase = ph;
      n.hip.rotation.x = q[0];
      n.upper.rotation.y = q[1];
      n.lower.rotation.y = q[2];
    });
  }

  /* ---------- 8. Éclaté, axes, traces ---------- */
  const _v = new T.Vector3();
  function applyExplode(dt) {
    const target = state.explodeOn ? 1 : 0;
    state.explode += (target - state.explode) * Math.min(1, dt * 5);
    exploders.forEach(function (o) {
      if (!o.userData.explode) return;
      _v.copy(o.userData.home).addScaledVector(o.userData.explode, state.explode * 0.32);
      o.position.copy(_v);
    });
  }

  function updateTraces() {
    LEGS.forEach(function (L) {
      const n = legNodes[L.id], tr = traces[L.id];
      n.foot.getWorldPosition(n.world);
      if (!state.trace) { tr.geo.setDrawRange(0, 0); return; }
      const last = tr.pts[tr.pts.length - 1];
      if (!last || n.world.distanceTo(last) > 0.004) {
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
    poly.visible = comDot.visible = state.support;
    if (!state.support) return;
    const order = ["lf", "rf", "rh", "lh"];
    const pts = order.map(function (id) { return legNodes[id]; })
      .filter(function (n) { return n.contact; })
      .map(function (n) { return n.world; });
    const arr = polyGeo.attributes.position.array;
    const count = Math.max(pts.length, 2);
    for (let i = 0; i < count; i++) {
      const p = pts[i] || pts[0] || new T.Vector3();
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = 0.002;
    }
    polyGeo.attributes.position.needsUpdate = true;
    polyGeo.setDrawRange(0, pts.length >= 2 ? pts.length : 0);
    comDot.position.set(robot.position.x, robot.position.y, 0.004);
  }

  /* ---------- 9. Caméra orbitale ---------- */
  const orbit = { az: -0.85, el: 0.30, dist: 2.30, target: new T.Vector3(0, 0, 0.24) };
  let dragging = false, lastX = 0, lastY = 0, pointers = new Map(), pinch0 = 0;

  function placeCamera() {
    // sur un cadre étroit, on recule pour garder la machine entière dans le champ
    const fit = Math.min(Math.max(1.55 / camera.aspect, 1), 1.95);
    const d = orbit.dist * fit;
    const cd = Math.cos(orbit.el) * d;
    camera.position.set(
      orbit.target.x + Math.cos(orbit.az) * cd,
      orbit.target.y + Math.sin(orbit.az) * cd,
      orbit.target.z + Math.sin(orbit.el) * d
    );
    camera.lookAt(orbit.target);
  }

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    dragging = pointers.size === 1; lastX = e.clientX; lastY = e.clientY; camTween = null;
    if (pointers.size === 2) {
      const p = [...pointers.values()];
      pinch0 = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
    }
    downAt = [e.clientX, e.clientY];
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
    orbit.az -= (e.clientX - lastX) * 0.006;
    orbit.el = clamp(orbit.el + (e.clientY - lastY) * 0.005, -0.35, 1.45);
    lastX = e.clientX; lastY = e.clientY;
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
    if (pointers.size === 0) dragging = false;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    orbit.dist = clamp(orbit.dist * (1 + Math.sign(e.deltaY) * 0.09), 0.45, 6);
  }, { passive: false });
  function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

  const VIEWS = {
    iso: { az: -0.85, el: 0.30, dist: 2.30 },
    side: { az: -Math.PI / 2, el: 0.05, dist: 2.05 },
    front: { az: 0, el: 0.08, dist: 1.85 },
    top: { az: -Math.PI / 2, el: 1.40, dist: 2.45 }
  };
  let camTween = null;
  function setView(name) {
    state.view = name;
    const v = VIEWS[name];
    camTween = { az: v.az, el: v.el, dist: v.dist };
    document.querySelectorAll("#views button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.view === name));
    });
  }

  /* ---------- 10. Sélection & étiquettes ---------- */
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  let downAt = null;
  const tagsEl = document.getElementById("tags");
  const tagEls = {};
  SYS.forEach(function (s) {
    const el = document.createElement("div");
    el.className = "tag"; el.textContent = s.name;
    tagsEl.appendChild(el); tagEls[s.id] = el;
  });

  canvas.addEventListener("pointerup", function (e) {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 5) return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(robot.children, true)
      .find(function (h) { return h.object.userData.sys; });
    select(hit ? hit.object.userData.sys : null);
  });

  const highlighted = [];
  function select(id) {
    state.selected = id;
    highlighted.forEach(function (m) {
      m.material.emissive.setHex(m.userData.emis0);
      m.material.emissiveIntensity = m.userData.emisI0;
    });
    highlighted.length = 0;
    const sys = SYS.find(function (s) { return s.id === id; });
    const target = sys && sys.focus ? sys.focus : id;
    if (target) {
      robot.traverse(function (o) {
        if (o.isMesh && o.userData.sys === target && o.material.emissive) {
          if (o.userData.emis0 === undefined) {
            o.userData.emis0 = o.material.emissive.getHex();
            o.userData.emisI0 = o.material.emissiveIntensity;
          }
          o.material = o.material.clone();
          o.material.emissive = new T.Color(0xff6a2b);
          o.material.emissiveIntensity = 0.55;
          highlighted.push(o);
        }
      });
    }
    document.querySelectorAll(".node").forEach(function (b) {
      b.setAttribute("aria-current", String(b.dataset.sys === id));
    });
    renderDetail(sys);
  }

  /* ---------- 11. Interface ---------- */
  const rail = document.getElementById("rail");
  const groups = [];
  SYS.forEach(function (s) {
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
        if (innerWidth <= 1080) { rail.classList.remove("open"); openPanel("detail", true); }
      });
      sect.appendChild(b);
    });
    rail.appendChild(sect);
  });

  const detail = document.getElementById("detail");
  function renderDetail(sys) {
    if (!sys) {
      detail.innerHTML =
        '<div class="head"><p class="eyebrow">Banc cinématique</p>' +
        '<h3>YLO-2, quadrupède 12 axes</h3>' +
        '<p>Robot conçu de zéro par Vincent Foucault : châssis imprimé 3D et tubes carbone, ' +
        'jambes CNC en 7075, douze actionneurs mjbots pilotés en CAN-FD depuis une UP Xtreme sous ROS Noetic. ' +
        'Le modèle ci-contre reprend les cotes de l\'URDF du dépôt ; l\'allure est générée en direct ' +
        'puis résolue par cinématique inverse, articulation par articulation.</p>' +
        '<p>Choisissez un sous-système à gauche, ou cliquez une pièce dans la vue.</p></div>' +
        '<dl class="specs" id="jtWrap"></dl>';
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

  let jtBody = null;
  function mountJointTable() {
    const wrap = document.getElementById("jtWrap");
    if (!wrap) { jtBody = null; return; }
    const t = document.createElement("table");
    t.className = "jt";
    t.innerHTML = "<thead><tr><th>Patte</th><th>HAA</th><th>HFE</th><th>KFE</th><th>Phase</th></tr></thead><tbody></tbody>";
    const sect = document.createElement("div");
    sect.className = "sect";
    sect.innerHTML = '<h2>Télémétrie articulaire (°)</h2>';
    sect.appendChild(t);
    wrap.appendChild(sect);
    jtBody = t.querySelector("tbody");
    LEGS.forEach(function (L) {
      const tr = document.createElement("tr");
      tr.dataset.leg = L.id;
      tr.innerHTML = "<td>" + L.label + "</td><td></td><td></td><td></td><td></td>";
      jtBody.appendChild(tr);
    });
  }

  const deg = function (r) { return (r * 180 / Math.PI); };
  function updateJointTable() {
    if (!jtBody) return;
    LEGS.forEach(function (L) {
      const n = legNodes[L.id];
      const tr = jtBody.querySelector('tr[data-leg="' + L.id + '"]');
      if (!tr) return;
      const c = tr.children;
      const q = n.q;
      c[1].textContent = deg(q[0]).toFixed(1);
      c[2].textContent = deg(q[1]).toFixed(1);
      c[3].textContent = deg(q[2]).toFixed(1);
      c[4].textContent = n.contact ? "appui" : "vol";
      c[1].className = (q[0] < K.haaMin || q[0] > K.haaMax) ? "lim" : "";
      c[3].className = (q[2] < K.kfeMin || q[2] > K.kfeMax) ? "lim" : "";
      tr.dataset.contact = n.contact ? "1" : "0";
    });
  }

  // allures
  const gaitsEl = document.getElementById("gaits");
  Object.keys(GAITS).forEach(function (kx) {
    const b = document.createElement("button");
    b.textContent = GAITS[kx].label;
    b.dataset.gait = kx;
    b.setAttribute("aria-pressed", String(kx === state.gait));
    b.addEventListener("click", function () {
      state.gait = kx;
      document.querySelectorAll("#gaits button").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x.dataset.gait === kx));
      });
      buildPhase();
    });
    gaitsEl.appendChild(b);
  });

  // diagramme d'appui
  const phaseEl = document.getElementById("phase");
  const bars = {};
  function buildPhase() {
    phaseEl.innerHTML = "";
    const G = GAITS[state.gait];
    LEGS.forEach(function (L) {
      const row = document.createElement("div"); row.className = "prow";
      const s = document.createElement("span"); s.textContent = L.label;
      const bar = document.createElement("div"); bar.className = "bar";
      // segments d'appui, décalés de l'offset de la patte
      const start = (1 - G.off[L.id]) % 1;
      const segs = [[start, start + G.duty]];
      segs.forEach(function (sg) {
        let a = sg[0], b = sg[1];
        const parts = b > 1 ? [[a, 1], [0, b - 1]] : [[a, b]];
        parts.forEach(function (p) {
          const i = document.createElement("i");
          i.style.left = (p[0] * 100) + "%";
          i.style.width = ((p[1] - p[0]) * 100) + "%";
          bar.appendChild(i);
        });
      });
      const cur = document.createElement("div"); cur.className = "cursor";
      bar.appendChild(cur);
      bars[L.id] = cur;
      row.append(s, bar); phaseEl.appendChild(row);
    });
  }
  buildPhase();

  // curseurs
  function bindSlider(id, out, key, fmt) {
    const el = document.getElementById(id), o = document.getElementById(out);
    function sync() { state[key] = parseFloat(el.value); o.textContent = fmt(state[key]); }
    el.addEventListener("input", sync); sync();
  }
  bindSlider("sVx", "oVx", "vx", function (v) { return v.toFixed(3) + " m/s"; });
  bindSlider("sWz", "oWz", "wz", function (v) { return v.toFixed(2) + " rad/s"; });
  bindSlider("sH", "oH", "height", function (v) { return (v * 1000).toFixed(0) + " mm"; });
  bindSlider("sSw", "oSw", "swing", function (v) { return (v * 1000).toFixed(0) + " mm"; });

  // bascules
  document.getElementById("toggles").addEventListener("click", function (e) {
    const b = e.target.closest("button[data-tog]"); if (!b) return;
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    const k = b.dataset.tog;
    if (k === "explode") state.explodeOn = on;
    if (k === "axes") { state.axes = on; LEGS.forEach(function (L) { legNodes[L.id].axes.forEach(function (a) { a.visible = on; }); }); }
    if (k === "trace") { state.trace = on; if (!on) LEGS.forEach(function (L) { traces[L.id].pts.length = 0; }); }
    if (k === "support") state.support = on;
  });
  document.getElementById("views").addEventListener("click", function (e) {
    const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view);
  });

  // panneaux mobiles
  function openPanel(which, force) {
    const el = document.getElementById(which);
    const btn = document.getElementById(which === "rail" ? "btnRail" : "btnDetail");
    const on = force !== undefined ? force : !el.classList.contains("open");
    el.classList.toggle("open", on);
    btn.setAttribute("aria-pressed", String(on));
  }
  document.getElementById("btnRail").addEventListener("click", function () { openPanel("rail"); });
  document.getElementById("btnDetail").addEventListener("click", function () { openPanel("detail"); });

  // clavier
  addEventListener("keydown", function (e) {
    if (e.target.matches("input")) return;
    const map = { "1": "iso", "2": "side", "3": "front", "4": "top" };
    if (map[e.key]) setView(map[e.key]);
    if (e.key === "Escape") select(null);
    if (e.key === " ") { e.preventDefault(); state.gait = state.gait === "stand" ? "trot" : "stand";
      document.querySelectorAll("#gaits button").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x.dataset.gait === state.gait)); });
      buildPhase();
    }
  });

  /* ---------- 12. Boucle ---------- */
  const readout = document.getElementById("readout");
  let last = performance.now(), acc = 0;
  const camTarget = new T.Vector3();

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);

  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    state.t += dt;

    stepGait(dt);
    applyExplode(dt);
    updateTraces();
    updateSupport();
    lidarSpin.rotation.z += dt * 9;

    // LED ReSpeaker : chenillard synchronisé sur la phase d'allure
    mic.children.forEach(function (o) {
      if (o.userData.led === undefined) return;
      const d = ((o.userData.led / 12) - state.phase + 1) % 1;
      o.material.emissiveIntensity = 0.1 + Math.pow(1 - d, 6) * 2.4;
    });

    // caméra : suit le tronc
    // en portrait, on vise plus bas : la machine remonte au-dessus des cartes de commande
    const portrait = camera.aspect < 0.9;
    camTarget.set(robot.position.x, robot.position.y,
      portrait ? 0.02 : state.height * 0.55 + 0.16);
    orbit.target.lerp(camTarget, Math.min(1, dt * 3.2));
    if (camTween) {
      const e = 1 - Math.exp(-dt * 6);
      orbit.az += (camTween.az - orbit.az) * e;
      orbit.el += (camTween.el - orbit.el) * e;
      orbit.dist += (camTween.dist - orbit.dist) * e;
      if (Math.abs(camTween.dist - orbit.dist) < 0.002 &&
          Math.abs(camTween.az - orbit.az) < 0.004) camTween = null;
    }
    placeCamera();
    // la clé et le contre-jour suivent l'azimut : le sujet reste modelé quel que soit le point de vue
    key.target.position.copy(orbit.target);
    const ka = orbit.az + 0.75;
    key.position.set(orbit.target.x + Math.cos(ka) * 2.0, orbit.target.y + Math.sin(ka) * 2.0, 2.4);
    const ra = orbit.az - 2.2;
    rim.position.set(orbit.target.x + Math.cos(ra) * 2.4, orbit.target.y + Math.sin(ra) * 2.4, 0.9);
    rim.target.position.copy(orbit.target); rim.target.updateMatrixWorld();

    // curseurs de phase + étiquettes + télémétrie (30 Hz)
    acc += dt;
    if (acc > 0.033) {
      acc = 0;
      LEGS.forEach(function (L) {
        if (bars[L.id]) bars[L.id].style.left = (state.phase * 100) + "%";
      });
      updateJointTable();
      updateTags();
      const G = GAITS[state.gait];
      readout.innerHTML =
        "Allure <b>" + G.label + "</b> · cycle <b>" + (G.stance / G.duty).toFixed(2) + " s</b><br>" +
        "Appui <b>" + Math.round(G.duty * 100) + " %</b> · phase <b>" + state.phase.toFixed(2) + "</b><br>" +
        "Odométrie <b>" + Math.hypot(state.px, state.py).toFixed(2) + " m</b> · cap <b>" +
        (((state.yaw * 180 / Math.PI) % 360).toFixed(0)) + "°</b><br>" +
        "Appuis au sol <b>" + LEGS.filter(function (L) { return legNodes[L.id].contact; }).length + " / 4</b>";
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  const _p = new T.Vector3();
  const anchors = {};                       // pièce représentative de chaque sous-système
  SYS.forEach(function (s) {
    const id = s.focus || s.id;
    anchors[s.id] = exploders.find(function (o) { return o.userData.sys === id; }) || null;
  });
  function updateTags() {
    const r = canvas.getBoundingClientRect();
    const taken = [];                        // anti-chevauchement vertical
    SYS.forEach(function (s) {
      const el = tagEls[s.id];
      const sel = state.selected === s.id;
      // en éclaté on n'étiquette que le matériel ; le logiciel reste sur sélection
      const show = sel || (state.explodeOn && s.group !== "Logiciel");
      if (!show) { el.classList.remove("on", "sel"); return; }
      const a = anchors[s.id];
      if (a) a.getWorldPosition(_p); else _p.set(s.at[0], s.at[1], s.at[2]).applyMatrix4(body.matrixWorld);
      _p.project(camera);
      if (_p.z > 1) { el.classList.remove("on"); return; }
      let x = (_p.x * 0.5 + 0.5) * r.width;
      let y = (-_p.y * 0.5 + 0.5) * r.height;
      for (let i = 0; i < taken.length; i++) {
        if (Math.abs(taken[i][0] - x) < 150 && Math.abs(taken[i][1] - y) < 19) { y = taken[i][1] + 20; i = -1; }
      }
      taken.push([x, y]);
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.classList.add("on");
      el.classList.toggle("sel", sel);
    });
  }

  // poignée de débogage (inspection depuis la console)
  window.__ylo = { state: state, orbit: orbit, camera: camera, robot: robot, legs: legNodes, K: K };

  resize(); setView("iso"); placeCamera(); select(null);
  requestAnimationFrame(tick);
})();
